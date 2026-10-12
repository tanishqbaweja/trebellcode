import React,{Fragment,memo,useEffect,useLayoutEffect,useReducer,useRef,useState} from "react";
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

function CodeBlock({children}){
  const code=React.Children.toArray(children)[0],language=/language-([\w+#.-]+)/.exec(code?.props?.className||"")?.[1]||"";
  const [copied,setCopied]=useState(false),timer=useRef(null);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  async function copy(){
    const copiedText=await writeClipboardText(codeText(code?.props?.children).replace(/\n$/,"")).catch(()=>false);
    clearTimeout(timer.current);setCopied(Boolean(copiedText));
    if(copiedText)timer.current=setTimeout(()=>setCopied(false),1500);
  }
  return <div className="chat-markdown-code">
    <div className="chat-markdown-code-head"><span>{language||"code"}</span><button type="button" onClick={copy} aria-label={copied?"Copied":"Copy code"} title={copied?"Copied":"Copy code"}>{copied?<Check size={12}/>:<Copy size={12}/>}</button></div>
    <pre>{children}</pre>
  </div>;
}

const COMPONENTS={a:MarkdownLink,pre:CodeBlock};
// A perf spec that sets window.__trebellPerf before the app loads gets the length of each text parsed here (perf-budgets.spec.js,
// B16); nothing is kept otherwise.
const perf=typeof window==="undefined"?null:window.__trebellPerf||null;

// record, for StreamingMarkdown's tail, is a remark step that sees the parsed tree.
const ChatMarkdown=memo(function ChatMarkdown({text,lineBreaks=false,record=null}){
  const value=String(text||"");if(perf)(perf.markdown||=[]).push(value.length);
  return <ReactMarkdown remarkPlugins={record?[remarkGfm,record]:lineBreaks?LINE_BREAK_PLUGINS:REMARK_PLUGINS} components={COMPONENTS}>{value}</ReactMarkdown>;
});
export default ChatMarkdown;

// The live reply while it streams. Each block the stream has finished is its own memoized render and only the open tail is parsed
// again as text arrives (markdown-blocks.js); the blocks are joined by the line break one render of the whole text puts between
// top-level blocks, so the page holds the same elements. The tail keeps its key as it becomes a finished block, so what is on screen
// stays in place. A tail that turns out to define a link or a footnote has the reply render whole before that frame is drawn. The
// finished reply is a ChatMarkdown, as before.
export const StreamingMarkdown=memo(function StreamingMarkdown({text}){
  const stream=useRef(null);stream.current||=markdownStream();
  const [,again]=useReducer(count=>count+1,0);
  useLayoutEffect(()=>{if(stream.current.wantsWhole())again()});
  const value=String(text||""),{whole,blocks,from}=stream.current.step(value);
  if(whole)return <ChatMarkdown text={value}/>;
  return <>{blocks.map(block=><Fragment key={block.from}><ChatMarkdown text={block.text}/>{"\n"}</Fragment>)}<Fragment key={from}><ChatMarkdown text={value.slice(from)} record={stream.current.record}/></Fragment></>;
});
