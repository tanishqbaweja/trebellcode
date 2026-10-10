import React,{memo,useEffect,useRef,useState} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { writeClipboardText } from "../clipboard.js";
import { externalHref } from "../markdown-links.js";

// Assistant replies are Markdown, rendered as T3 Code renders them: react-markdown with GitHub-flavored Markdown. Raw HTML in a
// reply stays text (react-markdown only renders it with rehype-raw, which is not used), and react-markdown drops unsafe link
// protocols such as javascript:.
const REMARK_PLUGINS=[remarkGfm];

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

export default memo(function ChatMarkdown({text}){
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>{String(text||"")}</ReactMarkdown>;
});
