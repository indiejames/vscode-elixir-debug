/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {DebugSession, InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent, Thread, StackFrame, Scope, Source, Handles} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import {readFileSync} from 'fs';
import {basename} from 'path';
import {spawn} from 'child_process';


/**
 * This interface should always match the schema found in the elixir-debug extension manifest.
 */
export interface LaunchRequestArguments {
	/** An absolute path to the mix file of the program to debug. */
	mixFile: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
}

class ElixirDebugSession extends DebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// Elixir REPL process
	private __child: any;
	private __iexReadyFlag = false;
	private __bufferClearedFlag = false;
	// Buffer for output from evaluating things in the REPL
	private __evalBuffer: string[];

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
		this._sourceFile = null;
		this._sourceLines = [];
		this._currentLine = 0;
		this._breakPoints = {};
		this._variableHandles = new Handles<string>();
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

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
		// Start a REPL using the mix file for the given project
		console.log("ELIXIR!!!")

		this._sourceFile = args.mixFile;
		this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');

		this.__child = spawn('/bin/bash', ["-c", "iex"]);


  		// this.__child.stdout.on('data', (data) => {
    	// 	var output = '' + data;
		// 	if (this.__iexReadyFlag) {
		// 		this.__evalBuffer.push(data);
		// 	} else {
		// 		this.__iexReadyFlag = true;
		// 	}

    	// 	console.log(output);

    		//output_channel.append('' + data);


    		// if (output.match(/iex.*>/g)) {
			// 	output_channel.append("READY\n");
			// 	if (!did_write){
			// 		did_write = true;
			// 		this.__child.stdin.write("x = 4\n\n");
			// 	}

    		// }

		// });

  		this.__child.stderr.on('data', (data) => {
  			console.log(`stderr: ${data}`);
		});

		this.__child.on('close', (code) => {
			if (code !== 0) {
				console.log(`iex process exited with code ${code}`);
			}
			console.log("iex closed");
		});

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
		const id = this._variableHandles.get(args.variablesReference);
		if (id != null) {
			variables.push({
				name: id + "_i",
				value: "123",
				variablesReference: 0
			});
			variables.push({
				name: id + "_f",
				value: "3.14",
				variablesReference: 0
			});
			variables.push({
				name: id + "_s",
				value: "hello world",
				variablesReference: 0
			});
			variables.push({
				name: id + "_o",
				value: "Object",
				variablesReference: this._variableHandles.create("object_")
			});
		}

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

	protected readFromChildProcess(): string {
		var buf: string = '';
		var output = null;

		// Drain the stdout of the child process the first time to get rid of the startup message
		if (!this.__bufferClearedFlag){

			for (output = ''; output = '' + this.__child.stdout.read(); buf.search(/iex\(\d*\)/) == -1) {
				buf = buf + output;
			}

			buf = '';

			this.__bufferClearedFlag = true;
		}

		for (output = ''; output = '' + this.__child.stdout.read(); buf.search(/iex\(\d*\)/) == -1) {
			buf = buf + output;
		}

		var rval: string = buf.replace(/iex\(\d*\)>/, '');

		return rval;
	}

	protected evaluateElixirCode(code: string): string {
		this.__child.stdin.write(code + "\n");

		var rval: string = this.readFromChildProcess();

		return rval;
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {


		var evalue: string = this.evaluateElixirCode(args.expression);

		response.body = {

			result: evalue,
			variablesReference: 0
		};
		this.sendResponse(response);
	}
}

DebugSession.run(ElixirDebugSession);
