// Plain text from what a child program wrote for a terminal, for the logs Trebell shows in a page rather than a terminal (the
// Diagnostics runtime log): its colour and cursor codes are dropped, so "ERROR" does not read "<ESC>[31mERROR<ESC>[0m".
// - CSI sequences: ESC [ then parameter bytes, intermediate bytes and one final byte (colours, cursor moves, erases).
// - OSC sequences: ESC ] up to BEL or ESC \ (window titles, hyperlinks); an unterminated one runs to the end of the chunk.
// - Any other two-byte escape: ESC and one byte from "0" to "~" (as ESC 7, ESC = or ESC c).
// Everything else, line breaks and tabs included, is kept as written.
const CSI=/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g,OSC=/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g,OTHER=/\x1b[\x30-\x5a\x5c-\x7e]/g;

export function plainTerminalText(value){
  const text=String(value??"");
  return text.includes("\x1b")?text.replace(OSC,"").replace(CSI,"").replace(OTHER,""):text;
}
