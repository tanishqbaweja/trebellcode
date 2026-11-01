// The line a prompt names an attached file by, for every harness: Codex (the window's codex-turn-options.js), the agent relay and
// the ACP and OpenCode sessions. Most harnesses open an attachment with their own tools, so the line gives the path of the file
// Trebell saved, exactly as it is, and for a document also the file holding its extracted text (document-text.mjs). The window
// bundles this module too, so it imports nothing.
//
//   [Image attachment "shot.png" at C:\Users\me\.trebell\attachments\shot.png]
//   [File attachment "report.docx" at /home/me/report.docx, readable as text at /home/me/.trebell/attachments/report.docx.txt]

const KIND_WORDS=Object.freeze({image:"Image",file:"File",audio:"Audio",video:"Video"});
const TEXT_FILE_NOTE=", readable as text at ";
const NOT_SENT=" not sent: Trebell Code has no saved copy of it";

// A shown name stays inside its quotes and on one line: a double quote reads as a single one and a line break as a space.
function shownName(name){
  let shown="";
  for(const character of String(name??""))shown+=character==='"'?"'":character==="\n"||character==="\r"?" ":character;
  return shown;
}

// What a line adds after a document's path when Trebell has the document's text in a file of its own, else nothing.
export function readableTextNote(textFile){
  return textFile?TEXT_FILE_NOTE+String(textFile):"";
}

// kind: image, file, audio or video (anything else reads as a file). textFile: a document's extracted text, or nothing.
export function attachmentLine(kind,name,path,textFile=null){
  const word=Object.hasOwn(KIND_WORDS,kind)?KIND_WORDS[kind]:KIND_WORDS.file;
  return `[${word} attachment "${shownName(name)}" at ${String(path??"")}${readableTextNote(textFile)}]`;
}

// An image the message carried but that Trebell has no saved file of, so the harness gets neither the image nor a path.
export function unsentImageLine(name=""){
  return `[Image attachment${name?` "${shownName(name)}"`:""}${NOT_SENT}]`;
}

// ---- Reading a line back (a Codex thread's own record of a message, a queued Codex follow-up)

// The path a line names, or null for any other line (one with a line break in it among them): the line attachmentLine writes,
// else the one Trebell wrote for Codex before it (earlierLinePath).
export function attachedPathOf(line){
  const text=String(line??"");
  if(text.length<2||!text.startsWith("[")||!text.endsWith("]")||/[\r\n]/.test(text))return null;
  const inside=text.slice(1,-1);
  return presentLinePath(inside)??earlierLinePath(inside);
}

// Inside a line attachmentLine writes: the kind word, ` attachment "`, the shown name, `" at `, the path, and for a document the
// note and its text file. The path is what comes before the note when the note names a file, else all of it.
const KINDS_WRITTEN=new Set(Object.values(KIND_WORDS));
const NAME_OPENS=' attachment "',PATH_OPENS='" at ';
function presentLinePath(inside){
  const opens=inside.indexOf(NAME_OPENS);
  if(!KINDS_WRITTEN.has(inside.slice(0,opens<0?0:opens)))return null;
  const closes=inside.indexOf('"',opens+NAME_OPENS.length);
  if(closes<0||!inside.startsWith(PATH_OPENS,closes))return null;
  const rest=inside.slice(closes+PATH_OPENS.length),note=rest.indexOf(TEXT_FILE_NOTE);
  const path=note>0&&rest.length>note+TEXT_FILE_NOTE.length?rest.slice(0,note):rest;
  return path===""?null:path;
}

// Threads and queued follow-ups from earlier releases hold the line those releases wrote. Trebell does not keep its words; it reads
// the line by its shape and by Trebell's own naming of the file: a label of words, the file's shown name in double quotes, a few
// words up to a colon and a space, the path, and for a document a note in brackets, (words: text file), at the very end. In every
// such line the quoted name is how Trebell shows the path's file (namesFile), and that is what tells it from the person's text.
const WORDS="[A-Za-z]+(?: [A-Za-z]+)*";
const LABEL=new RegExp(`^${WORDS} "`),LINK=new RegExp(`^${WORDS}: `),NOTE=new RegExp(`^ \\(${WORDS}: .+\\)$`);
function earlierLinePath(inside){
  const label=LABEL.exec(inside);if(!label)return null;
  const closes=inside.indexOf('"',label[0].length);
  if(closes<0||inside[closes+1]!==" ")return null;
  const name=inside.slice(label[0].length,closes),afterName=inside.slice(closes+2),link=LINK.exec(afterName);
  if(!link)return null;
  const rest=afterName.slice(link[0].length);
  // A note can open only at " (" with the rest of the line its shape; each such place is tried from the left, then no note.
  for(let at=rest.indexOf(" (");at>=0;at=rest.indexOf(" (",at+1)){
    if(NOTE.test(rest.slice(at))&&namesFile(rest.slice(0,at),name))return rest.slice(0,at);
  }
  return namesFile(rest,name)?rest:null;
}

// Whether name is how Trebell shows the file at path: the path's last part, or that part without the time and short id Trebell
// puts before the name of a file it saves ("<digits>-<8 hex digits>-<name>"). A path counts only with a folder in it and not as a
// link, and the name only when it has a character, since a saved file has all three.
const SAVED_NAME=/^\d+-[0-9A-Fa-f]{8}-(.+)$/;
function namesFile(path,name){
  if(!name||!/[\\/]/.test(path)||path.includes("://"))return false;
  const last=path.slice(Math.max(path.lastIndexOf("/"),path.lastIndexOf("\\"))+1);
  return last===name||SAVED_NAME.exec(last)?.[1]===name;
}
