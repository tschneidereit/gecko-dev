import { MockRegistrar } from "resource://testing-common/MockRegistrar.sys.mjs";
import { NON_SPLIT_ENGINE_IDS } from "resource://gre/modules/SearchService.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonTestUtils: "resource://testing-common/AddonTestUtils.sys.mjs",
  AppProvidedSearchEngine:
    "resource://gre/modules/AppProvidedSearchEngine.sys.mjs",
  ExtensionTestUtils:
    "resource://testing-common/ExtensionXPCShellUtils.sys.mjs",
  RemoteSettings: "resource://services-settings/remote-settings.sys.mjs",
  SearchUtils: "resource://gre/modules/SearchUtils.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

/**
 * A class containing useful testing functions for Search based tests.
 */
class _SearchTestUtils {
  /**
   * The test scope that the test is running in.
   *
   * @type {object}
   */
  #testScope = null;

  /**
   * True if we are in a mochitest scope, false for xpcshell-tests.
   *
   * @type {boolean?}
   */
  #isMochitest = null;

  /**
   * Initialises the test utils, setting up the scope and working out if these
   * are mochitest or xpcshell-test.
   *
   * @param {object} testScope
   *   The global scope for the test.
   */
  init(testScope) {
    this.#testScope = testScope;
    this.#isMochitest = !Services.env.exists("XPCSHELL_TEST_PROFILE_DIR");
    if (this.#isMochitest) {
      lazy.AddonTestUtils.initMochitest(testScope);
    }
  }

  /**
   * Adds an OpenSearch based engine to the search service. It will remove
   * the engine at the end of the test.
   *
   * @param {object} options
   *   The options for the new search engine.
   * @param {string} options.url
   *   The URL of the engine to add.
   * @param {boolean} [options.setAsDefault]
   *   Whether or not to set the engine as default automatically. If this is
   *   true, the engine will be set as default, and the previous default engine
   *   will be restored when the test exits.
   * @param {boolean} [options.setAsDefaultPrivate]
   *   Whether or not to set the engine as default automatically for private mode.
   *   If this is true, the engine will be set as default, and the previous default
   *   engine will be restored when the test exits.
   * @param {boolean} [options.skipReset]
   *   Skips resetting the default engine at the end of the test.
   * @returns {Promise} Returns a promise that is resolved with the new engine
   *                    or rejected if it fails.
   */
  async installOpenSearchEngine({
    url,
    setAsDefault = false,
    setAsDefaultPrivate = false,
    skipReset = false,
  }) {
    // OpenSearch engines can only be added via http protocols.
    url = url.replace("chrome://mochitests/content", "https://example.com");
    let engine = await Services.search.addOpenSearchEngine(url, "");
    let previousEngine = Services.search.defaultEngine;
    let previousPrivateEngine = Services.search.defaultPrivateEngine;
    if (setAsDefault) {
      await Services.search.setDefault(
        engine,
        Ci.nsISearchService.CHANGE_REASON_UNKNOWN
      );
    }
    if (setAsDefaultPrivate) {
      await Services.search.setDefaultPrivate(
        engine,
        Ci.nsISearchService.CHANGE_REASON_UNKNOWN
      );
    }
    this.#testScope.registerCleanupFunction(async () => {
      if (setAsDefault && !skipReset) {
        await Services.search.setDefault(
          previousEngine,
          Ci.nsISearchService.CHANGE_REASON_UNKNOWN
        );
      }
      if (setAsDefaultPrivate && !skipReset) {
        await Services.search.setDefaultPrivate(
          previousPrivateEngine,
          Ci.nsISearchService.CHANGE_REASON_UNKNOWN
        );
      }
      try {
        await Services.search.removeEngine(engine);
      } catch (ex) {
        // Don't throw if the test has already removed it.
      }
    });
    return engine;
  }

  /**
   * Returns a promise that is resolved when an observer notification from the
   * search service fires with the specified data.
   *
   * @param {*} expectedData
   *        The value the observer notification sends that causes us to resolve
   *        the promise.
   * @param {string} topic
   *        The notification topic to observe. Defaults to 'browser-search-service'.
   * @returns {Promise}
   *        Returns a promise that is resolved with the subject of the
   *        topic once the topic with the data has been observed.
   */
  promiseSearchNotification(expectedData, topic = "browser-search-service") {
    return new Promise(resolve => {
      Services.obs.addObserver(function observer(aSubject, aTopic, aData) {
        if (aData != expectedData) {
          return;
        }

        Services.obs.removeObserver(observer, topic);
        // Let the stack unwind.
        Services.tm.dispatchToMainThread(() => resolve(aSubject));
      }, topic);
    });
  }

  /**
   * For xpcshell tests, configures loading engines from test data located in
   * particular folders.
   *
   * @param {string} [folder]
   *   The folder name to use.
   * @param {string} [subFolder]
   *   The subfolder to use, if any.
   * @param {Array} [configData]
   *   An array which contains the configuration to set.
   * @returns {object}
   *   An object that is a sinon stub for the configuration getter.
   */
  async useTestEngines(folder = "data", subFolder = null, configData = null) {
    const settings = await lazy.RemoteSettings(lazy.SearchUtils.SETTINGS_KEY);
    if (configData) {
      return lazy.sinon.stub(settings, "get").returns(configData);
    }

    let workDir = Services.dirsvc.get("CurWorkD", Ci.nsIFile);
    let configFileName =
      "file://" +
      PathUtils.join(
        workDir.path,
        folder,
        subFolder ?? "",
        "search-config-v2.json"
      );

    let response = await fetch(configFileName);
    let json = await response.json();
    return lazy.sinon.stub(settings, "get").returns(json.data);
  }

  /**
   * For mochitests, configures loading engines from test data located in
   * particular folders. This will cleanup at the end of the test.
   *
   * This will be removed when the new search config generation for tests is done.
   *
   * @param {nsIFile} testDir
   *   The test directory to use.
   */
  async useMochitestEngines(testDir) {
    // Replace the path we load search engines from with
    // the path to our test data.
    let resProt = Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    let originalSubstitution = resProt.getSubstitution("search-extensions");
    resProt.setSubstitution(
      "search-extensions",
      Services.io.newURI("file://" + testDir.path)
    );
    this.#testScope.registerCleanupFunction(() => {
      resProt.setSubstitution("search-extensions", originalSubstitution);
    });
  }

  /**
   * Convert a list of engine configurations into engine objects.
   *
   * @param {Array} engineConfigurations
   *   An array of engine configurations.
   */
  async searchConfigToEngines(engineConfigurations) {
    let engines = [];

    for (let e of engineConfigurations) {
      if (!e.webExtension) {
        e.webExtension = {};
      }
      e.webExtension.locale =
        e.webExtension.locale ?? lazy.SearchUtils.DEFAULT_TAG;

      // TODO Bug 1875912 - Remove the webextension.id and webextension.locale when
      // we're ready to remove old search-config and use search-config-v2 for all
      // clients. The id in appProvidedSearchEngine should be changed to
      // engine.identifier.
      let identifierComponents = NON_SPLIT_ENGINE_IDS.includes(e.identifier)
        ? [e.identifier]
        : e.identifier.split("-");

      e.webExtension.locale =
        identifierComponents.slice(1).join("-") || "default";
      e.webExtension.id = identifierComponents[0] + "@search.mozilla.org";
    }

    for (let config of engineConfigurations) {
      let engine = new lazy.AppProvidedSearchEngine({ config });
      engines.push(engine);
    }
    return engines;
  }

  /**
   * Sets up the add-on manager so that it is ready for loading WebExtension
   * in xpcshell-tests.
   */
  async initXPCShellAddonManager() {
    this.#testScope.ExtensionTestUtils = lazy.ExtensionTestUtils;

    if (
      lazy.ExtensionTestUtils.addonManagerStarted ||
      lazy.AddonTestUtils.addonIntegrationService
    ) {
      // We have already started the add-on manager, and the following functions
      // may throw if they are called twice.
      return;
    }

    lazy.ExtensionTestUtils.init(this.#testScope);
    lazy.AddonTestUtils.overrideCertDB();
    lazy.AddonTestUtils.init(this.#testScope, false);

    await lazy.ExtensionTestUtils.startAddonManager();
  }

  /**
   * Add a search engine as a WebExtension.
   *
   * Note: for tests, the extension must generally be unloaded before
   * `registerCleanupFunction`s are triggered. See bug 1694409.
   *
   * This function automatically registers an unload for the extension, this
   * may be skipped with the skipUnload argument.
   *
   * @param {object} [manifest]
   *   See {@link createEngineManifest}
   * @param {object} [options]
   *   Options for how the engine is installed and uninstalled.
   * @param {boolean} [options.setAsDefault]
   *   Whether or not to set the engine as default automatically. If this is
   *   true, the engine will be set as default, and the previous default engine
   *   will be restored when the test exits.
   * @param {boolean} [options.setAsDefaultPrivate]
   *   Whether or not to set the engine as default automatically for private mode.
   *   If this is true, the engine will be set as default, and the previous default
   *   engine will be restored when the test exits.
   * @param {boolean} [options.skipUnload]
   *   If true, this will skip the automatic unloading of the extension.
   * @param {object} [files]
   *   A key value object where the keys are the filenames and their contents are
   *   the values. Used for simulating locales and other files in the WebExtension.
   * @returns {object}
   *   The loaded extension.
   */
  async installSearchExtension(
    manifest = {},
    {
      setAsDefault = false,
      setAsDefaultPrivate = false,
      skipUnload = false,
    } = {},
    files = {}
  ) {
    if (!this.#isMochitest) {
      await this.initXPCShellAddonManager();
    }

    await Services.search.init();

    let extensionInfo = {
      useAddonManager: "permanent",
      files,
      manifest: this.createEngineManifest(manifest),
    };

    let extension;

    let previousEngine = Services.search.defaultEngine;
    let previousPrivateEngine = Services.search.defaultPrivateEngine;

    async function cleanup() {
      if (setAsDefault) {
        await Services.search.setDefault(
          previousEngine,
          Ci.nsISearchService.CHANGE_REASON_UNKNOWN
        );
      }
      if (setAsDefaultPrivate) {
        await Services.search.setDefaultPrivate(
          previousPrivateEngine,
          Ci.nsISearchService.CHANGE_REASON_UNKNOWN
        );
      }
      await extension.unload();
    }

    // Cleanup must be registered before loading the extension to avoid
    // failures for mochitests.
    if (!skipUnload && this.#isMochitest) {
      this.#testScope.registerCleanupFunction(cleanup);
    }

    extension = this.#testScope.ExtensionTestUtils.loadExtension(extensionInfo);
    await extension.startup();
    await lazy.AddonTestUtils.waitForSearchProviderStartup(extension);
    let engine = Services.search.getEngineByName(manifest.name);

    if (setAsDefault) {
      await Services.search.setDefault(
        engine,
        Ci.nsISearchService.CHANGE_REASON_UNKNOWN
      );
    }
    if (setAsDefaultPrivate) {
      await Services.search.setDefaultPrivate(
        engine,
        Ci.nsISearchService.CHANGE_REASON_UNKNOWN
      );
    }

    // For xpcshell-tests we must register the unload after adding the extension.
    // See bug 1694409 for why this is.
    if (!skipUnload && !this.#isMochitest) {
      this.#testScope.registerCleanupFunction(cleanup);
    }

    return extension;
  }

  /**
   * Create a search engine extension manifest.
   *
   * @param {object} [options]
   *   The options for the manifest.
   * @param {object} [options.icons]
   *   The icons to use for the WebExtension.
   * @param {string} [options.id]
   *   The id to use for the WebExtension.
   * @param {string} [options.name]
   *   The display name to use for the WebExtension.
   * @param {string} [options.version]
   *   The version to use for the WebExtension.
   * @param {boolean} [options.is_default]
   *   Whether or not to ask for the search engine in the WebExtension to be
   *   attempted to set as default.
   * @param {string} [options.favicon_url]
   *   The favicon to use for the search engine in the WebExtension.
   * @param {string} [options.keyword]
   *   The keyword to use for the search engine.
   * @param {string} [options.encoding]
   *   The encoding to use for the search engine.
   * @param {string} [options.search_url]
   *   The search URL to use for the search engine.
   * @param {string} [options.search_url_get_params]
   *   The GET search URL parameters to use for the search engine
   * @param {string} [options.search_url_post_params]
   *   The POST search URL parameters to use for the search engine
   * @param {string} [options.suggest_url]
   *   The suggestion URL to use for the search engine.
   * @param {string} [options.suggest_url_get_params]
   *   The suggestion URL parameters to use for the search engine.
   * @returns {object}
   *   The generated manifest.
   */
  createEngineManifest(options = {}) {
    options.name = options.name ?? "Example";
    options.id = options.id ?? options.name.toLowerCase().replaceAll(" ", "");
    if (!options.id.includes("@")) {
      options.id += "@tests.mozilla.org";
    }
    options.version = options.version ?? "1.0";
    let manifest = {
      version: options.version,
      browser_specific_settings: {
        gecko: {
          id: options.id,
        },
      },
      chrome_settings_overrides: {
        search_provider: {
          name: options.name,
          is_default: !!options.is_default,
          search_url: options.search_url ?? "https://example.com/",
        },
      },
    };

    if (options.icons) {
      manifest.icons = options.icons;
    }

    if (options.default_locale) {
      manifest.default_locale = options.default_locale;
    }

    if (options.search_url_post_params) {
      manifest.chrome_settings_overrides.search_provider.search_url_post_params =
        options.search_url_post_params;
    } else {
      manifest.chrome_settings_overrides.search_provider.search_url_get_params =
        options.search_url_get_params ?? "?q={searchTerms}";
    }

    if (options.favicon_url) {
      manifest.chrome_settings_overrides.search_provider.favicon_url =
        options.favicon_url;
    }
    if (options.encoding) {
      manifest.chrome_settings_overrides.search_provider.encoding =
        options.encoding;
    }
    if (options.keyword) {
      manifest.chrome_settings_overrides.search_provider.keyword =
        options.keyword;
    }
    if (options.suggest_url) {
      manifest.chrome_settings_overrides.search_provider.suggest_url =
        options.suggest_url;
    }
    if (options.suggest_url) {
      manifest.chrome_settings_overrides.search_provider.suggest_url_get_params =
        options.suggest_url_get_params;
    }
    if (options.favicon_url) {
      manifest.chrome_settings_overrides.search_provider.favicon_url =
        options.favicon_url;
    }
    return manifest;
  }

  /**
   * A mock idleService that allows us to simulate RemoteSettings
   * configuration updates.
   */
  idleService = {
    _observers: new Set(),

    _reset() {
      this._observers.clear();
    },

    _fireObservers(state) {
      for (let observer of this._observers.values()) {
        observer.observe(observer, state, null);
      }
    },

    QueryInterface: ChromeUtils.generateQI(["nsIUserIdleService"]),
    idleTime: 19999,

    addIdleObserver(observer) {
      this._observers.add(observer);
    },

    removeIdleObserver(observer) {
      this._observers.delete(observer);
    },
  };

  /**
   * Register the mock idleSerice.
   */
  useMockIdleService() {
    let fakeIdleService = MockRegistrar.register(
      "@mozilla.org/widget/useridleservice;1",
      this.idleService
    );
    this.#testScope.registerCleanupFunction(() => {
      MockRegistrar.unregister(fakeIdleService);
    });
  }

  /**
   * Simulates an update to the RemoteSettings configuration.
   * If parameters are not specified, then the appropriate configuration is
   * reset to the data stored in remote settings.
   *
   * @param {object[]} [config]
   *   The replacement configuration.
   * @param {object[]} [overridesConfig]
   *   The replacement overrides configuration.
   */
  async updateRemoteSettingsConfig(config, overridesConfig) {
    if (!config) {
      let settings = lazy.RemoteSettings(lazy.SearchUtils.SETTINGS_KEY);
      config = await settings.get();
    }
    if (!overridesConfig) {
      let settings = lazy.RemoteSettings(
        lazy.SearchUtils.SETTINGS_OVERRIDES_KEY
      );
      overridesConfig = await settings.get();
    }
    const reloadObserved = this.promiseSearchNotification("engines-reloaded");
    await lazy.RemoteSettings(lazy.SearchUtils.SETTINGS_KEY).emit("sync", {
      data: { current: config },
    });
    await lazy
      .RemoteSettings(lazy.SearchUtils.SETTINGS_OVERRIDES_KEY)
      .emit("sync", {
        data: { current: overridesConfig },
      });

    this.idleService._fireObservers("idle");
    await reloadObserved;
  }
}

export const SearchTestUtils = new _SearchTestUtils();
