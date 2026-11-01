// Cursor, when it loses the connection to its backend, writes a diagnostic as the reply text and ends the turn as if it had
// answered. CursorLostBackendReply reads one reply message as Cursor streams it and tells whether the whole message is such a
// diagnostic, with the stack lines under it, so the ACP session fails the turn with that line instead of showing it as the answer
// (acp-agent-session.mjs). A message that quotes a diagnostic among other lines is an answer.

// No diagnostic line is longer (in UTF-16 code units): a longer line rules the message out, and the limit bounds what is kept.
const LONGEST_LINE = 4096;

// The heads of the two error lines. Connect writes an error's message as "[code] detail".
const RETRIABLE_HEAD = "Error: RetriableError: ";
const CONNECT_HEAD = "Error: ConnectError: ";
// The Connect codes of a backend that could not be reached, a call that was cut off and a deadline that passed.
const LOST_BACKEND_CODES = ["unavailable", "aborted", "deadline_exceeded"].map(code => `[${code}]`);
// Cursor tags its own agent-loop failures so; what they say is worth keeping as the answer.
const AGENT_LOOP_TAG = "[internal]";
// What Cursor says in a sentence of its own when it cannot reach its server.
const SERVER_SENTENCE = "Something went wrong communicating with the server. Please try again.";

// Characters other than the line feed that break a line: a diagnostic is one line, so it holds none of them.
const OTHER_LINE_BREAK = /[\r\u2028\u2029]/;
const WHITE_SPACE = /\s/;

// A message's verdict: undefined while no line has decided it, the latest diagnostic line while it is a dump, and RULED_OUT, which
// is final, once a line showed it is something else.
const RULED_OUT = Symbol("not a lost-backend dump");

// Whether a line, its trailing white space gone, is one of the diagnostics Cursor writes for a lost backend.
function isDiagnostic(line) {
  if (line === SERVER_SENTENCE) return true;
  if (OTHER_LINE_BREAK.test(line)) return false;
  if (line.startsWith(RETRIABLE_HEAD)) {
    const detail = line.slice(RETRIABLE_HEAD.length);
    return detail.length > 0 && !detail.startsWith(AGENT_LOOP_TAG);
  }
  return line.startsWith(CONNECT_HEAD) && LOST_BACKEND_CODES.some(code => line.startsWith(code, CONNECT_HEAD.length));
}

// Whether a line is a frame of a V8 stack trace: indented, then "at" and white space ("    at fn (file.js:1:1)").
function isStackFrame(line) {
  const unindented = line.trimStart();
  return unindented !== line && unindented.startsWith("at") && WHITE_SPACE.test(unindented.charAt(2));
}

// The verdict once one more line has been read. Blank lines change nothing, and stack frames may only follow a diagnostic.
function verdictAfter(verdict, rawLine) {
  if (verdict === RULED_OUT) return RULED_OUT;
  const line = rawLine.trimEnd();
  if (!line) return verdict;
  if (isDiagnostic(line)) return line;
  return typeof verdict === "string" && isStackFrame(line) ? verdict : RULED_OUT;
}

export class CursorLostBackendReply {
  #verdict = undefined;
  // The line Cursor is still writing: the text after the last line feed.
  #openLine = "";

  // Takes the message's next piece of text. A missing piece adds nothing; any other value is read as its string.
  append(piece) {
    if (piece == null) return;
    const text = String(piece);
    let start = 0;
    while (this.#verdict !== RULED_OUT) {
      const end = text.indexOf("\n", start);
      const part = end === -1 ? text.slice(start) : text.slice(start, end);
      if (this.#openLine.length + part.length > LONGEST_LINE) {
        this.#verdict = RULED_OUT;
        this.#openLine = "";
        return;
      }
      this.#openLine += part;
      if (end === -1) return;
      this.#verdict = verdictAfter(this.#verdict, this.#openLine);
      this.#openLine = "";
      start = end + 1;
    }
  }

  // The diagnostic line when all the text so far, its unfinished last line included, is a lost-backend dump; undefined otherwise.
  // Reading it changes nothing.
  get diagnostic() {
    const verdict = verdictAfter(this.#verdict, this.#openLine);
    return typeof verdict === "string" ? verdict : undefined;
  }
}
