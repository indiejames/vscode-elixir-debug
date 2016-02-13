# Asynchronous Communication

## Events

* Launch Request
* Set Breakpoints Request
* Threads Request (List Threads)
* Stack Trace Request
* Scopes Request
* Variables Request
* Continue Request
* Next Request
* Evaluate Request

## States

* Pre-launch
 * Dubugger Adapter created and awaiting Launch Request
* REPL Started
 * REPL has been started but no response from it yet
* REPL Ready for Input
 * REPL has responded with Interactive Elixir (1.2.0) ...
* Launch Complete
 * REPL has responded to Debug module elixir code execution; ready to recieve requests

## Architecture

* Event queue
* Utility functions for handling REPL output
  * Data structure mapping to VS Code compound variables

## Timelines

### Receive request
* Push request handler closure on queue

### Output from REPL
* Pull request handler from queue
* Call handler with response from REPL

### Launch Request
Need to initialize REPL
* Start REPL
* In REPL output handler
  *

## Assumptions

* REPL process can receive input (buffered) before it has responded from previous input




