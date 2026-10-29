import { test,expect } from "@playwright/test";
import { join } from "node:path";
import { openCode1App,send,shots,stopButton } from "./opencode-relay-app.js";

// An OpenCode read as a person sees it: OpenCode's read tool wraps what it read in XML tags (<path>, <type>, <content> or <entries>),
// which the read's row showed around the file's lines. Every read's row was titled "Read file", a folder's too, and opened to the
// item's JSON, the lines one escaped string in it. These are OpenCode 1.18.32's own outputs for a file and a folder (with the folder's
// instructions OpenCode adds after it), recorded live, and a file whose line holds a tag. The real relay and OpenCode 1.x session run
// against a fake OpenCode 1.x server (tests/fixtures/fake-opencode1-server.mjs).
const FILE_READ="<path>H:\\work\\notes.txt</path>\n<type>file</type>\n<content>\n1: alpha line\n2: beta line\n\n(End of file - total 2 lines)\n</content>";
const FOLDER_READ="<path>H:\\work\\src</path>\n<type>directory</type>\n<entries>\nindex.js\nparser/\nutil.js\n\n(3 entries)\n</entries>\n\n<system-reminder>\nInstructions from: H:\\work\\src\\AGENTS.md\nKeep functions small.\n</system-reminder>";
const TAG_READ="<path>H:\\work\\todo.md</path>\n<type>file</type>\n<content>\n1: - ship it\n2: </content> is literal here\n\n(End of file - total 2 lines)\n</content>\n\nThis file was read in part: it changed while it was read.";
// A file deep in a folder outside the thread's: its title, the whole path, is longer than its row, which cuts it at the end, the file name.
const LONG="H:\\archive\\2026\\quarterly-reports\\finance\\regional\\north-east\\board-meetings\\summaries\\q3-board-pack-final-reviewed.md";
const LONG_READ=`<path>${LONG}</path>\n<type>file</type>\n<content>\n1: Q3 revenue rose 4%.\n\n(End of file - total 1 lines)\n</content>`;
const LINES=["1: alpha line\n2: beta line\n\n(End of file - total 2 lines)","index.js\nparser/\nutil.js\n\n(3 entries)\n\n<system-reminder>\nInstructions from: H:\\work\\src\\AGENTS.md\nKeep functions small.\n</system-reminder>","1: - ship it\n2: </content> is literal here\n\n(End of file - total 2 lines)\n\nThis file was read in part: it changed while it was read.","1: Q3 revenue rose 4%.\n\n(End of file - total 1 lines)"];

test("an OpenCode read's row names what it read and opens to the file's lines or the folder's entries, without OpenCode's XML tags",async({page})=>{
  test.setTimeout(120_000);
  let release=()=>{},folder="";const finish=new Promise(resolve=>{release=resolve});
  await openCode1App(page,async({part})=>{
    // A file and a folder in the thread's folder, and a file outside it.
    part({type:"tool",tool:"read",callID:"call_file",state:{status:"completed",input:{filePath:join(folder,"notes.txt")},output:FILE_READ,title:"notes.txt",metadata:{},time:{start:1,end:2}}});
    part({type:"tool",tool:"read",callID:"call_folder",state:{status:"completed",input:{filePath:join(folder,"src")},output:FOLDER_READ,title:"src",metadata:{},time:{start:3,end:4}}});
    part({type:"tool",tool:"read",callID:"call_outside",state:{status:"completed",input:{filePath:"H:\\work\\todo.md"},output:TAG_READ,title:"todo.md",metadata:{},time:{start:5,end:6}}});
    part({type:"tool",tool:"read",callID:"call_long",state:{status:"completed",input:{filePath:LONG},output:LONG_READ,title:"q3-board-pack-final-reviewed.md",metadata:{},time:{start:7,end:8}}});
    await finish;return "notes.txt has two lines, src has three entries.";
  },async({root})=>{
    folder=root;
    await send(page,"What is in notes.txt, src, todo.md and the Q3 board pack?");
    const rows=page.locator(".tool-event"),PATHS=[join(folder,"notes.txt"),join(folder,"src"),"H:\\work\\todo.md",LONG],TITLES=["Read notes.txt","Read src","Read H:\\work\\todo.md","Read "+LONG];
    await expect(rows.locator("summary strong"),"each read names what it read").toHaveText(TITLES,{timeout:20_000});
    // The person opens each row: with a click, with Enter on its focused title, and with a click.
    await rows.nth(0).locator("summary").click();
    await rows.nth(1).locator("summary").focus();await page.keyboard.press("Enter");
    await rows.nth(2).locator("summary").click();await rows.nth(3).locator("summary").click();
    // Each opened row names the file or folder it read, cut at its start so the name stays in view, with the whole path on hover, and the
    // row's title, cut at its end, has the whole title on hover.
    const named=async index=>{
      const path=rows.nth(index).locator(".tool-event-body [data-testid=tool-event-path] code");
      await expect(path,"the opened row names what it read").toHaveText(PATHS[index]);await expect(path).toHaveAttribute("title",PATHS[index]);
      await expect(rows.nth(index).locator("summary strong")).toHaveAttribute("title",TITLES[index]);
    };
    for(const [index,lines] of LINES.entries()){
      const body=rows.nth(index).locator(".tool-event-body");
      await expect(body.locator("pre"),"the row opens to what the read read, as lines").toHaveJSProperty("textContent",lines);
      await expect(body.locator(".tool-json"),"not the item's JSON").toHaveCount(0);await expect(body).not.toContainText("dynamicToolCall");
      await expect(body).not.toContainText("<content>");await expect(body).not.toContainText("<path>");await expect(body).not.toContainText("<type>");
      await named(index);
    }
    await shots(page,"opencode-read-without-tags",()=>expect(rows.nth(0).locator(".tool-event-body pre")).toHaveJSProperty("textContent",LINES[0]));
    // In a narrow window the long path's file name is still in view, at the end of the path the opened row names.
    await rows.nth(3).scrollIntoViewIfNeeded();
    await shots(page,"opencode-read-long-path",async()=>{await rows.nth(3).scrollIntoViewIfNeeded();await named(3)});
    release();
    await expect(page.locator(".assistant-message-text").filter({hasText:"notes.txt has two lines"})).toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
    // The thread opened again after a reload shows the same rows.
    await page.reload();await page.getByRole("button",{name:/Theme check/}).click();
    await expect(rows.locator("summary strong")).toHaveText(TITLES,{timeout:20_000});
    await rows.nth(1).locator("summary").click();
    await expect(rows.nth(1).locator(".tool-event-body pre")).toHaveJSProperty("textContent",LINES[1]);
    await expect(rows.nth(1).locator(".tool-json")).toHaveCount(0);
    await rows.nth(3).locator("summary").click();await named(3);
  });
});
