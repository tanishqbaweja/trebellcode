import { StringDecoder } from "node:string_decoder";

// Plain text from what a child program wrote for a terminal, for the logs Trebell shows in a page rather than a terminal (the
// Diagnostics runtime log): its colour and cursor codes are dropped, so "ERROR" does not read "<ESC>[31mERROR<ESC>[0m". One pass
// over the text, so dropping one sequence never joins its neighbours into another:
// - strings: OSC (ESC ]), DCS (ESC P), SOS (ESC X), PM (ESC ^) and APC (ESC _) up to BEL or ESC \; another ESC ends one that is
//   not terminated, as in a terminal, and so does the end of the text (window titles, hyperlinks, terminal queries);
// - CSI sequences: ESC [ then parameter bytes, intermediate bytes and one final byte (colours, cursor moves, erases);
// - escapes with intermediate bytes: ESC, bytes from " " to "/" and one final byte (as ESC ( B, which sets the character set);
// - any other two-byte escape: ESC and one byte from "0" to "~" (as ESC 7, ESC = or ESC c);
// - a lone ESC (before another ESC, a control character or the end).
// Everything else, line breaks and tabs included, is kept as written.
const SEQUENCE=/\x1b(?:[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?|\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|[\x20-\x2f]+[\x30-\x7e]?|[\x30-\x7e])?/g;
// A sequence the end of a chunk cuts short, from the chunk's last ESC: a string not yet ended, or a CSI sequence or an escape with
// intermediate bytes still waiting for its final byte (a lone ESC included).
const UNFINISHED=/^\x1b(?:[\]PX^_][^\x07]*|\[[\x30-\x3f]*[\x20-\x2f]*|[\x20-\x2f]*)$/;
const HELD_LIMIT=4096;

export function plainTerminalText(value){
  const text=String(value??"");
  return text.includes("\x1b")?text.replace(SEQUENCE,""):text;
}

// The plain text of one output stream, chunk by chunk (one per stream): a sequence or a UTF-8 character that the end of a chunk
// cuts in two waits for the next chunk, so the log shows no fragment of either (a remote environment's connection hands output on
// in reads of its own size). A sequence of more than 4,096 characters does not wait; it is dropped as at the end of a text. Anything
// but bytes (a message Trebell writes itself, such as an exit line) drops what was waiting and is read as a whole text.
export function plainTerminalStream(){
  const decoder=new StringDecoder("utf8");
  let held="";
  return chunk=>{
    if(!(chunk instanceof Uint8Array)){held="";return plainTerminalText(chunk);}
    const text=held+decoder.write(chunk),at=text.lastIndexOf("\x1b");
    held=at>=0&&text.length-at<=HELD_LIMIT&&UNFINISHED.test(text.slice(at))?text.slice(at):"";
    return plainTerminalText(held?text.slice(0,at):text);
  };
}
