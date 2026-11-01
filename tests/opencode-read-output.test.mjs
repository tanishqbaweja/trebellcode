// What Trebell shows for an OpenCode read. OpenCode 1.x's read tool (1.18.32) answers with what it read wrapped in tags, each on a line
// of its own: <path>, <type> (file or directory), then <content> around a file's numbered lines and the note under them, or <entries>
// around a folder's entries and their count. After the closing tag it may add a blank line and a <system-reminder> with the text of
// the instruction files it found in the folders between the file and the project's folder. A read's row shows what was read, without
// the tags, followed by what OpenCode added; output in any other shape is shown as it came.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession, unwrapOpenCodeRead, openCodeToolTitle } from "../src/opencode-agent-session.mjs";
import { OpenCode2AgentSession } from "../src/opencode2-agent-session.mjs";
import { FAKE_OPENCODE1_MODEL, eventuallyReal, startFakeOpenCode1 } from "./fixtures/fake-opencode1-server.mjs";
import { eventually, fakeOpenCode2Client } from "./fixtures/fake-opencode2-client.mjs";

// A garden planner's project, on a Windows drive, and what OpenCode read there: each read's path and the body it wrote between its tags.
const PROJECT = "D:\\allotment";
const SOWING = { path: `${PROJECT}\\sowing.md`, body: ["1: # Sowing plan", "2: Broad beans: March", "3: Carrots: April", "4: Leeks: May", "", "(End of file - total 4 lines)"] };
const BEDS = { path: `${PROJECT}\\beds`, body: ["compost/", "north.yaml", "south.yaml", "", "(3 entries)"] };
const NORTH = { path: `${PROJECT}\\beds\\north.yaml`, body: ["1: bed: north", "2: rows: 6", "3: crop: leeks", "", "(End of file - total 3 lines)"] };
const BEDS_RULES = `Instructions from: ${PROJECT}\\beds\\AGENTS.md\nName each bed after the side of the plot it faces.`;
// An Atom entry: its lines open and close a <content> element of their own, and the feed folder's instructions show the closing tag
// on a line of its own after OpenCode's.
const ENTRY = { path: `${PROJECT}\\feed\\entry.xml`, body: ["1: <entry>", "2: <content>", "3: Seed potatoes arrive on Friday.", "4: </content>", "5: <summary>Order 12, see </content> above</summary>", "6: </entry>", "", "(End of file - total 6 lines)"] };
const FEED_RULES = `Instructions from: ${PROJECT}\\feed\\AGENTS.md\nEnd each entry's text with\n</content>\non a line of its own.`;
// A read from line 41 of a longer file, an empty file, and a folder read cut at OpenCode's limit.
const DIARY = { path: `${PROJECT}\\diary.md`, body: ["41: 12 May: first leeks planted out", "42: 13 May: slugs on the lettuce", "", "(Showing lines 41-42 of 90. Use offset=43 to continue.)"] };
const TODO = { path: `${PROJECT}\\todo.md`, body: ["", "", "(End of file - total 0 lines)"] };
const PHOTOS = { path: `${PROJECT}\\photos`, body: ["2026-04-01.jpg", "2026-04-08.jpg", "", "(Showing 2 of 31 entries. Use 'offset' parameter to read beyond entry 3)"] };
// A file whose lines hold carriage returns of their own: they stay in what was read.
const PRICES = { path: `${PROJECT}\\prices.csv`, body: ["1: item,price\r", "2: seed potatoes,4.50\r", "", "(End of file - total 2 lines)"] };

// The lines OpenCode writes for a read: the header, the opening tag, the body (a file's numbered lines, a blank line and the note, or
// a folder's entries, a blank line and the count) and the closing tag. laidOut joins them as OpenCode does and adds what follows the
// closing tag.
const fileLines = (path, body) => [`<path>${path}</path>`, "<type>file</type>", "<content>", ...body, "</content>"];
const folderLines = (path, body) => [`<path>${path}</path>`, "<type>directory</type>", "<entries>", ...body, "</entries>"];
const laidOut = (lines, { eol = "\n", after = "" } = {}) => lines.join(eol) + after;
const reminder = (...instructions) => `\n\n<system-reminder>\n${instructions.join("\n\n")}\n</system-reminder>`;

describe("what an OpenCode read shows", () => {
  it("a file read shows its numbered lines and the note under them", () => {
    assert.equal(unwrapOpenCodeRead(laidOut(fileLines(SOWING.path, SOWING.body))), "1: # Sowing plan\n2: Broad beans: March\n3: Carrots: April\n4: Leeks: May\n\n(End of file - total 4 lines)");
  });

  it("a file read whose first line follows the <content> tag on its line is read from right after the tag", () => {
    // OpenCode 1.18.32 ends the tag's line there; output that goes on after the tag still reads as the file's lines.
    const [path, type, open, first, ...rest] = fileLines(NORTH.path, NORTH.body);
    assert.equal(unwrapOpenCodeRead(laidOut([path, type, open + first, ...rest])), NORTH.body.join("\n"));
  });

  it("a folder read shows its entries and their count", () => {
    assert.equal(unwrapOpenCodeRead(laidOut(folderLines(BEDS.path, BEDS.body))), "compost/\nnorth.yaml\nsouth.yaml\n\n(3 entries)");
  });

  it("what OpenCode adds after the closing tag follows what was read, unchanged", () => {
    const after = reminder(BEDS_RULES);
    assert.equal(unwrapOpenCodeRead(laidOut(fileLines(NORTH.path, NORTH.body), { after })), `1: bed: north\n2: rows: 6\n3: crop: leeks\n\n(End of file - total 3 lines)${after}`);
    const two = reminder(BEDS_RULES, `Instructions from: ${PROJECT}\\AGENTS.md\nKeep dates as "12 May".`);
    assert.equal(unwrapOpenCodeRead(laidOut(fileLines(NORTH.path, NORTH.body), { after: two })), NORTH.body.join("\n") + two);
  });

  it("only the closing tag on a line of its own ends the wrapping, so lines of the file holding the tag are part of what was read", () => {
    assert.equal(unwrapOpenCodeRead(laidOut(fileLines(ENTRY.path, ENTRY.body))), "1: <entry>\n2: <content>\n3: Seed potatoes arrive on Friday.\n4: </content>\n5: <summary>Order 12, see </content> above</summary>\n6: </entry>\n\n(End of file - total 6 lines)");
    // The first such line closes it: a later one, in the instructions OpenCode adds, stays in what follows.
    const after = reminder(FEED_RULES);
    assert.equal(unwrapOpenCodeRead(laidOut(fileLines(ENTRY.path, ENTRY.body), { after })), ENTRY.body.join("\n") + after);
    assert.ok(after.includes("\n</content>\n"));
  });

  it("line breaks are kept as they came", () => {
    assert.equal(unwrapOpenCodeRead(laidOut(fileLines(SOWING.path, SOWING.body), { eol: "\r\n" })), "1: # Sowing plan\r\n2: Broad beans: March\r\n3: Carrots: April\r\n4: Leeks: May\r\n\r\n(End of file - total 4 lines)");
    assert.equal(unwrapOpenCodeRead(laidOut(folderLines(BEDS.path, BEDS.body), { eol: "\r\n", after: "\r\n" })), "compost/\r\nnorth.yaml\r\nsouth.yaml\r\n\r\n(3 entries)\r\n");
    assert.equal(unwrapOpenCodeRead(laidOut(fileLines(PRICES.path, PRICES.body))), "1: item,price\r\n2: seed potatoes,4.50\r\n\n(End of file - total 2 lines)");
  });

  it("a read from a later line, an empty file and a folder cut at OpenCode's limit show the same way", () => {
    assert.equal(unwrapOpenCodeRead(laidOut(fileLines(DIARY.path, DIARY.body))), "41: 12 May: first leeks planted out\n42: 13 May: slugs on the lettuce\n\n(Showing lines 41-42 of 90. Use offset=43 to continue.)");
    assert.equal(unwrapOpenCodeRead(laidOut(fileLines(TODO.path, TODO.body))), "\n\n(End of file - total 0 lines)");
    assert.equal(unwrapOpenCodeRead(laidOut(folderLines(PHOTOS.path, PHOTOS.body))), "2026-04-01.jpg\n2026-04-08.jpg\n\n(Showing 2 of 31 entries. Use 'offset' parameter to read beyond entry 3)");
  });

  it("output in any other shape is returned as it is", () => {
    const file = fileLines(SOWING.path, SOWING.body), folder = folderLines(BEDS.path, BEDS.body);
    const others = {
      "a sentence": "Planted six rows of leeks.",
      "OpenCode 2's own read output": "Read file sowing.md, lines 1-2\n1: # Sowing plan\n2: Broad beans: March",
      "an image read": "Image read successfully",
      "the header alone": laidOut(file.slice(0, 2)),
      "no path line": laidOut(folder.slice(1)),
      "no closing tag": laidOut(file.slice(0, -1)),
      "a closing tag with more on its line": laidOut([...file.slice(0, -1), "</content> (cut)"]),
      "a type other than file or directory": laidOut(file.map(line => line === "<type>file</type>" ? "<type>symlink</type>" : line)),
      "a folder's type around a file's lines": laidOut([folder[0], folder[1], ...file.slice(2)]),
      "a file's type around a folder's entries": laidOut([file[0], file[1], ...folder.slice(2)]),
      "an empty string": "",
    };
    for (const [name, output] of Object.entries(others)) assert.equal(unwrapOpenCodeRead(output), output, name);
    assert.equal(unwrapOpenCodeRead(null), null);
    assert.equal(unwrapOpenCodeRead(undefined), undefined);
  });

  it("each tag is read on a line of its own: an empty body, a closing line right below the opening one, entries that hold the tag", () => {
    const sowing = `<path>${SOWING.path}</path>\n<type>file</type>\n`, beds = `<path>${BEDS.path}</path>\n<type>directory</type>\n`;
    // An empty body closes on the line right after a lone <content>, with either line break.
    assert.equal(unwrapOpenCodeRead(sowing + "<content>\n</content>"), "");
    assert.equal(unwrapOpenCodeRead(sowing + "<content>\r\n</content>\r\n"), "\r\n");
    // The first later line that is the closing tag ends the file, even after a closing line right below a lone <content>.
    assert.equal(unwrapOpenCodeRead(sowing + "<content>\n</content>\n1: # Sowing plan\n</content>\nnote"), "</content>\n1: # Sowing plan\nnote");
    // A folder's entries end at "</entries>" on a line of its own, never on an entry that holds the tag.
    assert.equal(unwrapOpenCodeRead(beds + "<entries>\nnorth</entries>.yaml\n\n</entries>"), "north</entries>.yaml\n");
    assert.equal(unwrapOpenCodeRead(beds + "<entries>\n\n</entries>"), "");
    // These stay as they came: a last line "</content>\r" with no line break after it, a folder whose closing tag is the line right
    // after <entries>, an empty path, a path holding a carriage return, a path line that does not end with its tag, an <entries>
    // line with more text after the tag, and a header that stops after its path or type line.
    const kept = [
      sowing + "<content>\n1: # Sowing plan\n</content>\r",
      beds + "<entries>\n</entries>",
      "<path></path>\n<type>file</type>\n<content>\n1: # Sowing plan\n</content>",
      "<path>D:\\allot\rment\\sowing.md</path>\n<type>file</type>\n<content>\n1: # Sowing plan\n</content>",
      `<path>${SOWING.path}</path> \n<type>file</type>\n<content>\n1: # Sowing plan\n</content>`,
      beds + "<entries>compost/\nnorth.yaml\n</entries>",
      sowing.trimEnd(), beds.trimEnd(), `<path>${SOWING.path}</path>`,
    ];
    for (const output of kept) assert.equal(unwrapOpenCodeRead(output), output, JSON.stringify(output));
  });
});

describe("an OpenCode read's title", () => {
  const titled = (filePath, cwd) => openCodeToolTitle("read", { input: { filePath }, cwd });

  it("names a path in the thread's folder from that folder, as the model wrote the rest of it", () => {
    assert.equal(titled("D:\\allotment\\sowing.md", "D:\\allotment"), "Read sowing.md");
    assert.equal(titled("D:\\allotment\\beds\\north.yaml", "D:\\allotment"), "Read beds\\north.yaml");
    assert.equal(titled("/home/ana/garden/beds.md", "/home/ana/garden"), "Read beds.md");
  });

  it("finds a Windows folder whichever separators and letter case the model used for it, on a drive or a share", () => {
    assert.equal(titled("D:/allotment/sowing.md", "D:\\allotment"), "Read sowing.md");
    assert.equal(titled("D:\\allotment\\sowing.md", "D:/allotment"), "Read sowing.md");
    assert.equal(titled("d:/Allotment/beds/north.yaml", "D:\\allotment\\"), "Read beds/north.yaml");
    assert.equal(titled("\\\\shed\\plans\\layout.md", "\\\\SHED\\Plans"), "Read layout.md");
  });

  it("names a path outside the thread's folder whole", () => {
    assert.equal(titled("D:\\allotment-old\\sowing.md", "D:\\allotment"), "Read D:\\allotment-old\\sowing.md");
    assert.equal(titled("E:\\seeds\\catalogue.md", "D:\\allotment"), "Read E:\\seeds\\catalogue.md");
    // A POSIX folder is matched with its case.
    assert.equal(titled("/home/ana/Garden/beds.md", "/home/ana/garden"), "Read /home/ana/Garden/beds.md");
  });

  it("names the thread's folder itself whole, as it has no shorter name", () => {
    assert.equal(titled("D:\\allotment", "D:\\allotment"), "Read D:\\allotment");
    assert.equal(titled("D:\\allotment\\", "D:\\allotment"), "Read D:\\allotment\\");
    assert.equal(titled("/home/ana/garden", "/home/ana/garden"), "Read /home/ana/garden");
  });
});

describe("a read's row in a session", () => {
  const completed = updates => updates.filter(update => update.sessionUpdate === "tool_call_update" && update.status === "completed");

  it("OpenCode 1.x: a read's row shows what was read and opens as text; a command laid out like a read keeps its output", async () => {
    const catalogue = { path: "E:\\seeds\\catalogue.md", body: ["7: Leek 'Musselburgh'", "8: Carrot 'Autumn King'", "", "(Showing lines 7-8 of 40. Use offset=9 to continue.)"] };
    const calls = [
      ["call_sowing", "read", SOWING.path, laidOut(fileLines(SOWING.path, SOWING.body))],
      ["call_beds", "read", BEDS.path, laidOut(folderLines(BEDS.path, BEDS.body))],
      ["call_north", "read", NORTH.path, laidOut(fileLines(NORTH.path, NORTH.body), { after: reminder(BEDS_RULES) })],
      ["call_catalogue", "read", catalogue.path, laidOut(fileLines(catalogue.path, catalogue.body))],
      ["call_type", "bash", null, laidOut(fileLines(SOWING.path, SOWING.body))],
    ];
    const fake = await startFakeOpenCode1({
      onPrompt: async ({ part }) => {
        for (const [callID, tool, filePath, output] of calls) {
          const input = filePath ? { filePath } : { command: "type sowing.md" }, title = filePath ? "" : "type sowing.md";
          part({ type: "tool", tool, callID, state: { status: "completed", input, output, title, metadata: {}, time: { start: 10, end: 20 } } });
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        return "Read the plan.";
      },
    });
    const updates = [];
    const session = new OpenCodeAgentSession({ cwd: PROJECT, serverUrl: fake.url, onUpdate: params => updates.push(params.update) });
    try {
      await session.start({ model: FAKE_OPENCODE1_MODEL });
      await eventuallyReal(() => fake.streams.size > 0, { message: "the session did not subscribe to OpenCode's events" });
      await session.prompt([{ type: "text", text: "Read the sowing plan and the beds" }]);
      const rows = await eventuallyReal(() => {
        const done = completed(updates);
        return done.length === calls.length && Object.fromEntries(done.map(update => [update.toolCallId, { title: update.title, text: update.textOutput === true, output: update.rawOutput }]));
      });
      assert.deepEqual(rows, {
        call_sowing: { title: "Read sowing.md", text: true, output: SOWING.body.join("\n") },
        call_beds: { title: "Read beds", text: true, output: "compost/\nnorth.yaml\nsouth.yaml\n\n(3 entries)" },
        call_north: { title: "Read beds\\north.yaml", text: true, output: NORTH.body.join("\n") + reminder(BEDS_RULES) },
        call_catalogue: { title: "Read E:\\seeds\\catalogue.md", text: true, output: catalogue.body.join("\n") },
        call_type: { title: "type sowing.md", text: false, output: laidOut(fileLines(SOWING.path, SOWING.body)) },
      });
    } finally {
      await session.close();
      await fake.close();
    }
  });

  it("OpenCode 2: a read's row shows what was read from its text, OpenCode 2's own read output is kept, and so is another tool's", async () => {
    const fake = fakeOpenCode2Client(), updates = [];
    const session = new OpenCode2AgentSession({ cwd: PROJECT, serverUrl: "http://127.0.0.1:9", loadClient: fake.loadClient, onUpdate: params => updates.push(params.update) });
    await session.start({});
    try {
      const turn = session.prompt([{ type: "text", text: "Read the beds" }]);
      await eventually(() => fake.called("session.prompt").length === 1);
      const north = laidOut(fileLines(NORTH.path, NORTH.body), { after: reminder(BEDS_RULES) }), cut = north.indexOf("</content>");
      const calls = [
        // The text can come in more than one piece: the pieces are read together.
        ["read_north", "read", { filePath: NORTH.path }, [north.slice(0, cut), north.slice(cut)]],
        ["read_sowing", "read", { filePath: SOWING.path }, ["Read file sowing.md, lines 1-2\n1: # Sowing plan\n2: Broad beans: March"]],
        ["list_beds", "shell", { command: "dir beds", description: "List the beds" }, [laidOut(folderLines(BEDS.path, BEDS.body))]],
      ];
      for (const [id, name, input, pieces] of calls) {
        const at = { sessionID: "ses_main", assistantMessageID: "msg_a1", id };
        fake.emit({ type: "session.tool.input.started", data: { ...at, name } });
        fake.emit({ type: "session.tool.called", data: { ...at, input, executed: false } });
        fake.emit({ type: "session.tool.success", data: { ...at, content: pieces.map(text => ({ type: "text", text })), metadata: { truncated: false }, executed: true } });
      }
      fake.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_main" } });
      await turn;
      const rows = Object.fromEntries(completed(updates).map(update => [update.toolCallId, update.rawOutput]));
      assert.deepEqual(rows, {
        read_north: NORTH.body.join("\n") + reminder(BEDS_RULES),
        read_sowing: "Read file sowing.md, lines 1-2\n1: # Sowing plan\n2: Broad beans: March",
        list_beds: laidOut(folderLines(BEDS.path, BEDS.body)),
      });
    } finally {
      await session.close();
    }
  });
});
