// GENERATED, DO NOT EDIT
// file: hidden-constructors.js
// Copyright (C) 2020 Rick Waldron. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
description: |
  Provides uniform access to built-in constructors that are not exposed to the global object.
defines:
  - AsyncFunction
  - AsyncGeneratorFunction
  - GeneratorFunction
---*/

var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
var AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;
var GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
