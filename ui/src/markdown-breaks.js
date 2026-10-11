const NEWLINE=/\r?\n|\r/;

// remark-breaks' rule without the dependency: a newline inside a paragraph (Markdown's soft line break) becomes a hard break,
// so text written one thought per line keeps its lines under white-space:normal. Only text nodes change: code and inline code
// keep their own newlines, and the newlines between blocks (list items, the one after a <br>) are not text in this tree, so
// they gain no blank lines.
export function softBreaksToHardBreaks(node){
  if(!Array.isArray(node?.children))return node;
  node.children=node.children.flatMap(child=>child?.type==="text"&&NEWLINE.test(child.value)
    ?String(child.value).split(NEWLINE).flatMap((value,index)=>[...(index?[{type:"break"}]:[]),...(value?[{type:"text",value}]:[])])
    :[softBreaksToHardBreaks(child)]);
  return node;
}

export function remarkSoftBreaks(){return softBreaksToHardBreaks}
