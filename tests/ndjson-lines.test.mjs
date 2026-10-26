// The JSON-lines reader of ACP's stdio and the terminal worker's pipes: lines end at "\n" alone, with one "\r" before it dropped,
// UTF-8 split between chunks is read whole, the last line without its "\n" is read at the end, and the end, a failure or a close of
// the stream is told once without an error thrown.
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readNdjsonLines } from "../src/ndjson-lines.mjs";

const LS=String.fromCharCode(0x2028),PS=String.fromCharCode(0x2029);
function reader(){
  const stream=new PassThrough(),lines=[];let ends=0;
  const handle=readNdjsonLines(stream,line=>lines.push(line),{onEnd:()=>ends++});
  return {stream,lines,handle,ends:()=>ends};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test("lines end at a newline alone, so U+2028, U+2029 and a lone carriage return stay inside their line",async()=>{
  const {stream,lines}=reader();
  const message=JSON.stringify({text:`a${LS}b${PS}c`});
  stream.write(message+"\n"+"crlf\r\n"+"lone\rreturn\n"+"\n");
  await settle();
  assert.deepEqual(lines,[message,"crlf","lone\rreturn",""]);
  assert.deepEqual(JSON.parse(lines[0]),{text:`a${LS}b${PS}c`});
});

test("a character split between chunks and a line in many chunks are read whole, and the last line comes at the end",async()=>{
  const {stream,lines,ends}=reader();
  const bytes=Buffer.from(`{"text":"${LS}é"}\nnext`,"utf8"),at=bytes.indexOf(0xe2)+1;
  stream.write(bytes.subarray(0,at));stream.write(bytes.subarray(at,at+1));stream.write(bytes.subarray(at+1));
  for(const piece of ["-one","-two","\r"])stream.write(piece);
  await settle();
  assert.deepEqual(lines,[`{"text":"${LS}é"}`]);
  stream.end();await settle();
  assert.deepEqual(lines,[`{"text":"${LS}é"}`,"next-one-two"]);
  assert.equal(ends(),1);
});

test("a failed or closed stream is told once without an error thrown, and close() stops the lines",async()=>{
  const failed=reader();
  failed.stream.write("partial");failed.stream.destroy(new Error("pipe broke"));await settle();
  assert.deepEqual(failed.lines,[],"a line the failure cut short is not read");
  assert.equal(failed.ends(),1);
  const stopped=reader();
  stopped.stream.write("one\n");await settle();stopped.handle.close();
  stopped.stream.write("two\n");stopped.stream.end();await settle();
  assert.deepEqual(stopped.lines,["one"]);assert.equal(stopped.ends(),0,"a reader closed by its owner tells no end");
});
