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
const LINES=["1: alpha line\n2: beta line\n\n(End of file - total 2 lines)","index.js\nparser/\nutil.js\n\n(3 entries)\n\n<system-reminder>\nInstructions from: H:\\work\\src\\AGENTS.md\nKeep functions small.\n</system-reminder>","1: - ship it\n2: </content> is literal here\n\n(End of file - total 2 lines)\n\nThis file was read in part: it changed while it was read."];

test("an OpenCode read's row names what it read and opens to the file's lines or the folder's entries, without OpenCode's XML tags",async({page})=>{
  test.setTimeout(120_000);
  let release=()=>{},folder="";const finish=new Promise(resolve=>{release=resolve});
  await openCode1App(page,async({part})=>{
    // A file and a folder in the thread's folder, and a file outside it.
    part({type:"tool",tool:"read",callID:"call_file",state:{status:"completed",input:{filePath:join(folder,"notes.txt")},output:FILE_READ,title:"notes.txt",metadata:{},time:{start:1,end:2}}});
    part({type:"tool",tool:"read",callID:"call_folder",state:{status:"completed",input:{filePath:join(folder,"src")},output:FOLDER_READ,title:"src",metadata:{},time:{start:3,end:4}}});
    part({type:"tool",tool:"read",callID:"call_outside",state:{status:"completed",input:{filePath:"H:\\work\\todo.md"},output:TAG_READ,title:"todo.md",metadata:{},time:{start:5,end:6}}});
    await finish;return "notes.txt has two lines, src has three entries.";
  },async({root})=>{
    folder=root;
    await send(page,"What is in notes.txt, src and todo.md?");
    const rows=page.locator(".tool-event"),TITLES=["Read notes.txt","Read src","Read H:\\work\\todo.md"];
    await expect(rows.locator("summary strong"),"each read names what it read").toHaveText(TITLES,{timeout:20_000});
    // The person opens each row: with a click, with Enter on its focused title, and with a click.
    await rows.nth(0).locator("summary").click();
    await rows.nth(1).locator("summary").focus();await page.keyboard.press("Enter");
    await rows.nth(2).locator("summary").click();
    for(const [index,lines] of LINES.entries()){
      const body=rows.nth(index).locator(".tool-event-body");
      await expect(body.locator("pre"),"the row opens to what the read read, as lines").toHaveJSProperty("textContent",lines);
      await expect(body.locator(".tool-json"),"not the item's JSON").toHaveCount(0);await expect(body).not.toContainText("dynamicToolCall");
      await expect(body).not.toContainText("<content>");await expect(body).not.toContainText("<path>");await expect(body).not.toContainText("<type>");
    }
    await shots(page,"opencode-read-without-tags",()=>expect(rows.nth(0).locator(".tool-event-body pre")).toHaveJSProperty("textContent",LINES[0]));
    release();
    await expect(page.locator(".assistant-message-text").filter({hasText:"notes.txt has two lines"})).toBeVisible({timeout:20_000});
    await expect(stopButton(page)).toHaveCount(0);
    // The thread opened again after a reload shows the same rows.
    await page.reload();await page.getByRole("button",{name:/Theme check/}).click();
    await expect(rows.locator("summary strong")).toHaveText(TITLES,{timeout:20_000});
    await rows.nth(1).locator("summary").click();
    await expect(rows.nth(1).locator(".tool-event-body pre")).toHaveJSProperty("textContent",LINES[1]);
    await expect(rows.nth(1).locator(".tool-json")).toHaveCount(0);
  });
});
