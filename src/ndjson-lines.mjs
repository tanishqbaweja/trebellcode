import { StringDecoder } from "node:string_decoder";

// Reads newline-delimited JSON from a stream as its lines, split on "\n" alone, with one "\r" before it dropped (T3 frames ACP so,
// as NDJSON is framed). readline also ends a line at U+2028 and U+2029, which JSON.stringify leaves raw inside strings, so a
// message holding one came apart into pieces that are not JSON and was lost: an agent's reply, a permission request or a turn's
// answer, a terminal's output or a person's input to it. onLine gets each line; at the end of the stream, a last line without its
// "\n" too. onEnd is told once, when the stream ends, fails or closes; a failed stream is no error thrown. close() stops reading.
export function readNdjsonLines(stream,onLine,{onEnd=null}={}){
  const decoder=new StringDecoder("utf8");let rest="",done=false;
  const strip=line=>line.endsWith("\r")?line.slice(0,-1):line;
  // Only the new text is searched for "\n", so a long line that comes in many chunks is not searched again for each one.
  const data=chunk=>{
    const text=typeof chunk==="string"?chunk:decoder.write(chunk),lines=[];let start=0;
    for(let at=text.indexOf("\n");at>=0;at=text.indexOf("\n",start)){lines.push(strip(rest+text.slice(start,at)));rest="";start=at+1}
    rest+=text.slice(start);
    for(const line of lines)onLine(line);
  };
  const finish=ended=>{
    if(done)return;done=true;stream.off("data",data);
    const last=ended?rest+decoder.end():"";rest="";
    try{if(last)onLine(strip(last))}finally{onEnd?.()}
  };
  stream.on("data",data);
  stream.once("end",()=>finish(true));
  stream.on("error",()=>finish(false));
  stream.once("close",()=>finish(false));
  return {close(){if(!done){done=true;rest="";stream.off("data",data)}}};
}
