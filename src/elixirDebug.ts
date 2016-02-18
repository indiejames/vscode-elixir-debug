/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {DebugSession, Variable, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import ManifestParser from './manifestParser';
import {readFileSync} from 'fs';
import {basename, dirname, sep} from 'path';
import {spawn} from 'child_process';
import DebugEx from './debugEx';

// The debug module to run in the REPL
var debugStrArray = (readFileSync(__dirname + sep + "elixir_debug.ex") + "").split(/\n/);
var debugStrIndex = 0;

// Regex to detect end of output from REPL.
var replPromptRegex = /\(\d*\)>\s*$/;
var replPromptIncRegex = /^\.\.\.\(\d*\)>\s/;

/**
 * This interface should always match the schema found in the elixir-debug extension manifest.
 */
export interface LaunchRequestArguments {
	/** An absolute path to the mix file of the program to debug. */
	mixFile: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
}

// Constants to represent the various states of the debugger
class DebuggerState {
	public static get PRE_LAUNCH(): string { return "PRE_LAUNCH";}
	public static get REPL_STARTED(): string {return "REPL_STARTED";}
	public static get REPL_READY(): string {return "REPL_READY";}
	public static get LAUNCH_COMPLETE(): string {return "LAUNCH_COMPLETE";}
}

class ElixirDebugSession extends DebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// Debugger state
	private _debuggerState: DebuggerState;

	// Elixir REPL process
	private __child: any;
	private __iexReadyFlag = false;
	private __bufferClearedFlag = false;
	// Queue for request handler lambdas - these are called with output received from the REPL process.
	private _requestHandlerQueue: { (data: string): void; }[];
	// Buffer for output from REPL
	private _replBuffer: string[];
	// Buffer for things to be evaluated in the REPL
	private _evalBuffer: string[][];
	private _evalIndex: number;

	private __currentLine: number;
	private get _currentLine() : number {
        return this.__currentLine;
    }
	private set _currentLine(line: number) {
        this.__currentLine = line;
		this.sendEvent(new OutputEvent(`line: ${line}\n`));	// print current line on debug console
    }

	private _sourceFile: string;
	private _sourceLines: string[];
	private _breakPoints: any;
	private _variableHandles: Handles<string>;

	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);
		this._debuggerState = DebuggerState.PRE_LAUNCH;
		this._sourceFile = null;
		this._sourceLines = [];
		this._currentLine = 0;
		this._breakPoints = {};
		this._evalBuffer = [];
		this._evalIndex = 0;
		this._replBuffer = [];
		this._variableHandles = new Handles<string>();
		this._requestHandlerQueue = [];
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		this.sendResponse(response);

		// now we are ready to accept breakpoints -> fire the initialized event to give UI a chance to set breakpoints
		this.sendEvent(new InitializedEvent());
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		this.__child.kill('SIGKILL');
		super.disconnectRequest(response, args);
	}

	///////////////////////////////////////////////////////////////////////////////////////
	//
	//    REPL response handler
	//
	//    Handles data coming from the REPL and sets the current state of the debugger
	//
	///////////////////////////////////////////////////////////////////////////////////////

	protected replResponseHandler(data: string): void {

		// read until we reach the end which should have a prompt
		if(replPromptRegex.test(data) || replPromptIncRegex.test(data)) {
			this._replBuffer.push(data);
			var output = this._replBuffer.join("\n");
			this._replBuffer = [];

			switch (this._debuggerState) {
				case DebuggerState.REPL_STARTED:
					// REPL is responding with it's init message - send it the elixir debugger code
					if (debugStrIndex < debugStrArray.length) {
						var debug = debugStrArray[debugStrIndex];
						this.__child.stdin.write(debug + "\n");

					}

					debugStrIndex++;

					if (debugStrIndex >= debugStrArray.length) {
						this._debuggerState = DebuggerState.REPL_READY
					}

					break;

				case DebuggerState.REPL_READY:
					// REPL has responded to the debugger code - let VS Code know we're ready to receive requests
					var handler = this._requestHandlerQueue.shift();
					if (handler) {
						handler(output);
					}
					this._debuggerState = DebuggerState.LAUNCH_COMPLETE
					break;

				default:
					// REPL has responded - if there is anymore code to evaluate, send it to the REPL,
					// otherwise let request handler handle the response

					// TODO - add formatting of output here
					if (this._evalBuffer.length > 0){
						var codeArray = this._evalBuffer[0];
						if (this._evalIndex < codeArray.length){
							// send the line of code to the REPL
							this.__child.stdin.write(codeArray[this._evalIndex] + "\n");
							this._evalIndex++;
						} else {
							// remove the code array from the eval queue and reset the index
							this._evalBuffer.shift();
							this._evalIndex = 0;

							var handler = this._requestHandlerQueue.shift();
							if (handler) {
								handler(output);
							}
						}
					}

					break;
			}

		} else {
			// append this to the buffer
			this._replBuffer.push(data);
		}

	}

	// End REPL Response Handler /////////////////////////////////////////////////////////////

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
		// Start a REPL using the mix file for the given project
		console.log("ELIXIR!!!");
		var cwd = args["cwd"];
		var mixFile = args.mixFile || args["cwd"] + "/mix.exs";
		//var mixfile = args.mixFile || args.cwd + "/mix.exs";
		this._sourceFile = mixFile;

		this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');

		this.__child = spawn('/bin/bash', ["-c", "iex -S mix"], {cwd: cwd});

  		this.__child.stdout.on('data', (data) => {
    		var output = '' + data;

			this.replResponseHandler(output);

    		console.log(output);

		});

  		this.__child.stderr.on('data', (data) => {
  			console.log(`stderr: ${data}`);
		});

		this.__child.on('close', (code) => {
			if (code !== 0) {
				console.log(`iex process exited with code ${code}`);
			}
			console.log("iex closed");
		});

		//this.__child.stdin.write(DebugEx.elixirDebugModule() + "\n");

		var manifests = ManifestParser.parseManifests(cwd + sep + "_build" + sep + "dev");

		// Use the manifests to initialize the debugging
		// for (var manifest of manifests) {
		// 	var beamFile = manifest[0];
		// 	var module = manifest[1];
		// 	var srcFile = cwd + sep + manifest[2];
		// 	var readCmd = "{:ok, beam_bin} = File.read('" + beamFile + "')\n";
		// 	this.__child.stdin.write(readCmd);
		// 	var intCmd = ":int.i({" + module + ",'" + srcFile + "','" + beamFile + "',beam_bin})\n";
		// 	this.__child.stdin.write(intCmd);

		// }

		this._debuggerState = DebuggerState.REPL_STARTED;

		// This function will be called when the REPL has repsonded after it starts up.
		// We don't use the first argument in this case - most handlers would.
		var handler = (_data: string) => {
			if (args.stopOnEntry) {
				this._currentLine = 0;
				this.sendResponse(response);

				// we stop on the first line
				this.sendEvent(new StoppedEvent("entry", ElixirDebugSession.THREAD_ID));
			} else {
				// we just start to run until we hit a breakpoint or an exception
				this.continueRequest(response, { threadId: ElixirDebugSession.THREAD_ID });
			}
		}

		this._requestHandlerQueue.push(handler);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		var path = args.source.path;
		var clientLines = args.lines;

		// read file contents into array for direct access
		var lines = readFileSync(path).toString().split('\n');

		var newPositions = [clientLines.length];
		var breakpoints = [];

		// verify breakpoint locations
		for (var i = 0; i < clientLines.length; i++) {
			var l = this.convertClientLineToDebugger(clientLines[i]);
			var verified = false;
			if (l < lines.length) {
				// if a line starts with '+' we don't allow to set a breakpoint but move the breakpoint down
				if (lines[l].indexOf("+") == 0)
					l++;
				// if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
				if (lines[l].indexOf("-") == 0)
					l--;
				verified = true;    // this breakpoint has been validated
			}
			newPositions[i] = l;
			breakpoints.push({ verified: verified, line: this.convertDebuggerLineToClient(l)});
		}
		this._breakPoints[path] = newPositions;

		// send back the actual breakpoints
		response.body = {
			breakpoints: breakpoints
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// return the default thread
		response.body = {
			threads: [
				new Thread(ElixirDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		const frames = new Array<StackFrame>();
		const words = this._sourceLines[this._currentLine].trim().split(/\s+/);
		// create three fake stack frames.
		for (let i= 0; i < 3; i++) {
			// use a word of the line as the stackframe name
			const name = words.length > i ? words[i] : "frame";
			frames.push(new StackFrame(i, `${name}(${i})`, new Source(basename(this._sourceFile), this.convertDebuggerPathToClient(this._sourceFile)), this.convertDebuggerLineToClient(this._currentLine), 0));
		}
		response.body = {
			stackFrames: frames
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Local", this._variableHandles.create("local_" + frameReference), false));
		scopes.push(new Scope("Closure", this._variableHandles.create("closure_" + frameReference), false));
		scopes.push(new Scope("Global", this._variableHandles.create("global_" + frameReference), true));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

		const variables = [];
		// const id = this._variableHandles.get(args.variablesReference);
		// if (id != null) {
		// 	variables.push({
		// 		name: id + "_i",
		// 		value: "123",
		// 		variablesReference: 0
		// 	});
		// 	variables.push({
		// 		name: id + "_f",
		// 		value: "3.14",
		// 		variablesReference: 0
		// 	});
		// 	variables.push({
		// 		name: id + "_s",
		// 		value: "hello world",
		// 		variablesReference: 0
		// 	});
		// 	variables.push({
		// 		name: id + "_o",
		// 		value: "Object",
		// 		variablesReference: this._variableHandles.create("object_")
		// 	});
		// }

		variables.push({name: "0",
						value: "123",
						variablesReference: 0},
						{name: "1",
						value: "456",
						variablesReference: 0},
						{name: "2",
						value: "789",
						variablesReference: 0},
						{name: "3",
						value: "ABC",
						variablesReference: 0});

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {

		const lines = this._breakPoints[this._sourceFile];
		for (let ln = this._currentLine+1; ln < this._sourceLines.length; ln++) {
			// is breakpoint on this line?
			if (lines && lines.indexOf(ln) >= 0) {
				this._currentLine = ln;
				this.sendResponse(response);
				this.sendEvent(new StoppedEvent("step", ElixirDebugSession.THREAD_ID));
				return;
			}
			// if word 'exception' found in source -> throw exception
			if (this._sourceLines[ln].indexOf("exception") >= 0) {
				this._currentLine = ln;
				this.sendResponse(response);
				this.sendEvent(new StoppedEvent("exception", ElixirDebugSession.THREAD_ID));
				this.sendEvent(new OutputEvent(`exception in line: ${ln}\nABC`, 'stderr'));
				return;
			}
		}
		this.sendResponse(response);
		// no more lines: run to end
		this.sendEvent(new TerminatedEvent());
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {

		for (let ln = this._currentLine+1; ln < this._sourceLines.length; ln++) {
			if (this._sourceLines[ln].trim().length > 0) {   // find next non-empty line
				this._currentLine = ln;
				this.sendResponse(response);
				this.sendEvent(new StoppedEvent("step", ElixirDebugSession.THREAD_ID));
				return;
			}
		}
		this.sendResponse(response);
		// no more lines: run to end
		this.sendEvent(new TerminatedEvent());
	}


	//////////////////////////////////////////////////////////////////////////////////////
	//
	// Queue up code to be evaluated in the REPL
	//
	/////////////////////////////////////////////////////////////////////////////////////

	protected evaluateElixirCode(code: string): void {

		var codeArray = code.split("\n");

		this._evalBuffer.push(codeArray);

		// trick the response handler into processing this
		// FIXME - make this better
		this.replResponseHandler("iex(5)>");
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		// TEST CODE this.evaluateElixirCode("defmodule Foo do\ndef foo do\n\"foo\"\nend\nend");

		this.evaluateElixirCode(args.expression);

		response.body = {

			result: null,
			variablesReference: 0
		};

		var handler = (data: string) => {
			// TODO add support for formatting output
			response.body.result = data;

			this.sendResponse(response);
		}

		this._requestHandlerQueue.push(handler);

	}
}

DebugSession.run(ElixirDebugSession);
