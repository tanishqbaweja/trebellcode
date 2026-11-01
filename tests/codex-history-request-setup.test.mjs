import test from "node:test";
import assert from "node:assert/strict";
import { codexRequestAfterSetup, parseCodexHistoryPrefix } from "../src/agent-history-import.mjs";

// Where the setup Codex records ahead of a person's request ends. Its context and instruction elements, the line naming the
// AGENTS.md file it read and the IDE extension's request heading are passed over at the start of the person's text, and only
// there; anything that only looks like setup stays in the request.
const REQUEST="Sort the release checklist";
const unchanged=text=>assert.equal(codexRequestAfterSetup(text),text,JSON.stringify(text));
const importOf=(...userTexts)=>parseCodexHistoryPrefix([
  JSON.stringify({type:"session_meta",payload:{id:"session-setup-edges",cwd:"/work/site"}}),
  ...userTexts.map(message=>JSON.stringify({type:"event_msg",payload:{type:"user_message",message}})),
].join("\n"));

test("a setup element's start tag may carry attributes over several lines, and the element ends at its first end tag",()=>{
  // Re-pinned note: the sample element is one Codex's source writes (it was an in-app browser element, which Codex writes none of).
  assert.equal(codexRequestAfterSetup(`<recommended_plugins\n  source="catalog"\n  count="2"\n>\nLinear, Sentry\n</recommended_plugins>\n${REQUEST}`),REQUEST);
  assert.equal(codexRequestAfterSetup(`<in-app-browser-context>\nDocs tab\n</in-app-browser-context>\n${REQUEST}`),`<in-app-browser-context>\nDocs tab\n</in-app-browser-context>\n${REQUEST}`);
  // An element inside one of the same name: the inner end tag closes the setup, and the rest is the request.
  assert.equal(codexRequestAfterSetup("<user_instructions>a<user_instructions>b</user_instructions>c</user_instructions>Make the sidebar remember its width"),
    "c</user_instructions>Make the sidebar remember its width");
  assert.equal(codexRequestAfterSetup("<environment_context><shell>zsh</shell></environment_context><recommended_plugins>Linear</recommended_plugins>Ship it"),"Ship it");
});

test("an element that is not closed, closed with spaces, self-closed or named otherwise stays in the request",()=>{
  const body="\n<cwd>/work/site</cwd>\n";
  // Never closed, or closed with a space before its ">".
  unchanged(`<environment_context>${body}${REQUEST}`);
  unchanged(`<environment_context>${body}</environment_context >\n${REQUEST}`);
  // Closed on itself, so nothing after it is inside it.
  unchanged(`<environment_context/>\n${REQUEST}`);
  unchanged(`<INSTRUCTIONS/>Tabs</INSTRUCTIONS>\n${REQUEST}`);
  // Not one of the five names as Codex writes them: a longer name, another case, another element.
  for(const name of["environment_contexts","Environment_Context","instructions","cwd"])unchanged(`<${name}>${body}</${name}>\n${REQUEST}`);
  unchanged(`<environment_contextual>${body}</environment_context>\n${REQUEST}`);
  // Setup ahead of an element that is never closed is still passed over; the unclosed element starts the request.
  assert.equal(codexRequestAfterSetup("<INSTRUCTIONS>Tabs</INSTRUCTIONS>\n<user_instructions>never closed"),"<user_instructions>never closed");
  const unclosed="<recommended_plugins>"+"plugin\n".repeat(150_000);
  assert.equal(codexRequestAfterSetup(unclosed),unclosed.trim());
});

test("the AGENTS.md line is setup to the end of its line, only as a whole word, and only a line feed ends it",()=>{
  const agentsLine="# AGENTS.md instructions";
  const afterAgentsLine=rest=>codexRequestAfterSetup(agentsLine+rest);
  assert.equal(afterAgentsLine(" for /work/site\nRename the flag"),"Rename the flag");
  assert.equal(afterAgentsLine("\r\nRename the flag"),"Rename the flag");
  assert.equal(afterAgentsLine("-site\nRename the flag"),"Rename the flag");
  assert.equal(afterAgentsLine(""),"");
  // A letter, a digit or "_" right after "instructions" makes it another word.
  for(const joined of["ForSite","_v2","2"])unchanged(`${agentsLine}${joined}\nRename the flag`);
  // Without the space after "#", in another case, or after other text.
  unchanged("#AGENTS.md instructions\nRename the flag");
  unchanged("# agents.md instructions\nRename the flag");
  unchanged(`Note: ${agentsLine}\nRename the flag`);
  // A lone carriage return or a line separator does not end the line, so the rest of it is setup too.
  assert.equal(afterAgentsLine(" for /work/site\rRename the flag"),"");
  assert.equal(afterAgentsLine(" for /work/site\u2028Rename the flag\nKeep the old name as an alias"),"Keep the old name as an alias");
});

test("the request heading is passed over by itself: what follows it on its line is the request",()=>{
  const heading="## My request for Codex:";
  assert.equal(codexRequestAfterSetup(`${heading} Rename the flag\nand its help text`),"Rename the flag\nand its help text");
  assert.equal(codexRequestAfterSetup(`${heading}${heading}\nRename the flag`),"Rename the flag");
  // Near misses: one "#" more, "codex" in lower case, no colon, two spaces after "##".
  const nearMisses=["#"+heading,heading.replace("Codex","codex"),heading.slice(0,-1),heading.replace(" ","  ")];
  for(const nearMiss of nearMisses)unchanged(`${nearMiss}\nRename the flag`);
});

test("the white space \\s matches, and no other character, may come before and between setup parts",()=>{
  const setup="<INSTRUCTIONS>Tabs</INSTRUCTIONS>";
  // Every UTF-16 code unit is tried as the gap before, between and after two setup parts.
  const gaps=[],whiteSpace=[];
  for(let code=0;code<=0xffff;code++){
    const gap=String.fromCharCode(code);
    if(codexRequestAfterSetup(gap+setup+gap+setup+gap+REQUEST)===REQUEST)gaps.push(code);
    if(/\s/.test(gap))whiteSpace.push(code);
  }
  assert.deepEqual(gaps,whiteSpace);
  assert.equal(codexRequestAfterSetup(`\u3000${setup}\u00a0\u2028\ufeff## My request for Codex:\t\vRename the flag`),"Rename the flag");
  assert.equal(codexRequestAfterSetup(`<environment_context\u00a0source="cli">x</environment_context>${REQUEST}`),REQUEST);
  // A zero-width space is not white space: setup after it is part of the request, as is setup after the request has begun.
  unchanged(`\u200b${setup}${REQUEST}`);
  unchanged(`${REQUEST}\n## My request for Codex:\n${setup}`);
  assert.equal(codexRequestAfterSetup("  \n "),"");
});

test("an imported session's title and preview come from the first user text that is more than setup",()=>{
  const parsed=importOf("# AGENTS.md instructions for /work/site\n\n<INSTRUCTIONS>\nTabs\n</INSTRUCTIONS>","## My request for Codex:\n\n  Make the sidebar\n  remember its width  ","Later message");
  assert.deepEqual([parsed?.title,parsed?.preview],["Make the sidebar remember its width","Make the sidebar remember its width"]);
  assert.equal(importOf("<recommended_plugins>Linear</recommended_plugins>","## My request for Codex:")?.title,"Imported Codex session");
  assert.equal(importOf("<user_instructions>Be brief</user_instructions>"+" Rename".repeat(40))?.title.length,160);
  // A user message given as content parts is read as one text, so setup in its first part is passed over too.
  const fromParts=parseCodexHistoryPrefix([
    JSON.stringify({type:"session_meta",payload:{id:"session-content-parts",cwd:"/work/site"}}),
    JSON.stringify({type:"event_msg",payload:{type:"user_message",content:[{text:"<environment_context>\n<cwd>/work/site</cwd>\n</environment_context>"},{text:"Ship the hotfix"}]}}),
  ].join("\n"));
  assert.equal(fromParts?.title,"Ship the hotfix");
});
