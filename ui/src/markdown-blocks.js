// The live reply's Markdown, cut into the top-level blocks the stream has finished and the open tail after them, so a long reply is
// not parsed again whole on every frame (StreamingMarkdown in ChatMarkdown.jsx). Where a block ends comes from the tail's own parse:
// a remark step records the root's children as the tail renders, and the next text moves the children before the open one into a
// finished block. A child is finished once a blank line follows it and the next child's first line is complete: text added later
// cannot reach back across that, since a list, a fence or indented code goes on only through what its next line starts with. Link
// reference and footnote definitions do reach back, and a carriage return is a line ending the cut does not look for, so a reply
// with either renders whole.

const CONTAINERS=new Set(["blockquote","list","listItem"]);
const defines=node=>(node.children||[]).some(child=>child.type==="definition"||child.type==="footnoteDefinition"||(CONTAINERS.has(child.type)&&defines(child)));
// Whether a child begins or ends with indented code. micromark looks past the blank lines after such code for more of it, so how
// the line after them reads depends on what came before the code (after a paragraph an ordered list there must start at 1), and a
// tail parsed on its own reads it afresh: no cut is made next to such code. Fenced code starts at its fence, indented code at its
// indentation.
function edgeIsIndentedCode(node,text,edge){
  while(CONTAINERS.has(node.type)&&node.children?.length)node=edge(node.children);
  return node.type==="code"&&!/^ {0,3}(?:`{3}|~{3})/.test(text.slice(node.position?.start?.offset??0));
}
const nextToIndentedCode=(node,text)=>edgeIsIndentedCode(node,text,list=>list[0])||edgeIsIndentedCode(node,text,list=>list[list.length-1]);

// What the parse of a tail found: its text and, for each of the root's children, its offsets and whether it begins or ends with
// indented code; whole when it defines a link or a footnote (or a child has no position).
export function rootBlocks(tree,text){
  const children=[];
  for(const child of tree?.children||[]){
    const start=child.position?.start?.offset,end=child.position?.end?.offset;
    if(!Number.isInteger(start)||!Number.isInteger(end))return {text,children:[],whole:true};
    children.push([start,end,nextToIndentedCode(child,text)]);
  }
  return {text,children,whole:defines(tree||{})};
}

// Where the finished part of a parsed tail ends and the open part starts: the end of the last finished child and the start of the
// line that begins the child after it, or null while every child can still change. No cut is made on either side of a child that
// begins or ends with indented code.
export function finishedThrough({text,children}){
  for(let index=children.length-1;index>0;index--){
    const start=children[index][0],end=children[index-1][1],line=text.lastIndexOf("\n",start-1)+1;
    if(children[index-1][2]||children[index][2]||line<=end||text.indexOf("\n",start)<0)continue;
    const gap=text.slice(end,line);
    if(/^\s*$/.test(gap)&&gap.indexOf("\n")!==gap.lastIndexOf("\n"))return {end,next:line};
  }
  return null;
}

// One live reply's cut. step(text) says what to render for the text so far: whole, or the finished blocks (each {from,text}) and
// the offset the tail starts at. record is the remark step for the tail's render; what it finds is used by the next step, and
// wantsWhole() says when it found a definition, so the reply can render whole before that frame is shown.
export function markdownStream(){
  let blocks=[],from=0,prefix="",whole=false,seen=null;
  return {
    record:()=>(tree,file)=>{seen=rootBlocks(tree,String(file.value))},
    wantsWhole:()=>!whole&&Boolean(seen?.whole),
    step(text){
      // A text that does not go on from the one the blocks were cut from (the stream started again) is cut afresh.
      if(!text.startsWith(prefix)){blocks=[];from=0;prefix="";whole=false}
      if(!whole&&text.includes("\r",from))whole=true;
      if(!whole&&seen&&text.startsWith(seen.text,from)){
        if(seen.whole)whole=true;
        // A finished block keeps the line ending after it: micromark reads a list item or a quote whose last line is a lone tag
        // (<br>) as a paragraph's lazy line before a line ending and as a block of HTML at the very end of a text.
        else{const cut=finishedThrough(seen);if(cut){blocks=[...blocks,{from,text:seen.text.slice(0,seen.text.indexOf("\n",cut.end)+1)}];from+=cut.next;prefix=text.slice(0,from)}}
      }
      seen=null;
      return {whole,blocks,from};
    },
  };
}
