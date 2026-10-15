import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import { Check, FileCode2, FileDiff, FileImage, FileText, Folder, LoaderCircle, Music2, Paperclip, RefreshCw, Save, Search, Video, WrapText, X } from "lucide-react";
import { api } from "../api.js";
import { formatBytes } from "../format-bytes.js";
import { actionError, actionErrorUnlessNamed, gitStatusBadge, gitStatusEntry } from "../inspector-labels.js";
import { changedPathPlans, fitGlyphs, glyphRuns } from "../changed-name-fit.js";
import { highlightSyntax } from "../syntax-language.js";
import { WORKSPACE_CHANGED_PAGE_SIZE, WORKSPACE_DIFF_CHUNK_CHARS, WORKSPACE_TREE_PAGE_SIZE, workspaceListWindow, workspaceTextWindow } from "../workspace-view-window.js";
import OpenInPicker from "./OpenInPicker.jsx";
import { askConfirm, askText } from "./RightPanel.jsx";

const IMAGE_EXT=new Set(["png","jpg","jpeg","gif","webp","bmp","svg","ico"]);
const VIDEO_EXT=new Set(["mp4","webm","mov"]);
const AUDIO_EXT=new Set(["mp3","wav","m4a","ogg","flac"]);
const TABLE_EXT=new Set(["csv","tsv"]);
// Diff lines wrap by default, as in T3 Code; the choice is remembered in this browser.
const DIFF_WRAP_KEY="trebell.diffWordWrap";
function readDiffWrap(){try{return localStorage.getItem(DIFF_WRAP_KEY)!=="false"}catch{return true}}

function extension(name=""){return name.split(".").pop()?.toLowerCase()||""}
function previewKind(name=""){
  const ext=extension(name);
  if(IMAGE_EXT.has(ext))return "image";
  if(VIDEO_EXT.has(ext))return "video";
  if(AUDIO_EXT.has(ext))return "audio";
  if(ext==="pdf")return "pdf";
  if(ext==="html"||ext==="htm")return "html";
  if(ext==="md"||ext==="markdown")return "markdown";
  if(TABLE_EXT.has(ext))return "table";
  return "text";
}
function parseDelimited(text,delimiter=","){
  const rows=[];let row=[],cell="",quoted=false;
  const value=String(text||"");
  for(let i=0;i<value.length;i++){
    const ch=value[i],next=value[i+1];
    if(ch==='"'){
      if(quoted&&next==='"'){cell+='"';i++}
      else quoted=!quoted;
    }else if(ch===delimiter&&!quoted){row.push(cell);cell=""}
    else if((ch==="\n"||ch==="\r")&&!quoted){
      if(ch==="\r"&&next==="\n")i++;
      row.push(cell);rows.push(row);row=[];cell="";
      if(rows.length>=300)break;
    }else cell+=ch;
  }
  if(cell||row.length){row.push(cell);rows.push(row)}
  return rows;
}
// A line's inline marks: `code` (its text kept as it is), ***bold italic***, **bold** and *italic*, which may hold code; an italic
// run may hold a **bold** one whole, so its first "*" does not end the italic. Each mark is an element holding text, so nothing in
// the file is ever read as HTML; a lone "*" (2 * 3) stays text.
const INLINE_MARK=/(`+)(.+?)\1|\*\*\*(?=[^\s*])(.+?)(?<=[^\s*])\*\*\*|\*\*(?=\S)(.+?)(?<=\S)\*\*|\*(?=[^\s*])((?:\*\*(?=\S).+?(?<=\S)\*\*|[^*]|\*(?=\s))+?)(?<=\S)\*/g;
function inlineMarks(text){
  const parts=[];let last=0;
  for(const match of text.matchAll(INLINE_MARK)){
    if(match.index>last)parts.push(text.slice(last,match.index));
    parts.push(match[2]!=null?<code key={match.index}>{match[2]}</code>:match[3]!=null?<em key={match.index}><strong>{inlineMarks(match[3])}</strong></em>:match[4]!=null?<strong key={match.index}>{inlineMarks(match[4])}</strong>:<em key={match.index}>{inlineMarks(match[5])}</em>);
    last=match.index+match[0].length;
  }
  if(last<text.length)parts.push(text.slice(last));
  return parts;
}
function MarkdownPreview({content}){
  const lines=String(content||"").split(/\r?\n/);
  let fenced=false;
  return <div className="markdown-preview">{lines.map((line,index)=>{
    if(line.trim().startsWith("```")){fenced=!fenced;return <div className="md-fence" key={index}>{fenced?"code":""}</div>}
    if(fenced)return <pre key={index}>{line||" "}</pre>;
    const h=line.match(/^(#{1,6})\s+(.+)$/);if(h)return React.createElement("h"+h[1].length,{key:index},inlineMarks(h[2]));
    const item=line.match(/^\s*[-*+]\s+(.+)$/);if(item)return <div className="md-list" key={index}>• <span>{inlineMarks(item[1])}</span></div>;
    if(line.startsWith(">"))return <blockquote key={index}>{inlineMarks(line.replace(/^>\s?/,""))}</blockquote>;
    if(!line.trim())return <div className="md-gap" key={index}/>;
    return <p key={index}>{inlineMarks(line)}</p>;
  })}</div>;
}
function fileIcon(name){
  const kind=previewKind(name);
  if(kind==="image")return <FileImage size={14}/>;
  if(kind==="video")return <Video size={14}/>;
  if(kind==="audio")return <Music2 size={14}/>;
  if(kind==="pdf"||kind==="markdown"||kind==="table")return <FileText size={14}/>;
  return <FileCode2 size={14}/>;
}
// Presentation only: colors unified-diff lines and git status codes in the inspector.
// Header lines (index, ---/+++, mode) only occur before a file's first hunk, so a deleted "-- comment" line stays a deletion.
function diffLineKinds(lines){
  let inHunk=false;
  return lines.map(line=>{
    if(line.startsWith("diff --git ")){inHunk=false;return "file"}
    if(line.startsWith("@@")){inHunk=true;return "hunk"}
    if(!inHunk||line.startsWith("\\"))return "meta";
    if(line.startsWith("+"))return "add";
    if(line.startsWith("-"))return "del";
    return "ctx";
  });
}
// Nested tree rows show their own name (the indent carries the parent); flat rows and search hits keep the relative path.
function treeLabel(entry,searching){
  const relative=String(entry.relativePath||entry.name||"");
  if(searching||!entry.name)return relative;
  const depth=relative.split(/[\\/]/).filter(Boolean).length-1;
  return depth===(entry.depth||0)?entry.name:relative;
}
// A changed file shows its name first and its folder after it, muted, so a narrow list cuts the folder rather than the name
// ("src/new-fe…" before). The separator is only hidden, so the row's text is still the path ("dir/name"), and its button names the
// whole path for screen readers.
// An untracked folder ("name/") is named like a file instead of showing as a folder hint with no name.
// A name wider than its row is cut where changed-name-fit.js says, measured in the row's own font: each run left out is one "…" and
// its text stays in the row, hidden, so the row's text is still the path. A name that another changed file shares in full keeps the
// folder segments that tell the two apart in view after it ("…alpha"), and the name gives way for them.
let glyphContext=null;const glyphWidths=new Map(),fontListeners=new Set();let fontRevision=0;
function fontsChanged(){fontRevision++;glyphWidths.clear();for(const listener of fontListeners)listener(fontRevision)}
if(typeof document!=="undefined"&&document.fonts){document.fonts.ready?.then(fontsChanged);document.fonts.addEventListener?.("loadingdone",fontsChanged)}
function useFontRevision(){const [revision,setRevision]=useState(fontRevision);useEffect(()=>{fontListeners.add(setRevision);setRevision(fontRevision);return()=>{fontListeners.delete(setRevision)}},[]);return revision}
function glyphMeasure(element){
  const style=getComputedStyle(element),font=[style.fontStyle,style.fontWeight,style.fontSize,style.fontFamily].join(" "),spacing=parseFloat(style.letterSpacing)||0;
  return glyph=>{const key=font+"\n"+glyph;let width=glyphWidths.get(key);if(width==null){glyphContext??=document.createElement("canvas").getContext("2d");glyphContext.font=font;width=glyphContext.measureText(glyph).width;glyphWidths.set(key,width)}return width+spacing};
}
const resizeCallbacks=new WeakMap();let resizeObserver=null;
function observeResize(element,callback){
  if(typeof ResizeObserver==="undefined")return()=>{};
  resizeObserver??=new ResizeObserver(entries=>{for(const entry of entries)resizeCallbacks.get(entry.target)?.()});
  resizeCallbacks.set(element,callback);resizeObserver.observe(element);
  return()=>{resizeCallbacks.delete(element);resizeObserver.unobserve(element)};
}
// What fits: the name in the row (less a pixel, so rounding never pushes its end out), or, for a name shared in full, the folder's
// telling segments first and the name in the rest.
function fitChangedPath(element,plan){
  const nameElement=element.querySelector(".changed-file-name"),dirElement=element.querySelector(".changed-file-dir");if(!nameElement)return null;
  const room=Math.max(0,element.clientWidth-1),nameWidth=glyphMeasure(nameElement),nameOptions={widths:plan.glyphs.map(nameWidth),ellipsis:nameWidth("…"),marks:plan.marks,extension:plan.extension};
  if(plan.dirKeep==null||!dirElement)return {name:fitGlyphs(plan.glyphs,{...nameOptions,available:room}).shown,dir:null};
  const gap=parseFloat(getComputedStyle(element).columnGap)||0,dirWidth=glyphMeasure(dirElement),dirWidths=plan.dirGlyphs.map(dirWidth),dirEllipsis=dirWidth("…");
  const sum=list=>list.reduce((total,width)=>total+width,0),dirNeed=Math.min(sum(dirWidths),(plan.dirKeep>0?dirEllipsis:0)+sum(dirWidths.slice(plan.dirKeep)));
  const name=fitGlyphs(plan.glyphs,{...nameOptions,available:Math.max(0,room-gap-dirNeed)});
  return {name:name.shown,dir:fitGlyphs(plan.dirGlyphs,{widths:dirWidths,ellipsis:dirEllipsis,available:Math.max(0,room-gap-name.width),extension:plan.dirKeep,lead:false}).shown};
}
function FittedText({glyphs,shown}){
  if(!shown||shown.length!==glyphs.length)return glyphs.join("");
  return glyphRuns(glyphs,shown).map((run,index)=>run.hidden?<span key={index} className="changed-file-cut"><span>{run.text}</span></span>:<React.Fragment key={index}>{run.text}</React.Fragment>);
}
function ChangedFilePath({plan}){
  const ref=useRef(null),[fit,setFit]=useState(null),fonts=useFontRevision();
  useLayoutEffect(()=>{const element=ref.current;if(!element)return;const measure=()=>setFit(fitChangedPath(element,plan));measure();return observeResize(element,measure)},[plan,fonts]);
  const name=<bdi className={"changed-file-name"+(fit?" fitted":"")}><FittedText glyphs={plan.glyphs} shown={fit?.name}/></bdi>;
  if(!plan.dir)return <span className="changed-file-path split" ref={ref}>{name}</span>;
  return <span className="changed-file-path split" ref={ref}><bdi className={"changed-file-dir"+(plan.dirKeep!=null?" kept":"")}><FittedText glyphs={plan.dirGlyphs} shown={fit?.dir}/></bdi><span className="changed-file-sep">{plan.sep}</span>{name}</span>;
}

// An unsaved edit outlives the panel: another inspector tab, a closed panel or another environment unmounts it, and another project
// resets it. The edit is kept here by project, and the editor opens with it again when the Files view comes back to that project.
const keptEdits=new Map();
const hasUnsavedEdit=({file,edit,draft})=>Boolean(file&&edit&&draft!==(file.content??""));
// The editor hands its text back with "\n" line ends whatever the file had, so a file most of whose lines end in "\r\n" (a Windows
// file) is saved with "\r\n" again, and an edit to one line leaves the others' line ends as they were.
function fileLineEnds(text,original){const crlf=(original.match(/\r\n/g)||[]).length,breaks=(original.match(/\n/g)||[]).length;return crlf*2>breaks?text.replace(/\r?\n/g,"\r\n"):text}

// The inspector's Files and Diff tabs and this panel's Files | Changes switch are one choice, which the inspector holds (`tab`): the
// switch hands a choice to onTabChange, and the panel stays mounted across it, so an open file or a search survives the switch.
// Without a repository to diff (a general chat) the switch offers only Files, and a Diff tab carried over from a project says there is
// nothing to diff, as the Git and Context tabs do there. It is never handed back as Files: that would be a second step in the
// inspector's navigation history, and going back to the Diff step would hand it back again, so Back could never leave the chat.
export default function WorkspacePanel({projectPath,environmentId=null,remote=false,tab:requestedTab="files",onTabChange,allowDiff=true,activeThreadId=null,reviewedFiles=[],onReviewedChange,onAttachPath,onReviewComment}){
  const tab=requestedTab==="diff"?"diff":"files";
  const [entries,setEntries]=useState([]);
  const [query,setQuery]=useState("");
  const [searchResults,setSearchResults]=useState([]);
  // The query the results answer: a search with no match says so once its answer is in, not while it is still being read.
  const [searched,setSearched]=useState("");
  const [file,setFile]=useState(null);
  const [edit,setEdit]=useState(false);
  const [draft,setDraft]=useState("");
  const [conflict,setConflict]=useState(null);
  const [saving,setSaving]=useState(false);
  const liveEditRef=useRef(null);liveEditRef.current={file,edit,draft,conflict};
  const editKey=(environmentId||"")+"\n"+projectPath;
  const [diff,setDiff]=useState({status:"",diff:""});
  const [diffError,setDiffError]=useState("");
  // Whether a diff has been read for this project: until then the Diff tab says it is loading, never that the tree is clean.
  // Reads are numbered, and an answer lands unless a later read has already landed: refreshes that start faster than reads answer
  // (file changes streaming in during a turn) still show each answer as it comes, while an older answer never replaces a newer one.
  // A project change counts as a landed read, so an answer about the previous project is dropped.
  const [diffLoaded,setDiffLoaded]=useState(false);
  const diffRequestRef=useRef(0),diffShownRef=useRef(0);
  // The open file's reads are numbered too, and only the latest lands (see open).
  const openRequestRef=useRef(0),openPathRef=useRef(null);
  const [treeLoading,setTreeLoading]=useState(false);
  const [error,setError]=useState("");
  const [treeError,setTreeError]=useState("");
  const [searchError,setSearchError]=useState("");
  const [reviewError,setReviewError]=useState("");
  const [actionBusy,setActionBusy]=useState("");
  const [treeLimit,setTreeLimit]=useState(WORKSPACE_TREE_PAGE_SIZE);
  const [changedLimit,setChangedLimit]=useState(WORKSPACE_CHANGED_PAGE_SIZE);
  const [diffLimit,setDiffLimit]=useState(WORKSPACE_DIFF_CHUNK_CHARS);
  const [wrapDiff,setWrapDiff]=useState(readDiffWrap);
  function toggleDiffWrap(){setWrapDiff(value=>{const next=!value;try{localStorage.setItem(DIFF_WRAP_KEY,String(next))}catch{}return next})}
  function params(values={}){
    const query=new URLSearchParams(values);
    query.set("environmentId",environmentId||"");
    return query.toString();
  }

  async function refreshTree(){
    if(!projectPath)return;setTreeLoading(true);setTreeError("");
    try{
      const data=await api("/api/workspace/tree?"+params({path:projectPath}));
      setEntries(data.entries||[]);
    }catch(err){setTreeError(actionError("Could not refresh workspace files",err))}
    finally{setTreeLoading(false)}
  }
  // diffError keeps the server's reason: the empty state already titles it "Could not load changes", and the banner over a
  // shown diff names the refresh that failed.
  async function refreshDiff(){
    if(!projectPath)return;
    const request=++diffRequestRef.current;setDiffError("");
    const lands=()=>{if(request<=diffShownRef.current)return false;diffShownRef.current=request;return true};
    try{
      const data=await api("/api/workspace/diff?"+params({path:projectPath}));
      if(lands()){setDiff(data);setDiffError(data.error||"");setDiffLoaded(true)}
    }catch(error){if(lands())setDiffError(String(error?.message??error??"").trim()||"No reason was given.")}
  }
  useEffect(()=>{diffShownRef.current=diffRequestRef.current;setDiff({status:"",diff:""});setDiffError("");setDiffLoaded(false);setTreeLimit(WORKSPACE_TREE_PAGE_SIZE);setChangedLimit(WORKSPACE_CHANGED_PAGE_SIZE);setDiffLimit(WORKSPACE_DIFF_CHUNK_CHARS);refreshTree();refreshDiff();openRequestRef.current++;setFile(null);setEdit(false);setConflict(null);setError("");
    const kept=keptEdits.get(editKey);
    if(kept){openPathRef.current=kept.file.path;setFile(kept.file);setDraft(kept.draft);setEdit(true);setConflict(kept.conflict)}
    // The cleanup React runs right after the first run in development sees no file yet, so it leaves a kept edit as it is.
    return()=>{const live=liveEditRef.current;if(hasUnsavedEdit(live))keptEdits.set(editKey,live);else if(live.file)keptEdits.delete(editKey)};
  },[projectPath,environmentId]);
  // Opening the Changes view, from either switch, reads the working tree again; the last answer stays on screen meanwhile.
  const shownTabRef=useRef(tab);
  useEffect(()=>{const previous=shownTabRef.current;shownTabRef.current=tab;if(tab==="diff"&&previous!=="diff"&&allowDiff)refreshDiff()},[tab]);
  useEffect(()=>{setTreeLimit(WORKSPACE_TREE_PAGE_SIZE)},[query]);
  useEffect(()=>{
    let timer=null;
    const changed=event=>{
      const message=event.detail||{},params=message.params||{};
      const fileChange=message.method==="item/fileChange/outputDelta"||message.method==="item/fileChange/patchUpdated"||(message.method==="item/completed"&&params.item?.type==="fileChange");
      const settled=message.method==="turn/diff/updated"||message.method==="turn/completed";
      if(!fileChange&&!settled)return;
      if(activeThreadId&&params.threadId&&params.threadId!==activeThreadId)return;
      if(!activeThreadId&&params.threadId)return;
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>{
        refreshTree();
        if(allowDiff)refreshDiff();
        if(file?.path&&!edit)open(openPathRef.current);
      },120);
    };
    window.addEventListener("trebell:rpc-notification",changed);
    return()=>{if(timer)clearTimeout(timer);window.removeEventListener("trebell:rpc-notification",changed)};
  },[activeThreadId,projectPath,environmentId,allowDiff,file?.path,edit]);

  useEffect(()=>{
    if(!query.trim()){setSearchResults([]);setSearchError("");return;}
    const t=setTimeout(async()=>{
      try{
        const data=await api("/api/workspace/search?"+params({path:projectPath,q:query}));
        setSearchResults(data.items||[]);setSearched(query);setSearchError("");
      }catch(err){setSearchResults([]);setSearchError(actionError("Could not search workspace files",err))}
    },180);
    return()=>clearTimeout(t);
  },[query,projectPath,environmentId]);

  // Unsaved edits are never dropped unasked: opening a file or closing the editor asks first, and Escape keeps them; a closed editor
  // reads the file again, so a change made on disk meanwhile shows. A save names the version the editor loaded, so the server
  // refuses one over a file that changed on disk since (an agent's edit, a delete); the panel then keeps the edits and offers the
  // file on disk (Reload from disk) or the edits saved over the version it found. Only the latest read lands: one still on its way
  // when the person opens another file, starts editing or changes project is dropped, so it never closes the editor or replaces
  // what is typed (a save made from the text shown then finds any change on disk). Refresh and an agent's change read again the
  // file last asked for, never the one it is taking the place of.
  const unsaved=hasUnsavedEdit({file,edit,draft});
  async function keepUnsaved(){return unsaved&&!await askConfirm("Discard your changes to "+file.name+"?",{confirm:"Discard changes",cancel:"Keep editing"})}
  async function open(path,{discard=false}={}){
    if(!discard&&await keepUnsaved())return;
    const request=++openRequestRef.current,latest=()=>request===openRequestRef.current;openPathRef.current=path;
    setError("");setConflict(null);
    const name=String(path).split(/[\\/]/).pop()||path;
    const kind=previewKind(name),media=["image","video","audio","pdf"].includes(kind);
    try{
      // A picture, video, sound or PDF shows from its raw address: only its first byte is read there, so one that is gone says so as
      // a text file does.
      const data=media?await api("/api/workspace/raw?"+params({root:projectPath,path}),{headers:{range:"bytes=0-0"}}).then(()=>({path,name,content:null})):await api("/api/workspace/file?"+params({root:projectPath,path}));
      if(!latest())return;
      // Binary content is never text in the viewer, whatever the file's extension says it is.
      setFile({...data,kind:data.binary?"binary":kind});setDraft(data.content??"");setEdit(false);
    }catch(err){
      if(!latest())return;
      // The file that failed takes the view, with why, so the file shown before (and its Edit) never sits under another file's error.
      // Only a file too large to preview is there to attach; one that could not be read (gone, outside the project) offers nothing.
      setFile({path,name,kind:"unsupported",content:null,unreadable:!/too large to preview/i.test(err?.message||"")});setDraft("");setEdit(false);
      setError(actionErrorUnlessNamed("Could not open "+name,err,/ was not found$/));
    }
  }
  // One save at a time: Save is busy until the answer comes, so a second press never sends the version the first one replaced,
  // which the server would refuse as a change on disk. Text typed while it was on its way stays in the editor, unsaved, over the
  // version saved. An answer that comes after the person opened another file or project stays out of the view; an edit kept for
  // its project is then saved, or holds the version saved under what was typed since.
  async function save(version=file.version){
    if(saving)return;
    const request=openRequestRef.current,path=file.path,sent=draft;setError("");setSaving(true);
    try{
      const data=await api("/api/workspace/file",{method:"PUT",body:{root:projectPath,path,content:fileLineEnds(sent,file.content??""),version,environmentId}});
      const saved={...data,kind:previewKind(data.name)};
      if(request!==openRequestRef.current){const kept=keptEdits.get(editKey);if(kept?.file.path===path){if(kept.draft===sent)keptEdits.delete(editKey);else keptEdits.set(editKey,{...kept,file:saved,conflict:null})}return}
      setConflict(null);setFile(saved);if(liveEditRef.current.draft===sent){setDraft(data.content);setEdit(false)}refreshDiff();
    }catch(err){
      if(request!==openRequestRef.current)return;
      if(err.status===409)setConflict({message:err.message,version:err.data?.version??null});
      else setError(actionError("Could not save "+(file?.name||"the file"),err));
    }finally{setSaving(false)}
  }
  async function changeReviewed(path,value){
    if(!onReviewedChange||actionBusy)return;
    setActionBusy("reviewed:"+path);setReviewError("");
    try{await Promise.resolve(onReviewedChange(path,value))}
    catch(err){setReviewError(actionError("Could not update reviewed state",err))}
    finally{setActionBusy("")}
  }
  async function addReviewComment(path){
    const comment=await askText("Review comment for "+path,"",{multiline:true});if(!comment?.trim()||!onReviewComment||actionBusy)return;
    setActionBusy("comment:"+path);setReviewError("");
    try{await Promise.resolve(onReviewComment(path,comment.trim()))}
    catch(err){setReviewError(actionError("Could not attach review comment",err))}
    finally{setActionBusy("")}
  }
  // null: no grammar for this file type, so the text is rendered as text (React escapes it) with no token colors.
  const highlighted=useMemo(()=>highlightSyntax(file?.content,file?.name),[file]);
  // Paths are unquoted here, so the list, review comments and reviewed state all name the file itself (New folder/, not git's "New folder/").
  const changes=useMemo(()=>String(diff.status||"").split(/\r?\n/).filter(Boolean).map(gitStatusEntry),[diff.status]);
  const changedPaths=useMemo(()=>changes.map(change=>change.path),[changes]);
  const changedBadges=useMemo(()=>new Map(changes.map(change=>[change.path,gitStatusBadge(change.code)])),[changes]);
  // Each name's cut is worked out against every changed path, shown or not, so it keeps what tells it apart from all of them.
  const changedPlans=useMemo(()=>{const plans=changedPathPlans(changedPaths);return new Map(changedPaths.map((path,index)=>[path,plans[index]]))},[changedPaths]);
  const diffPanelError=[diffError&&actionError("Could not refresh the diff",diffError),reviewError].filter(Boolean).join(" · ");
  // A query of only spaces searches for nothing (see the search effect), so the tree shows.
  const searching=Boolean(query.trim()),source=searching?searchResults:entries;
  const treeWindow=useMemo(()=>searching?{visible:source,total:source.length,shown:source.length,hasMore:false,nextCount:0}:workspaceListWindow(source,{limit:treeLimit,pageSize:WORKSPACE_TREE_PAGE_SIZE}),[source,searching,treeLimit]);
  const changedWindow=useMemo(()=>workspaceListWindow(changedPaths,{limit:changedLimit,pageSize:WORKSPACE_CHANGED_PAGE_SIZE}),[changedPaths,changedLimit]);
  const diffWindow=useMemo(()=>workspaceTextWindow(diff.diff||diff.error||"No unstaged diff.",{limit:diffLimit,chunkSize:WORKSPACE_DIFF_CHUNK_CHARS}),[diff.diff,diff.error,diffLimit]);
  // One span per line keeps the text (and its textContent) identical while each line gets its own diff color.
  const diffLines=useMemo(()=>{const lines=diffWindow.text.split("\n"),kinds=diffLineKinds(lines);return lines.map((line,index)=><span key={index} className={"diff-line "+kinds[index]}>{line}{index<lines.length-1?"\n":""}</span>)},[diffWindow.text]);
  const rawUrl=file&&projectPath?"/api/workspace/raw?"+params({root:projectPath,path:file.path}):"";
  const table=useMemo(()=>file?.kind==="table"?parseDelimited(file.content,extension(file.name)==="tsv"?"\t":","):[],[file]);

  function preview(){
    if(!file)return <div className="file-empty">Select a file to inspect it.</div>;
    // Ctrl+S (Cmd+S) saves, as in any editor, as Save does.
    if(edit)return <textarea className="file-editor" value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s"){e.preventDefault();if(!saving)save()}}}/>;
    if(file.kind==="image")return <div className="media-preview image"><img src={rawUrl} alt={file.name}/></div>;
    if(file.kind==="video")return <div className="media-preview"><video src={rawUrl} controls preload="metadata"/></div>;
    if(file.kind==="audio")return <div className="media-preview audio"><Music2 size={34}/><audio src={rawUrl} controls preload="metadata"/></div>;
    if(file.kind==="pdf")return <div className="document-preview"><iframe title={file.name} src={rawUrl}/></div>;
    if(file.kind==="html")return <div className="document-preview"><iframe title={file.name} src={rawUrl} sandbox="" referrerPolicy="no-referrer"/></div>;
    if(file.kind==="markdown")return <MarkdownPreview content={file.content}/>;
    if(file.kind==="table")return <div className="table-preview"><table><tbody>{table.map((row,rowIndex)=><tr key={rowIndex}>{row.map((cell,colIndex)=>rowIndex===0?<th key={colIndex}>{cell}</th>:<td key={colIndex}>{cell}</td>)}</tr>)}</tbody></table>{table.length>=300&&<p>Preview limited to 300 rows.</p>}</div>;
    if(file.kind==="binary")return <div className="file-empty"><strong>Binary file</strong><span>{formatBytes(file.size)} · not shown as text</span></div>;
    if(file.kind==="unsupported")return <div className="file-empty"><strong>Preview unavailable</strong><span role="alert">{error||"This file is too large for the text editor."}</span>{!file.unreadable&&<button onClick={()=>onAttachPath?.(file.path)}><Paperclip size={13}/> Attach to chat</button>}</div>;
    return <pre className="syntax-view">{highlighted==null?<code>{file.content}</code>:<code dangerouslySetInnerHTML={{__html:highlighted}}/>}</pre>;
  }

  const editable=Boolean(file&&["text","html","markdown","table"].includes(file.kind));
  return <div className="workspace-panel">
    <div className="panel-tabs"><div className="workspace-seg"><button className={tab==="files"?"active":""} onClick={()=>onTabChange?.("files")}>Files</button>{allowDiff&&<button className={tab==="diff"?"active":""} onClick={()=>tab==="diff"?refreshDiff():onTabChange?.("diff")}>Changes {changedPaths.length?"("+changedPaths.length+")":""}</button>}</div>{tab==="diff"&&allowDiff&&changedPaths.length>0&&<button className={"workspace-refresh workspace-wrap"+(wrapDiff?" active":"")} aria-pressed={wrapDiff} aria-label={wrapDiff?"Disable diff line wrapping":"Enable diff line wrapping"} title={wrapDiff?"Disable line wrapping":"Enable line wrapping"} onClick={toggleDiffWrap}><WrapText size={13}/></button>}<button className="workspace-refresh" aria-label="Refresh workspace files" title="Refresh files and changes" onClick={()=>{refreshTree();if(allowDiff)refreshDiff();if(file&&!edit)open(openPathRef.current)}}><RefreshCw size={13}/></button></div>
    {tab==="files"&&<div className="workspace-files">
      <div className="workspace-search"><Search size={14}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search files…"/></div>
      <div className="workspace-body">
        <div className="tree-list">{(searchError||treeError)&&<p className="workspace-tree-error" role="alert">{searchError||treeError}</p>}{query.trim()&&searched===query&&!searchError&&!searchResults.length&&<p>No files match “{query.trim()}”.</p>}{treeLoading?<p>Loading…</p>:treeWindow.visible.map(entry=><div className="tree-row" key={entry.path}>{entry.isFile?<button data-workspace-entry className={"tree-file"+(file?.path===entry.path?" active":"")} title={entry.relativePath||entry.name} style={{paddingLeft:8+(entry.depth||0)*14}} onClick={()=>open(entry.path)}>{fileIcon(entry.name)}<span>{treeLabel(entry,searching)}</span></button>:<div data-workspace-entry className="tree-dir" title={entry.relativePath||entry.name} style={{paddingLeft:8+(entry.depth||0)*14}}>{entry.isDirectory?<Folder size={14}/>:fileIcon(entry.name)}<span>{treeLabel(entry,searching)}</span></div>}{entry.isFile&&!(file?.unreadable&&file.path===entry.path)&&<button className="tree-attach" aria-label={"Attach "+(entry.relativePath||entry.name)+" to chat"} title="Attach to chat" onClick={()=>onAttachPath?.(entry.path)}><Paperclip size={11}/></button>}</div>)}{treeWindow.hasMore&&<div className="workspace-window-footer"><button onClick={()=>setTreeLimit(limit=>limit+WORKSPACE_TREE_PAGE_SIZE)}>Show {treeWindow.nextCount} more files</button><span>{treeWindow.shown} of {treeWindow.total} shown</span></div>}</div>
        <div className={"file-view"+(error||conflict?" has-error":"")}>{file&&<div className="file-head"><strong>{file.name}</strong><div>{!remote&&<OpenInPicker path={file.path} compact/>}{!file.unreadable&&<button onClick={()=>onAttachPath?.(file.path)}><Paperclip size={13}/> Attach</button>}{editable&&<button onClick={async()=>{if(!edit){openRequestRef.current++;openPathRef.current=file.path;setError("");setEdit(true);return}if(await keepUnsaved())return;setEdit(false);setDraft(file.content??"");open(file.path,{discard:true})}}>{edit?<X size={13}/>:<FileCode2 size={13}/>} {edit?"Cancel":"Edit"}</button>}{edit&&<button onClick={()=>save()} disabled={saving} aria-busy={saving||undefined}><Save size={13}/> Save</button>}</div></div>}{error&&file?.kind!=="unsupported"&&<div className="workspace-file-error" role="alert">{error}</div>}{conflict&&<div className="workspace-file-error workspace-file-conflict" role="alert"><span>{conflict.message} Reload from disk drops your edits; Overwrite saves yours in its place.</span><div><button onClick={()=>open(file.path,{discard:true})}>Reload from disk</button><button onClick={()=>save(conflict.version)} disabled={saving}>Overwrite</button></div></div>}{preview()}</div>
      </div>
    </div>}
    {tab==="diff"&&!allowDiff&&<div className="changes-empty"><FileDiff size={20}/><strong>No repository changes</strong><span>General chats are not attached to a repository, so there is nothing to diff.</span></div>}
    {tab==="diff"&&allowDiff&&(changedPaths.length?<div className={"changes-view"+(diffPanelError?" has-action-error":"")}>
      {diffPanelError&&<div className="inline-error workspace-diff-error" role="alert">{diffPanelError}</div>}
      <div className="changed-files">{changedWindow.visible.map(path=><div className={reviewedFiles.includes(path)?"changed-file-row reviewed":"changed-file-row"} key={path}><button onClick={()=>changeReviewed(path,!reviewedFiles.includes(path))} disabled={actionBusy==="reviewed:"+path} aria-label={path} title={path+(reviewedFiles.includes(path)?" · reviewed. Click to mark as not reviewed":" · click to mark as reviewed")}><span>{reviewedFiles.includes(path)?<Check size={12}/>:<FileDiff size={12}/>}</span><ChangedFilePath plan={changedPlans.get(path)}/></button><em className="changed-file-code" data-kind={changedBadges.get(path)?.kind} title={changedBadges.get(path)?.title}>{changedBadges.get(path)?.label}</em><button className="review-comment" title="Add review comment as context" onClick={()=>addReviewComment(path)} disabled={actionBusy==="comment:"+path}>+</button></div>)}{changedWindow.hasMore&&<div className="workspace-window-footer"><button onClick={()=>setChangedLimit(limit=>limit+WORKSPACE_CHANGED_PAGE_SIZE)}>Show {changedWindow.nextCount} more changed files</button><span>{changedWindow.shown} of {changedWindow.total} shown</span></div>}</div>
      <div className="workspace-diff-preview"><pre className={"git-diff"+(wrapDiff?" wrap":"")} data-testid="workspace-diff-preview">{diffLines}</pre>{diffWindow.hasMore&&<div className="workspace-window-footer"><button onClick={()=>setDiffLimit(limit=>limit+WORKSPACE_DIFF_CHUNK_CHARS)}>Show more diff</button><span>{Math.round(diffWindow.shown/1000)}k of {Math.round(diffWindow.total/1000)}k characters shown</span></div>}</div>
    </div>:(diffError||diff.error)?<div className="changes-empty error"><FileDiff size={20}/><strong>Could not load changes</strong><span>{diffError||diff.error}</span></div>
      :!projectPath?<div className="changes-empty"><FileDiff size={20}/><strong>No project open</strong><span>Open a project to review its changes.</span></div>
      :!diffLoaded?<div className="changes-loading" role="status" aria-busy="true"><LoaderCircle size={18} aria-hidden="true"/><strong>Loading changes…</strong></div>
      :<div className="changes-empty"><FileDiff size={20}/><strong>Working tree clean</strong><span>No unstaged changes to review.</span></div>)}
  </div>;
}
