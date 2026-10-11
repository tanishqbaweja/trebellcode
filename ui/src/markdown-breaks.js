const NEWLINE=/\r?\n|\r/;
// Nodes whose children are blocks: raw HTML directly inside one is an HTML block, anywhere else it is inline.
const BLOCK_PARENTS=new Set(["root","blockquote","listItem","footnoteDefinition"]);

// A value's lines as text nodes with a break between each pair; an empty line is only its break.
const lineNodes=value=>String(value).split(NEWLINE).flatMap((line,index)=>[...(index?[{type:"break"}]:[]),...(line?[{type:"text",value:line}]:[])]);

// remark-breaks' rule without the dependency: a newline inside a paragraph (Markdown's soft line break) becomes a hard break,
// so text written one thought per line keeps its lines under white-space:normal. Only text and raw HTML change: code and inline
// code keep their own newlines, and the newlines between blocks (list items, the one after a <br>) are not text in this tree,
// so they gain no blank lines.
// Raw HTML shows as its own text (react-markdown renders it only with rehype-raw), so it splits the same way, and an HTML block
// becomes a paragraph of its lines: left as raw HTML it is a bare text node between blocks, on one line with no spacing below.
export function softBreaksToHardBreaks(node){
  if(!Array.isArray(node?.children))return node;
  const blockParent=BLOCK_PARENTS.has(node.type);
  node.children=node.children.flatMap(child=>{
    if(child?.type==="html"){const lines=lineNodes(child.value);return blockParent?(lines.length?[{type:"paragraph",children:lines}]:[]):lines}
    return child?.type==="text"&&NEWLINE.test(child.value)?lineNodes(child.value):[softBreaksToHardBreaks(child)];
  });
  // A tight list shows an item's paragraphs as bare text joined by a newline, which reads as a space, so in an item written with
  // no blank line between its blocks an HTML block and the paragraph beside it stay one paragraph, a break apart.
  if(node.type==="listItem"&&node.spread===false)node.children=node.children.reduce((children,child)=>{
    const previous=children.at(-1);
    if(previous?.type==="paragraph"&&child?.type==="paragraph")previous.children.push({type:"break"},...child.children);else children.push(child);
    return children;
  },[]);
  return node;
}

export function remarkSoftBreaks(){return softBreaksToHardBreaks}
