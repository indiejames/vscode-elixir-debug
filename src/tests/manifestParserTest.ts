/// <reference path="../typings/mocha/mocha.d.ts" />

"use strict";

import ManifestParser from '../manifestParser';
import assert = require('assert');
import * as Path from 'path';

describe('ManifestParrser', function() {
  describe('#parseManiftest(file)', function () {
    it('should return a proper manifest for the test file', function () {
      assert.deepEqual([["_build/dev/lib/calculator/ebin/Elixir.Calculator.beam", "Elixir.Calculator", "lib/calculator.ex"]],
	    ManifestParser.parseManifest("src/tests/data/.compile.elixir"));
    });
  });
});