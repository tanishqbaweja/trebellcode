// A terminal pane's screen as plain text, built from the shell's output as it arrives. Control sequences become the text they
// stand for: Windows' ConPTY moves the cursor to column 1 of a later row instead of writing a newline before each prompt, which
// glued lines together ("…All rights reserved.H:\repo>"), so such a move becomes a line break; a cursor-forward becomes spaces;
// a lone carriage return (progress redraws) starts a new line; and clearing the screen (cls, clear) drops the output before it.
// Each message is processed once, a sequence cut between two messages being finished by the next, and the text is kept in
// chunks so the page redraws only the chunk that changed: re-reading the whole screen for every message froze the page for
// seconds on a long run of output. The screen keeps its last TERMINAL_SCROLLBACK_LINES lines, as the server's history does,
// and counts the lines it dropped.
export const TERMINAL_SCROLLBACK_LINES=5000;
const CHUNK_LINES=200;

export function createTerminalScreen({maxLines=TERMINAL_SCROLLBACK_LINES}={}){
  let chunks=[],lineCount=1,dropped=0,nextId=1;
  let state="text",params="",oscLength=0,pendingReturn=false;
  function append(text){
    for(let start=0;start<text.length;){
      let chunk=chunks[chunks.length-1];
      if(!chunk||chunk.lines>=CHUNK_LINES)chunks.push(chunk={id:nextId++,text:"",lines:0});
      let end=start;
      while(end<text.length&&chunk.lines<CHUNK_LINES){const at=text.indexOf("\n",end);if(at<0){end=text.length;break}end=at+1;chunk.lines++;lineCount++}
      chunk.text+=text.slice(start,end);start=end;
    }
    while(lineCount>maxLines){
      const first=chunks[0],excess=lineCount-maxLines;
      if(chunks.length>1&&first.lines<=excess){chunks.shift();lineCount-=first.lines;dropped+=first.lines;continue}
      let at=-1;for(let count=0;count<excess;count++)at=first.text.indexOf("\n",at+1);
      first.text=first.text.slice(at+1);first.lines-=excess;lineCount-=excess;dropped+=excess;
    }
  }
  const lastChar=()=>{for(let index=chunks.length-1;index>=0;index--){const text=chunks[index].text;if(text)return text[text.length-1]}return ""};
  function write(data){
    const text=String(data||"");let out="";
    const atLineStart=()=>{const last=out?out[out.length-1]:lastChar();return !last||last==="\n"};
    for(let index=0;index<text.length;index++){
      const ch=text[index];
      if(state==="osc"){if(ch==="\x07")state="text";else if(ch==="\x1b")state="osc-esc";else if(++oscLength>4096)state="text";continue}
      if(state==="osc-esc"){if(ch==="\\"){state="text";continue}state="esc"}
      if(state==="esc"){state=ch==="["?"csi":ch==="]"?"osc":"()*+".includes(ch)?"charset":"text";params="";oscLength=0;continue}
      if(state==="charset"){state="text";continue}
      if(state==="csi"){
        const code=ch.charCodeAt(0);
        if(code>=0x20&&code<=0x3f&&params.length<64){params+=ch;continue}
        state="text";
        if(code>=0x40&&code<=0x7e){
          if(ch==="H"){pendingReturn=false;if((Number(params.split(";")[1])||1)===1&&!atLineStart())out+="\n"}
          else if(ch==="C")out+=" ".repeat(Math.min(Number(params)||1,240));
          else if(ch==="J"&&(params==="2"||params==="3")){out="";chunks=[];lineCount=1;dropped=0;pendingReturn=false}
          continue;
        }
      }
      if(ch==="\x1b"){state="esc";continue}
      if(ch==="\r"){pendingReturn=true;continue}
      if(ch==="\n"){pendingReturn=false;out+="\n";continue}
      if(pendingReturn){pendingReturn=false;if(!atLineStart())out+="\n"}
      out+=ch;
    }
    append(out);
  }
  return {
    write,
    // A snapshot replaces the screen with the session's history.
    reset(buffer){chunks=[];lineCount=1;dropped=0;state="text";params="";pendingReturn=false;write(buffer)},
    text:()=>chunks.map(chunk=>chunk.text).join(""),
    get chunks(){return chunks},
    get lines(){return lineCount},
    get dropped(){return dropped},
  };
}
