import React,{createContext,Fragment,memo,useContext,useEffect,useLayoutEffect,useReducer,useRef,useState} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { writeClipboardText } from "../clipboard.js";
import { externalHref } from "../markdown-links.js";
import { remarkSoftBreaks } from "../markdown-breaks.js";
import { markdownStream } from "../markdown-blocks.js";

// Assistant replies are Markdown, rendered as T3 Code renders them: react-markdown with GitHub-flavored Markdown. Raw HTML in a
// reply stays text (react-markdown only renders it with rehype-raw, which is not used), and react-markdown drops unsafe link
// protocols such as javascript:.
const REMARK_PLUGINS=[remarkGfm];
// lineBreaks (a harness's thinking) also keeps a single newline as a line break, raw HTML's included; replies keep Markdown's
// soft breaks.
const LINE_BREAK_PLUGINS=[remarkGfm,remarkSoftBreaks];

// A link that is not an absolute web or mail link stays text, with its target in the tooltip.
function MarkdownLink({href,children}){
  const external=externalHref(href);
  if(!external)return <span className="chat-markdown-link-text" title={href||undefined}>{children}</span>;
  return <a href={external} target="_blank" rel="noopener noreferrer" title={external}>{children}</a>;
}

function codeText(children){
  return React.Children.toArray(children).map(child=>typeof child==="string"?child:codeText(child?.props?.children)).join("");
}

// A live reply's code block is drawn again, as a new element, when the stream moves the text before it into a finished block
// (StreamingMarkdown). What the reply keeps for it here, by where the block starts in the reply, carries over to the new one: the
// outcome of its last copy and whether its Copy button had the keyboard.
const LiveCode=createContext(null);

function CodeBlock({children,node}){
  const code=React.Children.toArray(children)[0],language=/language-([\w+#.-]+)/.exec(code?.props?.className||"")?.[1]||"";
  const live=useContext(LiveCode),start=node?.position?.start?.offset,at=live&&Number.isInteger(start)?live.from+start:null,kept=at==null?null:live.kept.get(at);
  // A refused copy (a browser that blocks the clipboard) says so beside the button, as the row menu's Copy thread ID does, until
  // the next copy; Copied shows for 1.5 s.
  const [copied,setCopied]=useState(()=>kept?.copiedUntil>Date.now()),[refused,setRefused]=useState(()=>Boolean(kept?.refused)),timer=useRef(null),button=useRef(null);
  useEffect(()=>{
    if(kept?.copiedUntil>Date.now())timer.current=setTimeout(()=>setCopied(false),kept.copiedUntil-Date.now());
    return()=>clearTimeout(timer.current);
  },[]);
  // The block it replaces leaves its note as it goes, in the same commit, after this one rendered.
  useLayoutEffect(()=>{
    const note=at==null?null:live.kept.get(at);
    if(note?.focused){note.focused=false;button.current?.focus({preventScroll:true})}
    return()=>{if(at!=null&&document.activeElement===button.current)live.kept.set(at,{...live.kept.get(at),focused:true})};
  },[]);
  async function copy(){
    const copiedText=await writeClipboardText(codeText(code?.props?.children).replace(/\n$/,"")).catch(()=>false);
    clearTimeout(timer.current);setCopied(Boolean(copiedText));setRefused(!copiedText);
    if(at!=null)live.kept.set(at,{refused:!copiedText,copiedUntil:copiedText?Date.now()+1500:0});
    if(copiedText)timer.current=setTimeout(()=>setCopied(false),1500);
  }
  return <div className="chat-markdown-code">
    <div className="chat-markdown-code-head"><span>{language||"code"}</span>{refused&&<span className="chat-markdown-copy-error" role="alert">Could not copy to clipboard.</span>}<button ref={button} type="button" onClick={copy} aria-label={copied?"Copied":"Copy code"} title={copied?"Copied":"Copy code"}>{copied?<Check size={12}/>:<Copy size={12}/>}</button></div>
    <pre>{children}</pre>
  </div>;
}

const COMPONENTS={a:MarkdownLink,pre:CodeBlock};
// A perf spec that sets window.__trebellPerf before the app loads gets the length of each text parsed here (perf-budgets.spec.js,
// B16); nothing is kept otherwise.
const perf=typeof window==="undefined"?null:window.__trebellPerf||null;

// The live reply drawn last (StreamingMarkdown), whose code blocks' copy outcomes and keyboard focus the finished reply takes over:
// a reply that finishes streaming is drawn again as a ChatMarkdown, in the commit that takes the live one away, so Copied keeps its
// own timer through the end of the stream, a refusal stays until the next copy, and the keyboard stays on Copy code. A finished
// reply is the live one when either text starts with the other (the last deltas may come with the finished text), and it takes
// over within 2 s of the live reply going.
let liveReply=null;
function finishedReplyScope(value){
  const live=liveReply;if(!live||(live.endedAt&&Date.now()-live.endedAt>2000))return null;
  const finished=value.trimEnd(),streamed=live.text.trimEnd();
  return streamed&&(finished.startsWith(streamed)||streamed.startsWith(finished))?{from:0,kept:live.kept}:null;
}

// record, for StreamingMarkdown's tail, is a remark step that sees the parsed tree.
const ChatMarkdown=memo(function ChatMarkdown({text,lineBreaks=false,record=null}){
  const value=String(text||"");if(perf)(perf.markdown||=[]).push(value.length);
  const inLiveReply=Boolean(useContext(LiveCode)),[carried]=useState(()=>inLiveReply||lineBreaks?null:finishedReplyScope(value));
  const markdown=<ReactMarkdown remarkPlugins={record?[remarkGfm,record]:lineBreaks?LINE_BREAK_PLUGINS:REMARK_PLUGINS} components={COMPONENTS}>{value}</ReactMarkdown>;
  return carried?<LiveCode value={carried}>{markdown}</LiveCode>:markdown;
});
export default ChatMarkdown;

// The live reply while it streams. Each block the stream has finished is its own memoized render and only the open tail is parsed
// again as text arrives (markdown-blocks.js); the blocks are joined by the line break one render of the whole text puts between
// top-level blocks, so the page holds the same elements. The tail keeps its key as it becomes a finished block, so what is on screen
// stays in place. A tail that turns out to define a link or a footnote has the reply render whole before that frame is drawn. The
// finished reply is a ChatMarkdown, as before. A child of the tail that is still open when the text before it is cut off moves into
// the new tail and is drawn again there; each code block's copy outcome and keyboard focus go with it (LiveCode), until the reply
// starts again, and on into the finished reply (finishedReplyScope).
export const StreamingMarkdown=memo(function StreamingMarkdown({text}){
  const stream=useRef(null);stream.current||=markdownStream();
  const live=useRef(null);live.current||={text:"",kept:new Map(),scopes:new Map()};
  const [,again]=useReducer(count=>count+1,0);
  useLayoutEffect(()=>{if(stream.current.wantsWhole())again()});
  const value=String(text||""),{whole,blocks,from}=stream.current.step(value);
  if(!value.startsWith(live.current.text))live.current.kept.clear();
  live.current.text=value;liveReply=live.current;
  useEffect(()=>{live.current.endedAt=0;return()=>{live.current.endedAt=Date.now()}},[]);
  const scope=at=>{const {scopes,kept}=live.current;if(!scopes.has(at))scopes.set(at,{from:at,kept});return scopes.get(at)};
  if(whole)return <LiveCode value={scope(0)}><ChatMarkdown text={value}/></LiveCode>;
  return <>{blocks.map(block=><Fragment key={block.from}><LiveCode value={scope(block.from)}><ChatMarkdown text={block.text}/></LiveCode>{"\n"}</Fragment>)}<Fragment key={from}><LiveCode value={scope(from)}><ChatMarkdown text={value.slice(from)} record={stream.current.record}/></LiveCode></Fragment></>;
});
