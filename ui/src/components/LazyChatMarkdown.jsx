import React,{memo,useEffect,useState} from "react";

// ChatMarkdown and the Markdown packages under it are a fifth of the startup script, so they load after the first paint instead:
// the import starts when the page first goes idle, or as soon as a reply needs it. A reply rendered before it arrives shows its text
// as written, line breaks kept, in the same place; from then on every render is ChatMarkdown's, on the first pass.
let loaded=null,loading=null;
const load=()=>loading||=import("./ChatMarkdown.jsx").then(module=>loaded=module,error=>{loading=null;throw error});
if(typeof window!=="undefined")requestAnimationFrame(()=>setTimeout(()=>(window.requestIdleCallback||(callback=>setTimeout(callback,200)))(()=>load().catch(()=>{}),{timeout:2000})));

function useLoaded(){
  const [markdown,setMarkdown]=useState(loaded);
  useEffect(()=>{if(markdown)return;let current=true;load().then(next=>{if(current)setMarkdown(next)},()=>{});return ()=>{current=false}},[markdown]);
  return markdown||loaded;
}
const plainText=text=><p style={{whiteSpace:"pre-wrap"}}>{String(text||"")}</p>;

export const ChatMarkdown=memo(function LazyChatMarkdown(props){const markdown=useLoaded();return markdown?<markdown.default {...props}/>:plainText(props.text)});
export const StreamingMarkdown=memo(function LazyStreamingMarkdown(props){const markdown=useLoaded();return markdown?<markdown.StreamingMarkdown {...props}/>:plainText(props.text)});
export default ChatMarkdown;
