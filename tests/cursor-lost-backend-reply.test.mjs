// The reading of a Cursor reply that is only Cursor's lost-backend diagnostic (cursor-transport-failure.mjs), line by line: each
// diagnostic and its near misses, stack lines, blank lines and trailing white space, the line limit, and text that comes in pieces.
// The lines are shaped as the Cursor Agent CLI (2026.09.26) writes them: its ACP agent ends a failed prompt with the message
// "\n\nError: " and the error as a string, which is its name, ": " and its message; a Connect error's message is "[code] detail";
// the details are Node's own network failures and Connect's deadline.
import test from "node:test";
import assert from "node:assert/strict";
import { CursorLostBackendReply } from "../src/cursor-transport-failure.mjs";

// Cursor's own sentence for a server it could not reach, word for word as its CLI has it.
const CURSOR_SENTENCE="Something went wrong communicating with the server. Please try again.";
// Frames of a Node stack under a failed request, one indented with spaces and one with a tab.
const FRAMES="\n    at TLSSocket.socketErrorListener (node:_http_client:518:9)\n\tat TLSSocket.emit (node:events:518:28)\n";
const LINE_SEPARATOR=String.fromCharCode(0x2028),PARAGRAPH_SEPARATOR=String.fromCharCode(0x2029),NO_BREAK_SPACE=String.fromCharCode(0xa0);
// The verdict of a reply given in these pieces.
const read=(...pieces)=>{const reply=new CursorLostBackendReply();for(const piece of pieces)reply.append(piece);return reply.diagnostic};
// A lost backend as Cursor reports it: a retriable error (any detail but its own agent-loop tag), a Connect error with the code of
// a server out of reach, a call cut off or a deadline passed (with or without a detail), and its sentence.
const LOST_BACKEND=[
  "Error: RetriableError: [unavailable] read ECONNRESET",
  "Error: RetriableError: socket hang up",
  "Error: ConnectError: [unavailable] getaddrinfo ENOTFOUND api2.cursor.sh",
  "Error: ConnectError: [aborted] Stream closed with error code NGHTTP2_INTERNAL_ERROR",
  "Error: ConnectError: [deadline_exceeded] the operation timed out",
  "Error: ConnectError: [deadline_exceeded]",
  CURSOR_SENTENCE,
];
// Replies that only look like one: Cursor's agent-loop failures, its other kinds of error and other Connect codes, its answers
// for a sign-in it needs, and the same words written another way or cut short.
const ANSWERS=[
  "Error: RetriableError: [internal] the model stream ended before its last event",
  "Error: RetriableError: [internal]  ",
  "Error: RetriableError:\t",
  "Error: NonRetriableError: [unavailable] read ECONNRESET",
  "Error: ConnectError: [resource_exhausted] rate limit exceeded for this model",
  "Error: ConnectError: [permission_denied] this model is turned off for your team",
  "Error: ConnectError: [canceled] the request was cancelled",
  "Error: ConnectError: [internal] h2 protocol error",
  "Error: [unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs.",
  "Please sign in to continue",
  "Error: ConnectError: unavailable read ECONNRESET",
  "Error: ConnectError: [UNAVAILABLE] read ECONNRESET",
  "error: ConnectError: [unavailable] read ECONNRESET",
  "ConnectError: [unavailable] read ECONNRESET",
  "\tError: ConnectError: [unavailable] read ECONNRESET",
  CURSOR_SENTENCE.slice(0,CURSOR_SENTENCE.indexOf(" Please")),
  CURSOR_SENTENCE+" Retrying in 5 seconds.",
];

test("each of Cursor's lost-backend lines is a dump, alone or over its stack lines",()=>{
  for(const line of LOST_BACKEND)assert.deepEqual([read(line),read(line+FRAMES)],[line,line],line);
});

test("lines close to those are answers",()=>{
  for(const line of ANSWERS)assert.deepEqual([read(line),read(line+FRAMES)],[undefined,undefined],line);
});

test("the message as Cursor's agent sends it, after two line feeds, is read the same",()=>{
  for(const line of LOST_BACKEND)assert.equal(read("\n\n"+line),line,line);
  assert.equal(read("\n\n","Error: ","RetriableError: socket hang up"),"Error: RetriableError: socket hang up");
});

test("a diagnostic is one line: a carriage return or a line or paragraph separator inside it makes it none",()=>{
  assert.equal(read("Error: ConnectError: [unavailable] read\rECONNRESET"),undefined);
  assert.equal(read("Error: RetriableError: socket"+LINE_SEPARATOR+"hang up"),undefined);
  assert.equal(read("Error: RetriableError: socket"+PARAGRAPH_SEPARATOR+"hang up"),undefined);
});

test("trailing white space, CRLF line ends and blank lines anywhere change nothing",()=>{
  const line="Error: RetriableError: [unavailable] read ECONNRESET",frame="    at TLSSocket.emit (node:events:518:28)";
  assert.equal(read(line+" \t "),line,"the line is given back without its trailing white space");
  assert.equal(read(line+"\r\n"+frame+"\r\n"),line);
  assert.equal(read("\n\t\n"+line+"\n\n \n"+frame+"\n\n"+NO_BREAK_SPACE+NO_BREAK_SPACE+"\n"),line);
  assert.equal(read(),undefined,"no text");
  assert.equal(read(""),undefined);
  assert.equal(read("\n \t\n\n"),undefined,"only blank lines");
});

test("stack lines may only follow a diagnostic, with white space before and after their at",()=>{
  const line="Error: ConnectError: [unavailable] connect ETIMEDOUT 104.18.19.125:443";
  assert.equal(read("    at ClientRequest.emit (node:events:518:28)\n"+line),undefined,"a stack line before any diagnostic is an ordinary line");
  assert.equal(read(line+"\n\tat"),undefined,"an at with nothing after it");
  assert.equal(read(line+"\nat ClientRequest.emit (node:events:518:28)"),undefined,"an at that is not indented");
  assert.equal(read(line+"\n    attempting to reconnect (1 of 3)"),undefined,"a word that starts with at");
  assert.equal(read(line+"\n  at"+NO_BREAK_SPACE+"ClientRequest.emit"),line,"any white space counts");
});

test("a dump with several diagnostic lines reports the latest",()=>{
  const cut="Error: ConnectError: [aborted] Stream closed with error code NGHTTP2_INTERNAL_ERROR",reset="Error: RetriableError: [unavailable] read ECONNRESET";
  assert.equal(read(cut+FRAMES+reset+FRAMES),reset);
  assert.equal(read(CURSOR_SENTENCE+"\nError: ConnectError: [deadline_exceeded] the operation timed out"),"Error: ConnectError: [deadline_exceeded] the operation timed out");
});

test("any other line rules the reply out for good, a later diagnostic included",()=>{
  const line="Error: ConnectError: [unavailable] getaddrinfo ENOTFOUND api2.cursor.sh";
  assert.equal(read("Here is what the CLI printed:\n"+line),undefined);
  assert.equal(read(line+"\nwhich is why the upload stopped.\n"+line+"\n"),undefined);
  const reply=new CursorLostBackendReply();reply.append("Reading the config first.\n");
  for(let i=0;i<3;i++){reply.append(line+"\n");assert.equal(reply.diagnostic,undefined)}
});

test("the unfinished last line counts when the verdict is read, and reading it changes nothing",()=>{
  const reply=new CursorLostBackendReply();
  reply.append("Error: ConnectError: ");
  assert.equal(reply.diagnostic,undefined,"a head alone is no diagnostic");
  reply.append("[deadline_exc");
  assert.equal(reply.diagnostic,undefined,"nor a code cut short");
  reply.append("eeded] the operation");
  assert.equal(reply.diagnostic,"Error: ConnectError: [deadline_exceeded] the operation");
  reply.append(" timed out");
  assert.equal(reply.diagnostic,"Error: ConnectError: [deadline_exceeded] the operation timed out","the line read before stays open for more text");
  reply.append("\n    at Timeout._onTimeout");
  assert.equal(reply.diagnostic,"Error: ConnectError: [deadline_exceeded] the operation timed out");
  reply.append(" (node:internal/timers:594:17)\nso I stopped");
  assert.equal(reply.diagnostic,undefined,"an open line of prose gives no verdict");
});

test("a line over 4,096 characters rules the reply out for good, finished or not, whole or in pieces",()=>{
  const head="Error: RetriableError: [unavailable] ",atLimit=head+"-".repeat(4096-head.length),cut="Error: ConnectError: [aborted] Stream closed with error code NGHTTP2_CANCEL";
  assert.equal(read(atLimit),atLimit,"a line of exactly 4,096 is read");
  assert.equal(read(atLimit+"\n"),atLimit);
  assert.equal(read(atLimit+"\n"+atLimit),atLimit,"the limit is a line's, not the reply's");
  assert.equal(read(atLimit+"-"),undefined,"4,097 is over");
  assert.equal(read(atLimit.slice(0,1500),atLimit.slice(1500),"-"),undefined,"the open line is counted across pieces");
  assert.equal(read(atLimit+"\t"),undefined,"trailing white space counts toward the limit");
  assert.equal(read("\t".repeat(4097)+"\n"+cut),undefined,"a long blank line too");
  const reply=new CursorLostBackendReply();reply.append(atLimit+"--");reply.append("\n"+cut);
  assert.equal(reply.diagnostic,undefined,"for good");
});

test("a missing piece adds nothing, and any other value is read as its text",()=>{
  assert.equal(read("Error: Retri",undefined,null,"","ableError: socket hang up"),"Error: RetriableError: socket hang up");
  assert.equal(read("Error: RetriableError: [unavailable] retry ",3),"Error: RetriableError: [unavailable] retry 3");
  assert.equal(read(503),undefined);
  assert.equal(read({code:14}),undefined);
});
