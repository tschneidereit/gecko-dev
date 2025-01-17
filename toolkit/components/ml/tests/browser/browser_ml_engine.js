/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

/// <reference path="head.js" />

requestLongerTimeout(2);

async function setup({ disabled = false, prefs = [] } = {}) {
  const { removeMocks, remoteClients } = await createAndMockMLRemoteSettings({
    autoDownloadFromRemoteSettings: false,
  });

  await SpecialPowers.pushPrefEnv({
    set: [
      // Enabled by default.
      ["browser.ml.enable", !disabled],
      ["browser.ml.logLevel", "All"],
      ["browser.ml.modelCacheTimeout", 1000],
      ...prefs,
    ],
  });

  return {
    remoteClients,
    async cleanup() {
      await removeMocks();
      await waitForCondition(
        () => EngineProcess.areAllEnginesTerminated(),
        "Waiting for all of the engines to be terminated.",
        100,
        200
      );
    },
  };
}

const RAW_PIPELINE_OPTIONS = { taskName: "moz-echo" };
const PIPELINE_OPTIONS = new PipelineOptions({ taskName: "moz-echo" });

async function checkForRemoteType(remoteType) {
  let procinfo3 = await ChromeUtils.requestProcInfo();
  for (const child of procinfo3.children) {
    if (child.type === remoteType) {
      return true;
    }
  }
  return false;
}

add_task(async function test_ml_engine_basics() {
  const { cleanup, remoteClients } = await setup();

  info("Get the engine");
  const engineInstance = await createEngine(RAW_PIPELINE_OPTIONS);

  info("Check the inference process is running");
  Assert.equal(await checkForRemoteType("inference"), true);

  info("Run the inference");
  const inferencePromise = engineInstance.run({ data: "This gets echoed." });

  info("Wait for the pending downloads.");
  await remoteClients["ml-onnx-runtime"].resolvePendingDownloads(1);

  Assert.equal(
    (await inferencePromise).output,
    "This gets echoed.",
    "The text get echoed exercising the whole flow."
  );

  ok(
    !EngineProcess.areAllEnginesTerminated(),
    "The engine process is still active."
  );

  await EngineProcess.destroyMLEngine();

  await cleanup();
});

add_task(async function test_ml_engine_wasm_rejection() {
  const { cleanup, remoteClients } = await setup();

  info("Get the engine");
  const engineInstance = await createEngine(RAW_PIPELINE_OPTIONS);

  info("Run the inference");
  const inferencePromise = engineInstance.run({ data: "This gets echoed." });

  info("Wait for the pending downloads.");
  await remoteClients["ml-onnx-runtime"].rejectPendingDownloads(1);
  //await remoteClients.models.resolvePendingDownloads(1);

  let error;
  try {
    await inferencePromise;
  } catch (e) {
    error = e;
  }
  is(
    error?.message,
    "Intentionally rejecting downloads.",
    "The error is correctly surfaced."
  );

  await cleanup();
});

/**
 * Tests that the engineInstanceModel's internal errors are correctly surfaced.
 */
add_task(async function test_ml_engine_model_error() {
  const { cleanup, remoteClients } = await setup();

  info("Get the engine");
  const engineInstance = await createEngine(RAW_PIPELINE_OPTIONS);

  info("Run the inference with a throwing example.");
  const inferencePromise = engineInstance.run("throw");

  info("Wait for the pending downloads.");
  await remoteClients["ml-onnx-runtime"].resolvePendingDownloads(1);
  //await remoteClients.models.resolvePendingDownloads(1);

  let error;
  try {
    await inferencePromise;
  } catch (e) {
    error = e;
  }
  is(
    error?.message,
    'Error: Received the message "throw", so intentionally throwing an error.',
    "The error is correctly surfaced."
  );

  // verify that terminating the engine eventually calls discardPort
  let spy = sinon.spy(engineInstance, "discardPort");

  engineInstance.terminate();

  await cleanup();

  is(spy.calledOnce, true, "The discardPort method was called once.");
});

/**
 * This test is really similar to the "basic" test, but tests manually destroying
 * the engineInstance.
 */
add_task(async function test_ml_engine_destruction() {
  const { cleanup, remoteClients } = await setup();

  info("Get the engine process");
  const mlEngineParent = await EngineProcess.getMLEngineParent();

  info("Get engineInstance");
  const engineInstance = mlEngineParent.getEngine(PIPELINE_OPTIONS);

  info("Run the inference");
  const inferencePromise = engineInstance.run({ data: "This gets echoed." });

  info("Wait for the pending downloads.");
  await remoteClients["ml-onnx-runtime"].resolvePendingDownloads(1);

  Assert.equal(
    (await inferencePromise).output,
    "This gets echoed.",
    "The text get echoed exercising the whole flow."
  );

  ok(
    !EngineProcess.areAllEnginesTerminated(),
    "The engine process is still active."
  );

  // verify that terminating the engine eventually calls discardPort
  let spy = sinon.spy(engineInstance, "discardPort");

  engineInstance.terminate();

  info(
    "The engineInstance is manually destroyed. The cleanup function should wait for the engine process to be destroyed."
  );

  await cleanup();
  is(spy.calledOnce, true, "The discardPort method was called once.");
});

/**
 * Tests that we display a nice error message when the pref is off
 */
add_task(async function test_pref_is_off() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ml.enable", false]],
  });

  info("Get the engine process");
  let error;

  try {
    await EngineProcess.getMLEngineParent();
  } catch (e) {
    error = e;
  }
  is(
    error?.message,
    "MLEngine is disabled. Check the browser.ml prefs.",
    "The error is correctly surfaced."
  );

  await SpecialPowers.pushPrefEnv({
    set: [["browser.ml.enable", true]],
  });
});

/**
 * Tests that we verify the task name is valid
 */
add_task(async function test_invalid_task_name() {
  const { cleanup, remoteClients } = await setup();

  const options = new PipelineOptions({ taskName: "inv#alid" });
  const mlEngineParent = await EngineProcess.getMLEngineParent();
  const engineInstance = mlEngineParent.getEngine(options);

  let error;

  try {
    const res = engineInstance.run({ data: "This gets echoed." });
    await remoteClients["ml-onnx-runtime"].resolvePendingDownloads(1);
    await res;
  } catch (e) {
    error = e;
  }
  is(
    error?.message,
    "Invalid task name. Task name should contain only alphanumeric characters and underscores/dashes.",
    "The error is correctly surfaced."
  );
  await cleanup();
});

add_task(async function test_ml_generic_pipeline() {
  const { cleanup, remoteClients } = await setup();

  info("Get the engine process");
  const mlEngineParent = await EngineProcess.getMLEngineParent();

  info("Get engineInstance");

  const options = new PipelineOptions({
    taskName: "summarization",
    modelId: "test-echo",
    modelRevision: "main",
  });

  const engineInstance = mlEngineParent.getEngine(options);

  info("Run the inference");
  const inferencePromise = engineInstance.run({
    args: ["This gets echoed."],
  });

  info("Wait for the pending downloads.");
  await remoteClients["ml-onnx-runtime"].resolvePendingDownloads(1);

  Assert.equal(
    (await inferencePromise).output,
    "This gets echoed.",
    "The text get echoed exercising the whole flow."
  );

  ok(
    !EngineProcess.areAllEnginesTerminated(),
    "The engine process is still active."
  );

  await EngineProcess.destroyMLEngine();

  await cleanup();
});
