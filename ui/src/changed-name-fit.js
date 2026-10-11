import { distinctPathParts, splitPath } from "./inspector-labels.js";

// Which characters of each changed file's name the Diff list draws when the name is wider than its row. The list measures each row
// and each character (a CJK glyph is about twice a Latin one), so a cut is in whole characters, ends in no half glyph, and is decided
// by what tells the names apart, not by a fixed share of the row:
// - every name keeps its extension, and for every other changed name a character where the two differ (`marks`): the stretch between
//   the start and the end they share ("dark" in "…-dark-1280x800.png" beside "…-light-1280x800.png"), however far from the end it is;
// - the room left goes to the words those characters are in, then to the end before the extension, then to the start;
// - each run of characters left out is drawn as one "…", so a name may read "…dark…x800.png".
// A name shared in full by files in other folders keeps the folder segments that tell them apart in view instead (changedPathPlans).

const WORD=/[\p{L}\p{N}\p{M}]/u;
const segmenter=typeof Intl!=="undefined"&&typeof Intl.Segmenter==="function"?new Intl.Segmenter(undefined,{granularity:"grapheme"}):null;
// The characters a reader sees: an accent or an emoji sequence is one, never cut in two.
export function graphemes(text=""){const value=String(text??"");return segmenter?Array.from(segmenter.segment(value),part=>part.segment):Array.from(value)}
// Where the extension starts: the last dot after the first character, with at most 9 characters after it (else there is none).
export function extensionStart(glyphs=[]){const dot=glyphs.lastIndexOf(".");return dot>0&&glyphs.length-dot<=10?dot:glyphs.length}

// Up to this many names every name is compared with every other; past it, with its nearest neighbours by start and by end, which are
// the names it shares the most with.
const ALL_PAIRS_LIMIT=400,NEIGHBOURS=6;
function comparedWith(texts){
  if(texts.length<=ALL_PAIRS_LIMIT)return index=>texts.map((_,other)=>other);
  const reversed=texts.map(text=>Array.from(text).reverse().join("")),order=by=>texts.map((_,index)=>index).sort((a,b)=>by[a]<by[b]?-1:by[a]>by[b]?1:0);
  const orders=[order(texts),order(reversed)].map(list=>({list,at:new Map(list.map((index,position)=>[index,position]))}));
  return index=>orders.flatMap(({list,at})=>{const position=at.get(index);return list.slice(Math.max(0,position-NEIGHBOURS),position+NEIGHBOURS+1)});
}

// For each name: its characters, where its extension starts, and the characters that must stay drawn (sorted). Each other name gives
// the stretch where the two differ; a stretch the extension already covers needs nothing more, and the rest are each given one
// character, the last of the stretch (nearest the extension), shared between stretches where it can be (fewest marks).
export function changedNameMarks(names=[]){
  const texts=(Array.isArray(names)?names:[]).map(name=>String(name??"")),list=texts.map(graphemes),compared=comparedWith(texts);
  return list.map((own,index)=>{
    const count=own.length,extension=extensionStart(own),endFrom=extension<count?extension:Math.max(0,count-1),stretches=[];
    for(const other of new Set(compared(index))){
      if(other===index||texts[other]===texts[index])continue;
      const them=list[other];let prefix=0;while(prefix<count&&prefix<them.length&&own[prefix]===them[prefix])prefix++;
      let suffix=0;while(suffix<count-prefix&&suffix<them.length-prefix&&own[count-1-suffix]===them[them.length-1-suffix])suffix++;
      // A name that is the other with a part left out ("tool-activity.js" beside "tool-activity-summary.js") differs where its two
      // sides meet, so it keeps the characters on both sides of that point.
      const start=prefix<count-suffix?prefix:Math.max(0,prefix-1),end=prefix<count-suffix?count-suffix:Math.min(count,prefix+1);
      if(end>endFrom)continue;
      stretches.push([start,end]);
    }
    const marks=[];
    for(const [start,end] of stretches.sort((a,b)=>a[1]-b[1]||a[0]-b[0]))if(!marks.some(mark=>mark>=start&&mark<end))marks.push(end-1);
    return {glyphs:own,extension,marks:marks.sort((a,b)=>a-b)};
  });
}

// Each changed path's plan: its folder and name (splitPath), the name's marks, and for a name that another changed path shares in full,
// where its folder's segments that tell the two apart start (`dirKeep`, in characters of `dir`; null when nothing in the folder
// has to show). A file at the top of the tree beside one in a folder ("index.js", "lib/index.js") is told apart by the other's folder.
export function changedPathPlans(paths=[]){
  const list=(Array.isArray(paths)?paths:[]).map(path=>String(path??"")),split=list.map(path=>splitPath(path));
  const marks=changedNameMarks(split.map(part=>part.name)),groups=new Map();
  split.forEach((part,index)=>{const group=groups.get(part.name)||[];group.push(index);groups.set(part.name,group)});
  return split.map((part,index)=>{
    const group=groups.get(part.name),dirGlyphs=graphemes(part.dir);let dirKeep=null;
    if(group.length>1&&part.dir){
      // The segments after `dir` here are those that tell the paths apart, ending with the name itself.
      const shown=distinctPathParts(group.map(member=>list[member]))[group.indexOf(index)],kept=graphemes(shown.name).length-graphemes(part.name).length-1;
      dirKeep=Math.max(0,dirGlyphs.length-Math.max(0,kept));
    }
    return {...part,...marks[index],dirGlyphs,dirKeep};
  });
}

// Which characters to draw (`shown`) so the label fits `available` pixels, given each character's width and the ellipsis's, and how
// wide the label is. A name that fits is drawn whole. Otherwise the extension and the marks are drawn first (marks give way from
// the start of the name if even they do not fit, and the end alone is drawn if nothing else does), then, while there is room:
// the whole word of each mark, the end's own word back to 6 characters before the extension, whole words before the end, the start,
// what is left of the marks' words, and anything next to what is drawn. A run of one character is drawn rather than replaced by
// an ellipsis as wide. `lead:false` skips the start, for a folder, whose end is what tells it apart.
export function fitGlyphs(glyphs=[],{widths=[],ellipsis=0,available=0,marks=[],extension=glyphs.length,lead=true}={}){
  const count=glyphs.length,total=widths.reduce((sum,width)=>sum+(width||0),0),room=available+0.01;
  if(total<=room||!count)return {shown:glyphs.map(()=>true),width:total};
  const word=index=>index>=0&&index<count&&WORD.test(glyphs[index]);
  let shown=[],width=0;
  const measure=()=>{let sum=0,hidden=false;for(let index=0;index<count;index++){if(shown[index]){sum+=widths[index]||0;hidden=false}else if(!hidden){sum+=ellipsis;hidden=true}}return sum};
  const only=indexes=>{shown=new Array(count).fill(false);for(const index of indexes)shown[index]=true;width=measure()};
  // Drawing one more character: its run's ellipsis goes when the run was that character alone, and one more is drawn when it splits
  // its run in two.
  const change=index=>{const left=index===0||shown[index-1],right=index===count-1||shown[index+1];return (widths[index]||0)+(left&&right?-ellipsis:left||right?0:ellipsis)};
  const draw=index=>{if(shown[index])return true;const next=width+change(index);if(next>room)return false;shown[index]=true;width=next;return true};
  const drawAll=indexes=>{const before=shown.slice(),was=width;for(const index of indexes)if(!draw(index)){shown=before;width=was;return false}return true};
  const fillSingles=()=>{for(let index=0;index<count;index++)if(!shown[index]&&(index===0||shown[index-1])&&(index===count-1||shown[index+1])&&(widths[index]||0)<=ellipsis+0.01)draw(index)};
  const range=(start,end)=>{const list=[];for(let index=start;index<end;index++)list.push(index);return list};
  const wordOf=index=>{if(!word(index))return [index,index+1];let start=index,end=index+1;while(word(start-1))start--;while(word(end))end++;return [start,end]};
  const endStart=()=>{let index=count-1;while(index>0&&shown[index-1])index--;return index};
  const ending=range(extension<count?extension:count-1,count);
  let kept=[...new Set(marks)].filter(mark=>mark>=0&&mark<count).sort((a,b)=>a-b);
  for(only([...ending,...kept]);width>room&&kept.length;only([...ending,...kept]))kept=kept.slice(1);
  if(width>room){only([]);for(let index=count-1;index>=0&&draw(index);index--);return {shown,width}}
  fillSingles();
  for(const mark of kept)drawAll(range(...wordOf(mark)));
  fillSingles();
  // The end's own word, back to 6 characters before the extension, then whole words (with the separators after them) before it.
  for(let index=endStart()-1,limit=(extension<count?extension:count)-6;index>=limit&&word(index)&&draw(index);index--);
  for(let start=endStart();start>0&&!shown[start-1];start=endStart()){
    let index=start-1;while(index>0&&!word(index)&&!shown[index-1])index--;while(index>0&&word(index-1)&&!shown[index-1])index--;
    if(!drawAll(range(index,start)))break;
  }
  fillSingles();
  if(lead)for(let index=0;index<count&&!shown[index]&&draw(index);index++);
  fillSingles();
  for(const mark of kept){const [start,end]=wordOf(mark);for(let distance=1;mark-distance>=start||mark+distance<end;distance++){draw(Math.max(start,mark-distance));draw(Math.min(end-1,mark+distance))}}
  for(let index=endStart()-1;index>=0&&!shown[index]&&draw(index);index--);
  for(let index=0;index<count;index++)if(!shown[index]&&((index>0&&shown[index-1])||(index<count-1&&shown[index+1])))draw(index);
  fillSingles();
  return {shown,width};
}

// The drawn label as runs: [{text, hidden}], each hidden run standing for one ellipsis.
export function glyphRuns(glyphs=[],shown=[]){
  const runs=[];
  glyphs.forEach((glyph,index)=>{const hidden=!shown[index],last=runs[runs.length-1];if(last&&last.hidden===hidden)last.text+=glyph;else runs.push({text:glyph,hidden})});
  return runs;
}
// A label written out, "…" for each hidden run: what a reader sees.
export function glyphLabel(glyphs=[],shown=[]){return glyphRuns(glyphs,shown).map(run=>run.hidden?"…":run.text).join("")}
