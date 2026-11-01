// The line every harness's prompt names an attached file by (src/attachment-line.mjs), and reading it back: the present wording
// and the earlier shape that older Codex threads hold.
import test from "node:test";
import assert from "node:assert/strict";
import { attachedPathOf, attachmentLine, readableTextNote, unsentImageLine } from "../src/attachment-line.mjs";
import { openCode2PromptInput } from "../src/opencode2-agent-session.mjs";
import { PROMPT_IMAGE_PATH, PROMPT_TEXT_PATH, linkedFileLine } from "../src/prompt-attachments.mjs";

test("an attachment's line names its kind, its shown name and the path of the file Trebell keeps, a document's also its text file",()=>{
  assert.equal(attachmentLine("image","shot.png","H:/a/shot.png"),'[Image attachment "shot.png" at H:/a/shot.png]');
  assert.equal(attachmentLine("file","notes.md","/home/me/notes.md"),'[File attachment "notes.md" at /home/me/notes.md]');
  assert.equal(attachmentLine("audio","memo 1.mp3","/r/memo 1.mp3"),'[Audio attachment "memo 1.mp3" at /r/memo 1.mp3]');
  assert.equal(attachmentLine("video","clip.mp4","/r/clip.mp4"),'[Video attachment "clip.mp4" at /r/clip.mp4]');
  assert.equal(attachmentLine("folder","x","/r/x"),'[File attachment "x" at /r/x]',"a kind Trebell does not name reads as a file");
  assert.equal(attachmentLine("toString","x","/r/x"),'[File attachment "x" at /r/x]',"nor does a name an object inherits");
  assert.equal(attachmentLine("file","report.docx","C:\\w\\report.docx","C:\\t\\report.docx.txt"),'[File attachment "report.docx" at C:\\w\\report.docx, readable as text at C:\\t\\report.docx.txt]');
  assert.equal(attachmentLine("file","a.txt","C:\\a.txt",""),'[File attachment "a.txt" at C:\\a.txt]',"no text file, no note");
  // The shown name stays inside its quotes and on one line; the path is written exactly as it is, since the agent opens it.
  assert.equal(attachmentLine("file",'say "hi"\r\nnow','/odd/"q" [1].txt'),'[File attachment "say \'hi\'  now" at /odd/"q" [1].txt]');
  assert.equal(readableTextNote("/t/a.txt"),", readable as text at /t/a.txt");
  assert.equal(readableTextNote(null),"");
});

test("an image with no saved file is named as not sent, with its name when it has one",()=>{
  assert.equal(unsentImageLine(),"[Image attachment not sent: Trebell Code has no saved copy of it]");
  assert.equal(unsentImageLine("paste.png"),'[Image attachment "paste.png" not sent: Trebell Code has no saved copy of it]');
});

test("a line is read back as the path it names, in the present wording",()=>{
  for(const [line,path] of [
    ['[Image attachment "shot.png" at H:/a/shot.png]',"H:/a/shot.png"],
    ['[Audio attachment "m.mp3" at /r/m.mp3]',"/r/m.mp3"],
    ['[File attachment "r.docx" at C:\\w, x\\r.docx, readable as text at C:\\t\\r.docx.txt]',"C:\\w, x\\r.docx"],
    ['[File attachment "" at /r/unnamed]',"/r/unnamed"],
    ['[File attachment "a" at /r/a, readable as text at ]',"/r/a, readable as text at "],
    ['[Video attachment "clip.mp4" at relative clip.mp4]',"relative clip.mp4","the present line gives its path whatever it is"],
  ])assert.equal(attachedPathOf(line),path,line);
  // Anything else is no attachment line: the person's own text keeps it.
  for(const line of [
    "",'Image attachment "shot.png" at H:/a/shot.png','[Image attachment "shot.png" at H:/a/shot.png] ','[Picture attachment "x" at /x]',
    '[Image attachment "shot.png" at ]','[Image attachment shot.png at /x]','[Image attachment "a" "b" at /x]','[Image attachment "x" at /a\n/b]',
    '[Image attachment "x" at /a\r]',"[Image attachment not sent: Trebell Code has no saved copy of it]",
    '[Image attachment "paste.png" not sent: Trebell Code has no saved copy of it]',
  ])assert.equal(attachedPathOf(line),null,JSON.stringify(line));
});

// Earlier releases wrote another line, whose words Trebell no longer keeps: a label, the file's shown name in quotes, a few words
// up to a colon and a space, the path, and for a document a note in brackets naming its text file. The lines here have that shape
// in Trebell's own made-up words. The quoted name is always how Trebell shows the path's file, which tells the line from text.
test("a line of the earlier shape is read back as its path when its quoted name is its file's shown name",()=>{
  for(const [line,path] of [
    ['[Older image "shot.png" kept here: H:/a/shot.png]',"H:/a/shot.png"],
    ['[Older file "r.docx" kept here: C:\\w (1)\\r.docx (its text: C:\\t\\r.docx.txt)]',"C:\\w (1)\\r.docx"],
    ['[Older file "r.docx" kept here: /w (draft: 2)/r.docx (its text: /t/r.docx.txt)]',"/w (draft: 2)/r.docx","a bracket in the path is tried and passed over"],
    ['[Older file "x (copy: 1)" kept here: /a/x (copy: 1)]',"/a/x (copy: 1)","a name that ends like a note is the file's own"],
    ['[Older file "notes.txt" kept here: /home/me/odd: name/notes.txt]',"/home/me/odd: name/notes.txt"],
    // Trebell saves an upload or a paste as <time>-<id>-<name> and shows it by its name.
    ['[Older image "shot.png" kept here: C:\\Users\\me\\.trebell\\attachments\\1767000000000-0a1b2c3d-shot.png]',"C:\\Users\\me\\.trebell\\attachments\\1767000000000-0a1b2c3d-shot.png"],
    ['[Older file "1767000000000-0a1b2c3d-a.txt" kept here: /t/1767000000000-0a1b2c3d-a.txt]',"/t/1767000000000-0a1b2c3d-a.txt"],
    ['[Older file "notes.md" kept here: project/.trebell/attachments/1767000000000-0A1B2C3D-notes.md]',"project/.trebell/attachments/1767000000000-0A1B2C3D-notes.md"],
  ])assert.equal(attachedPathOf(line),path,line);
  for(const line of [
    '[Older file "notes.txt" kept here: /home/me/other.txt]','[Older file "notes.txt" kept here: notes.txt]',
    '[Older file "x" kept here: https://example.com/x]','[Older file "x" kept here: ]','[Older file "x" kept here /a/x]',
    '[Older 2 file "x" kept here: /a/x]','[Older file  "x" kept here: /a/x]','[Older file "x"kept here: /a/x]',
    '[Older file "a"b" kept here: /a/a"b]','[Older file "x" kept here: /a/x (its text: /t/x.txt) ]','[Older file "x.txt" kept here: /a/0-0a1b2c3-x.txt]',
    '["x" kept here: /a/x]','[Older file "" kept here: /a/]',
    // A note with no text file was never written; the path would then end in the note, which is not the file's name.
    '[Older file "a" kept here: /r/a (its text: )]',
  ])assert.equal(attachedPathOf(line),null,JSON.stringify(line));
});

// Re-pinned: Claude Code and Muse Code had a line of their own ("Attached file: <path>", then the note); they now get the attachment
// line every other harness gets.
test("Claude Code's and Muse Code's line for a linked file is Trebell's attachment line, a document's with its text file",()=>{
  const link=Object.defineProperty({type:"resource_link",uri:"file:///w/r.docx",name:"r.docx"},PROMPT_TEXT_PATH,{value:"/t/r.docx.txt"});
  assert.equal(linkedFileLine(link),'[File attachment "r.docx" at /w/r.docx, readable as text at /t/r.docx.txt]');
  assert.equal(linkedFileLine({type:"resource_link",uri:"file:///w/n.md",name:"n.md"}),'[File attachment "n.md" at /w/n.md]');
  // With no name of its own, the file is named as the composer shows it (without the saved copy's time and id).
  assert.equal(linkedFileLine({type:"resource_link",uri:"file:///h/.trebell/attachments/1761000000-abcdef12-plan.md"}),'[File attachment "plan.md" at /h/.trebell/attachments/1761000000-abcdef12-plan.md]');
  // A link that is not a file: URI keeps its address as the path.
  assert.equal(linkedFileLine({type:"resource_link",uri:"untitled:notes"}),'[File attachment "untitled:notes" at untitled:notes]');
  assert.equal(attachedPathOf(linkedFileLine({type:"resource_link",uri:"file:///w/n.md",name:"n.md"})),"/w/n.md","the line reads back as the path it names");
});

test("OpenCode 2 names a pasted image it has no file of as not sent, and a link to no file by its address",async()=>{
  const pasted={type:"image",mimeType:"image/png",data:"iVBO",name:"paste.png"};
  const unnamed={type:"image",mimeType:"image/png",data:"iVBO"};
  const remote={type:"resource_link",uri:"https://example.com/spec.pdf",name:"spec.pdf"};
  const saved=Object.defineProperty({type:"image",mimeType:"image/png",data:"iVBO"},PROMPT_IMAGE_PATH,{value:"/gone/shot.png"});
  assert.deepEqual(await openCode2PromptInput([{type:"text",text:"Look"},pasted,unnamed,remote,saved],{external:true}),{
    text:[
      "Look",
      '[Image attachment "paste.png" not sent: Trebell Code has no saved copy of it]',
      '[Image attachment "image" not sent: Trebell Code has no saved copy of it]',
      '[File attachment "spec.pdf" at https://example.com/spec.pdf]',
      '[Image attachment "shot.png" at /gone/shot.png]',
    ].join("\n"),
    files:[],
  });
});
