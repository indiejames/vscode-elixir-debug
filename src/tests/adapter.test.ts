/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

"use strict";

import assert = require('assert');
import * as Path from 'path';
import {DebugClient} from './DebugClient';
import {DebugProtocol} from 'vscode-debugprotocol';

suite('Node Debug Adapter', () => {

	const DEBUG_ADAPTER = './out/elixirDebug.js';

	const PROJECT_ROOT = Path.join(__dirname, '../../');
	const PROGRAM = Path.join(PROJECT_ROOT, 'src/tests/data/test.md');

	let dc: DebugClient;


	setup(done => {
		dc = new DebugClient('node', DEBUG_ADAPTER, 'node');
		dc.start(done);
	});

	teardown(done => {
		dc.stop(done);
	});


	suite('basic', () => {

		test('unknown request should produce error', done => {
			dc.send('illegal_request').then(() => {
				done(new Error("does not report error on unknown request"));
			}).catch(() => {
				done();
			});
		});
	});

	suite('initialize', () => {

		test('should return supported features', () => {
			return dc.initializeRequest().then(response => {
				assert.equal(response.body.supportsConfigurationDoneRequest, true);
			});
		});

		test('should produce error for invalid \'pathFormat\'', done => {
			dc.initializeRequest({
				adapterID: 'mock',
				linesStartAt1: true,
				columnsStartAt1: true,
				pathFormat: 'url'
			}).then(response => {
				done(new Error("does not report error on invalid 'pathFormat' attribute"));
			}).catch(err => {
				// error expected
				done();
			});
		});
	});

	suite('launch', () => {

		test('should run program to the end', () => {

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM }),
				dc.waitForEvent('terminated')
			]);
		});

		test('should stop on entry', () => {

			const ENTRY_LINE = 1;

			return Promise.all([
				dc.configurationSequence(),
				dc.launch({ program: PROGRAM, stopOnEntry: true }),
				dc.assertStoppedLocation('entry', ENTRY_LINE)
			]);
		});
	});

	suite('setBreakpoints', () => {

		test('should stop on a breakpoint', () => {

			const BREAKPOINT_LINE = 2;

			return dc.hitBreakpoint({ program: PROGRAM, }, PROGRAM, BREAKPOINT_LINE);
		});
	});

	suite('setExceptionBreakpoints', () => {

		test('should stop on an exception', () => {

			const PROGRAM_WITH_EXCEPTION = Path.join(PROJECT_ROOT, 'src/tests/data/testWithException.md');
			const EXCEPTION_LINE = 4;

			return Promise.all([

				dc.waitForEvent('initialized').then(event => {
					return dc.setExceptionBreakpointsRequest({
						filters: [ 'all' ]
					});
				}).then(response => {
					return dc.configurationDoneRequest();
				}),

				dc.launch({ program: PROGRAM_WITH_EXCEPTION }),

				dc.assertStoppedLocation('exception', EXCEPTION_LINE)
			]);
		});
	});
});