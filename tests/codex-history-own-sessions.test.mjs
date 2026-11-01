import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexHistoryPrefix, scanCodexHistory } from "../src/agent-history-import.mjs";

// Conversation history offers the person's own Codex sessions for import, each named after what the person asked for. The rollouts
// below follow Codex's JSON Lines format: the session's own session_meta first (a fork then copies the session_meta records of the
// sessions it came from), turn contexts, what the person sent as user_message events and the model's replies as response items.
const record={
  meta:payload=>({timestamp:"2026-10-29T08:15:00.000Z",type:"session_meta",payload:{originator:"codex_cli_rs",...payload}}),
  turn:cwd=>({type:"turn_context",payload:{cwd,model:"gpt-5-codex",approval_policy:"on-request"}}),
  ask:message=>({type:"event_msg",payload:{type:"user_message",message,images:[]}}),
  answer:text=>({type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text}]}}),
};
const jsonLines=(...records)=>records.reduce((text,entry)=>`${text}${JSON.stringify(entry)}\n`,"");

// The source of a session Codex runs for itself (a review, a compaction, a spawned child agent, a named helper), under either
// spelling of the key.
const CODEX_OWN_SOURCES=[
  {subagent:"review"},
  {subagent:"compact"},
  {subagent:{thread_spawn:{parent_thread_id:"0b5e2c4a-parent",depth:2}}},
  {subAgent:{other:"guardian"}},
  {subAgent:"review"},
];
// Sources of sessions the person started, and look-alikes that do not make a session Codex's own.
const PERSON_SOURCES=["cli","vscode","exec","mcp","unknown",undefined,null,["subagent","review"],{launcher:"subagent"}];

const CLOCK=Date.UTC(2026,9,30,12);
const DAY_IN_MINUTES=24*60;
const minutesBefore=minutes=>new Date(CLOCK-minutes*60_000);
// A throwaway Codex home. put() writes one rollout where Codex keeps it, sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, created
// minutesAgo minutes before CLOCK (Codex names a rollout by when it began, so a newer one sorts first by name) and last written then
// too, or lastWrittenMinutesAgo for a session the person came back to; list() runs the history scan on that home, with Trebell's
// own data in a folder of its own.
async function codexHomeFor(t,label){
  const base=await mkdtemp(join(tmpdir(),`trebell-${label}-`));
  t.after(()=>rm(base,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  const project=join(base,"bookshop"),dataFolder=join(base,"codex-data");
  await mkdir(project);
  return {
    project,
    async put({id,minutesAgo,lastWrittenMinutesAgo=minutesAgo,records}){
      const stamp=minutesBefore(minutesAgo).toISOString().slice(0,19).replaceAll(":","-");
      const folder=join(dataFolder,"sessions",...stamp.slice(0,10).split("-"));
      await mkdir(folder,{recursive:true});
      const file=join(folder,`rollout-${stamp}-${id}.jsonl`),written=minutesBefore(lastWrittenMinutesAgo);
      await writeFile(file,jsonLines(...records));
      await utimes(file,written,written);
    },
    list:maxSessions=>scanCodexHistory({env:{...process.env,TREBELL_HOME:join(base,"trebell-data")},sourceHome:dataFolder,maxSessions}),
  };
}

test("Codex's own sessions, newer than the person's and more than the session limit, do not use the limit up",async t=>{
  const home=await codexHomeFor(t,"codex-limit");
  for(let n=1;n<=9;n++)await home.put({id:`helper-${n}`,minutesAgo:n,records:[
    record.meta({id:`helper-${n}`,cwd:home.project,source:CODEX_OWN_SOURCES[n%CODEX_OWN_SOURCES.length]}),
    record.ask(`Check step ${n} of the plan`),
  ]});
  const requests=["Show the stock count on each book card","Add a wish list page","Fix the price rounding in the basket","Explain how the search index is built"];
  for(const [n,request] of requests.entries())await home.put({id:`mine-${n+1}`,minutesAgo:DAY_IN_MINUTES+n*15,records:[
    record.meta({id:`mine-${n+1}`,cwd:home.project,source:"vscode"}),
    record.turn(home.project),
    record.ask(request),
  ]});
  // The newest three of the person's four sessions, newest first.
  const listed=await home.list(3);
  assert.deepEqual(listed.map(session=>[session.providerSessionId,session.title]),[["mine-1",requests[0]],["mine-2",requests[1]],["mine-3",requests[2]]]);
  for(const session of listed)assert.deepEqual(
    {source:session.source,cwd:session.cwd,model:session.model,preview:session.preview},
    {source:"codex",cwd:home.project,model:"gpt-5-codex",preview:session.title},
  );
});

test("more of Codex's own rollouts than a scan reads, all newer, still leave the person's older sessions listed",async t=>{
  const home=await codexHomeFor(t,"codex-many");
  // Codex keeps the instructions in session_meta, which makes that first line longer than one piece the scan reads at a time.
  const instructions="Follow the conventions in this repository and explain each change. ".repeat(180);
  const replies=[1,2,3].map(n=>record.answer(`Part ${n} is finished. `.repeat(120)));
  for(let n=1;n<=260;n++)await home.put({id:`helper-${n}`,minutesAgo:n,records:[
    record.meta({id:`helper-${n}`,cwd:home.project,source:CODEX_OWN_SOURCES[n%CODEX_OWN_SOURCES.length],instructions}),
    record.ask(`Review part ${n}`),
    ...replies,
  ]});
  await home.put({id:"mine-long",minutesAgo:DAY_IN_MINUTES,records:[
    record.meta({id:"mine-long",cwd:home.project,source:"cli",instructions}),
    record.ask("Cache the cover images"),
  ]});
  // This session's folder has since been moved away, so it is not offered.
  await home.put({id:"mine-moved",minutesAgo:DAY_IN_MINUTES+10,records:[
    record.meta({id:"mine-moved",cwd:join(home.project,"..","bookshop-old"),source:"cli"}),
    record.ask("Split the admin pages out"),
  ]});
  await home.put({id:"mine-short",minutesAgo:DAY_IN_MINUTES+20,records:[
    record.meta({id:"mine-short",cwd:home.project,source:"vscode"}),
    record.ask("Add a sitemap"),
  ]});
  // Begun ten days ago and taken up again half an hour ago: the list goes by when a session was last written.
  await home.put({id:"mine-resumed",minutesAgo:10*DAY_IN_MINUTES,lastWrittenMinutesAgo:30,records:[
    record.meta({id:"mine-resumed",cwd:home.project,source:"exec"}),
    record.ask("Upgrade the payment library"),
  ]});
  const listed=await home.list(60);
  assert.deepEqual(listed.map(session=>`${session.providerSessionId}: ${session.title}`),[
    "mine-resumed: Upgrade the payment library",
    "mine-long: Cache the cover images",
    "mine-short: Add a sitemap",
  ]);
});

const REVIEWS_REQUEST="Sort the reviews by date";
test("a rollout is Codex's own only when its own session_meta's source has a subagent key, in either spelling",()=>{
  const readWith=source=>parseCodexHistoryPrefix(jsonLines(record.meta({id:"session-with-source",source,cwd:"/srv/bookshop"}),record.ask(REVIEWS_REQUEST)));
  for(const source of CODEX_OWN_SOURCES)assert.equal(readWith(source),null,`${JSON.stringify(source)} is Codex's own`);
  for(const source of PERSON_SOURCES)assert.equal(readWith(source)?.title,REVIEWS_REQUEST,`${JSON.stringify(source)} is the person's`);
  // A rollout without a session_meta names no session at all.
  assert.equal(parseCodexHistoryPrefix(jsonLines(record.turn("/srv/bookshop"),record.ask(REVIEWS_REQUEST))),null);
});

test("a fork is listed under its own id, whatever sessions it copied after its own session_meta",()=>{
  // The person forked a review Codex ran, which came from one of the person's sessions in another folder.
  const forkOfReview=parseCodexHistoryPrefix(jsonLines(
    record.meta({id:"fork-77",forked_from_id:"review-12",cwd:"/srv/bookshop",source:"cli"}),
    record.meta({id:"review-12",forked_from_id:"start-3",cwd:"/srv/bookshop",source:{subagent:"review"}}),
    record.meta({id:"start-3",cwd:"/srv/bookshop-2025",source:"vscode"}),
    record.ask("Apply the two suggestions from the review"),
  ));
  assert.deepEqual(
    {id:forkOfReview?.providerSessionId,cwd:forkOfReview?.cwd,title:forkOfReview?.title},
    {id:"fork-77",cwd:"/srv/bookshop",title:"Apply the two suggestions from the review"},
  );
  // A fork whose own session_meta names no folder takes the first folder a copied one names.
  const forkWithoutFolder=parseCodexHistoryPrefix(jsonLines(
    record.meta({id:"fork-78",forked_from_id:"start-4"}),
    record.meta({id:"start-4",cwd:"/srv/bookshop/admin",source:"cli"}),
    record.ask("Carry on from the last step"),
  ));
  assert.deepEqual([forkWithoutFolder?.providerSessionId,forkWithoutFolder?.cwd],["fork-78","/srv/bookshop/admin"]);
  // A child agent Codex spawned stays Codex's own though it copied the person's session_meta after its own.
  assert.equal(parseCodexHistoryPrefix(jsonLines(
    record.meta({id:"spawned-9",forked_from_id:"start-5",cwd:"/srv/bookshop",source:{subagent:{thread_spawn:{parent_thread_id:"start-5",depth:1}}}}),
    record.meta({id:"start-5",cwd:"/srv/bookshop",source:"cli"}),
    record.ask("Check the migration files"),
  )),null);
});

test("the scan lists the person's sessions whatever their source, and their forks of Codex's own, and leaves Codex's own out",async t=>{
  const home=await codexHomeFor(t,"codex-kinds");
  // Newest first, one of Codex's own sessions just ahead of each of the person's.
  for(const [n,source] of PERSON_SOURCES.entries()){
    await home.put({id:`helper-${n+1}`,minutesAgo:10*n+1,records:[
      record.meta({id:`helper-${n+1}`,cwd:home.project,source:CODEX_OWN_SOURCES[n%CODEX_OWN_SOURCES.length]}),
      record.ask(`Check the blurb of book ${n+1}`),
    ]});
    await home.put({id:`mine-${n+1}`,minutesAgo:10*n+5,records:[
      record.meta({id:`mine-${n+1}`,cwd:home.project,source}),
      record.ask(`Write a blurb for book ${n+1}`),
    ]});
  }
  // The person forked a review Codex ran, and Codex spawned a child agent from one of the person's sessions: each rollout copies the
  // session_meta it came from after its own.
  await home.put({id:"spawned-31",minutesAgo:115,records:[
    record.meta({id:"spawned-31",forked_from_id:"mine-1",cwd:home.project,source:{subagent:{thread_spawn:{parent_thread_id:"mine-1",depth:1}}}}),
    record.meta({id:"mine-1",cwd:home.project,source:"cli"}),
    record.ask("Count the broken links"),
  ]});
  await home.put({id:"mine-fork",minutesAgo:120,records:[
    record.meta({id:"mine-fork",forked_from_id:"review-32",cwd:home.project,source:"vscode"}),
    record.meta({id:"review-32",cwd:home.project,source:{subAgent:"review"}}),
    record.ask("Undo the second suggestion from the review"),
  ]});
  const listed=await home.list(60);
  assert.deepEqual(listed.map(session=>session.providerSessionId),[...PERSON_SOURCES.map((_,n)=>`mine-${n+1}`),"mine-fork"]);
  assert.equal(listed.at(-1).title,"Undo the second suggestion from the review");
});

// Setup Codex writes at the start of a user message, in Codex's own formats.
const SETUP={
  environment:[
    "<environment_context>",
    "  <cwd>/srv/bookshop</cwd>",
    "  <approval_policy>on-request</approval_policy>",
    "  <sandbox_mode>workspace-write</sandbox_mode>",
    "  <network_access>restricted</network_access>",
    "  <shell>bash</shell>",
    "</environment_context>",
  ].join("\n"),
  agentsFile:"# AGENTS.md instructions for /srv/bookshop\n\n<INSTRUCTIONS>\nRun the linter before every commit.\nKeep each component in its own file.\n</INSTRUCTIONS>",
  olderInstructions:"<user_instructions>\n\nAnswer in short paragraphs.\n\n</user_instructions>",
  plugins:"<recommended_plugins>\n- Linear: open and update issues\n- Sentry: read crash reports\n</recommended_plugins>",
  // Re-pinned note: an in-app browser element was passed over as setup too; Codex's source writes none, so it no longer is.
  ideHeading:"## My request for Codex:",
};
// [situation, the person's user messages in order, the name the session gets]
const NAMING_CASES=[
  ["an environment block, then the request",[`${SETUP.environment}\n\nShow the stock count on each book card`],"Show the stock count on each book card"],
  ["the IDE's request heading after blank lines and an indent",[`\n\n   ${SETUP.ideHeading}\n\nRename the cart store to basket`],"Rename the cart store to basket"],
  ["every kind of setup in a row",[[SETUP.agentsFile,SETUP.plugins,SETUP.environment,SETUP.olderInstructions,SETUP.ideHeading,"Make the Pay button work again"].join("\n\n")],"Make the Pay button work again"],
  ["the older user_instructions block",[`${SETUP.olderInstructions}\nAdd a search box to the catalogue`],"Add a search box to the catalogue"],
  ["a first message of setup only, then the request",[`${SETUP.environment}\n${SETUP.agentsFile}`,"Translate the footer into French"],"Translate the footer into French"],
  ["setup quoted after the request has begun",[`What is this block in my prompt?\n${SETUP.plugins}`],"What is this block in my prompt? <recommended_plugins> - Linear: open and update issues - Sentry: read crash reports </recommended_plugins>"],
  ["a request that starts with an HTML tag",["<select> menus close too early on Safari"],"<select> menus close too early on Safari"],
  ["nothing but setup",[SETUP.environment,`${SETUP.plugins}\n${SETUP.olderInstructions}`],"Imported Codex session"],
  ["a long request over several lines",["Write the release notes\n\n\nfor "+"v".repeat(300)],"Write the release notes for "+"v".repeat(132)],
];

test("an imported Codex session is named after the request, not the setup Codex writes ahead of it",()=>{
  for(const [situation,messages,name] of NAMING_CASES){
    const session=parseCodexHistoryPrefix(jsonLines(record.meta({id:"named-session",cwd:"/srv/bookshop",source:"cli"}),...messages.map(record.ask)));
    assert.equal(session?.title,name,situation);
    assert.equal(session?.preview,name,situation);
  }
});
