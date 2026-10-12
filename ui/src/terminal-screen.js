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
  let state="text",params="",oscLength=0,pendingReturn=false,wrapChar="";
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
  // The character before the line break the screen ends with, when the line before that break is not empty.
  const charBeforeBreak=()=>{const text=chunks[chunks.length-1]?.text||"";return text.length>1&&text.endsWith("\n")&&text[text.length-2]!=="\n"?text[text.length-2]:""};
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
          if(ch==="H"){
            pendingReturn=false;
            // ConPTY wraps a line at the screen's edge after a scroll by writing a line break, moving back up to the last column
            // of the row it left and writing that column's character again: the wrap stays one line and the repeat is skipped.
            if((Number(params.split(";")[1])||1)>1){append(out);out="";wrapChar=charBeforeBreak()}
            else{wrapChar="";if(!atLineStart())out+="\n"}
          }else if(ch==="C"){wrapChar="";out+=" ".repeat(Math.min(Number(params)||1,240))}
          else if(ch==="J"&&(params==="2"||params==="3")){out="";chunks=[];lineCount=1;dropped=0;pendingReturn=false;wrapChar=""}
          continue;
        }
      }
      if(ch==="\x1b"){state="esc";continue}
      if(ch==="\r"){pendingReturn=true;wrapChar="";continue}
      if(ch==="\n"){pendingReturn=false;wrapChar="";out+="\n";continue}
      if(pendingReturn){pendingReturn=false;if(!atLineStart())out+="\n"}
      if(wrapChar){
        const repeated=ch===wrapChar;wrapChar="";
        if(repeated){const last=chunks[chunks.length-1];last.text=last.text.slice(0,-1);last.lines--;lineCount--;continue}
      }
      out+=ch;
    }
    append(out);
  }
  return {
    write,
    // A snapshot replaces the screen with the session's history.
    reset(buffer){chunks=[];lineCount=1;dropped=0;state="text";params="";pendingReturn=false;wrapChar="";write(buffer)},
    text:()=>chunks.map(chunk=>chunk.text).join(""),
    get chunks(){return chunks},
    get lines(){return lineCount},
    get dropped(){return dropped},
  };
}
