import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Integrity audit of saved benchmark agent logs: Codex rollouts (agent/codex-sessions/ or the stock
// agent/sessions/ layout), the `codex exec --json` stream agent/codex.txt when a trial kept no rollout,
// and Trebell Native events. It flags hosted web use (web.run, web_search_call, ChatGPT connector or other
// MCP calls, shell calls answered by the OpenAI API), fetches of the task's own upstream project or of the
// benchmark itself, network-capable commands, git history beyond HEAD, probes of verifier, solution and
// harness log paths, requests for user input, and commands the logs do not fully record. Each Codex call
// is paired with its output, and Codex execution events (CommandExecution, Extension, McpToolCall) show
// what actually ran, so a reviewer can see whether a fetch returned content.
// Status: hosted web use, or an upstream/benchmark fetch that returned content, makes a lane invalid by
// policy; a lane that ran commands none of which were recorded is unaudited; every other flag (including
// partly recorded commands) needs review before the result counts.

const LOCAL_CODEX_TOOLS=new Set(["exec_command","exec","write_stdin","apply_patch","view_image","clock__curr_time","sleep","wait","update_plan","request_user_input","request_user_input_async","shell","shell_command","local_shell","create_goal","get_goal","update_goal"]);
const COMMAND_CODEX_TOOLS=new Set(["exec_command","exec","write_stdin","shell","shell_command","local_shell"]);
// Hosted tools: web search/browse/fetch-like names and every MCP tool (`mcp__<server>__<tool>`,
// `read_mcp_resource`, `list_mcp_resources`), which reach ChatGPT connectors or other servers.
const HOSTED_WEB_TOOL=/web|search|browse|browser|fetch|http|url|internet|mcp/i;
const USER_INPUT_TOOL=/^request_user_input(?:_async)?$/;
// A failed attempt to call a hosted tool that does not exist in the run (code-mode JavaScript error).
const TOOL_CALL_FAILURE=/\b(?:TypeError|ReferenceError)\b|is not a function|is not defined|cannot read propert|unknown tool|no such tool|tool\b.{0,40}\bnot (?:found|available|enabled|allowed)/i;
const TOOL_LIKE_ITEM=/tool|search|web|brows|fetch|mcp|image_?gen|computer|plugin|connector/i;
const QUIET_EVENT_ITEMS=new Set(["Reasoning","AgentMessage","UserMessage","FileChange","ImageView","ContextCompaction","Plan","TodoList","Error"]);
const QUIET_STREAM_ITEMS=new Set(["agent_message","reasoning","file_change","error","todo_list"]);

const PIP=String.raw`\b(?:pip(?:3(?:\.\d+)?)?|uv\s+pip|python(?:3(?:\.\d+)?)?\s+-m\s+pip)`;
const PYTHON_HTTP=String.raw`\b(?:urllib\.request|urllib2|urllib3|urlopen|urlretrieve|requests\.(?:get|post|head|put|patch|delete|options|Session|request)|from\s+requests\s+import|import\s+(?:[\w.]+\s*,\s*)*requests|http\.client|httplib2?|httpx|aiohttp|pycurl|ftplib|xmlrpc\.client|xmlrpclib)\b|\bread_(?:csv|json|table|excel|parquet|html|xml|fwf|feather|pickle|sas|stata)\s*\(\s*['"]https?:`;
const PYTHON_HTTP_PATTERN=new RegExp(PYTHON_HTTP,"i");
const PYTHON_SOCKET=String.raw`\bsocket\.(?:create_connection|socket|getaddrinfo)\b`;
const NETWORK_RULES=[
  ["cli-fetch",/\b(?:curl|wget|aria2c|lynx|w3m|httpie)\b|\bgh\s+(?:api|repo|pr|issue|release|search|gist)\b/i],
  ["git-network",/\bgit\b[^\n;|&]{0,120}?\b(?:clone|fetch|pull|ls-remote|remote\s+(?:add|update|show)|submodule\s+(?:update|add|sync)|lfs\s+(?:pull|fetch))\b/i],
  ["vcs-network",/\b(?:svn|hg|bzr)\s+(?:checkout|co|clone|export|pull|update|up|fetch|branch|incoming)\b/i],
  ["remote-shell",/(?<!\bservice\s+)\b(?:ssh|scp|sftp|lftp|ftp|telnet|socat)(?![\w-])(?!\s+(?:start|stop|restart|status|reload)\b)\s+\S|\bopenssl\s+s_client\b|\b(?:nc|ncat|netcat)\s+(?:-\w+\s+)*[\w.-]+\s+\d{1,5}\b|\/dev\/(?:tcp|udp)\/|\brsync\b[^\n;|&]*?(?:rsync:\/\/|\s(?:[\w.-]+@)?[A-Za-z0-9][\w.-]*::?[/~\w])/i],
  ["python-http",new RegExp(PYTHON_HTTP+"|"+PYTHON_SOCKET,"i")],
  ["node-http",/\bfetch\s*\(\s*['"`]https?:|(?<![\w$.])fetch\s*\(\s*(?:`|[A-Za-z_$][\w$.]*\s*[,)])|\bhttps?\.(?:get|request)\s*\(|\brequire\s*\(\s*['"](?:node:)?https['"]\s*\)|\bfrom\s+['"](?:node:)?https['"]|\baxios\b|\bundici\b|\bnode-fetch\b/i],
  ["data-download",/\b(?:hf_hub_download|snapshot_download|fetch_openml|load_state_dict_from_url|download_url_to_file|nltk\.download|torch\.hub\.load|keras\.utils\.get_file|gdown|pooch\.retrieve)\b|\bdownload_file\s*\(|\b(?:huggingface-cli|hf)\s+download\b|\bkaggle\s+(?:datasets|competitions|kernels|models)\s+download\b|\bdocker\s+pull\b|\bload_dataset\s*\(\s*['"](?![.\/~])(?!(?:csv|json|parquet|text|arrow|pandas|imagefolder|audiofolder|webdataset)['"])[\w.\/-]+['"]/i],
  ["skill-fetch",/\b(?:fetch-codex-manual|resolve-latest-model-info|install-skill-from-github|github_utils)\.(?:mjs|js|py)\b|\bimage_gen\.py\b/i],
  ["hosted-endpoint",/\b(?:api|auth|chat)\.openai\.com\b|\bchatgpt\.com\b|\bOPENAI_API_KEY\b|(?:\.codex|codex-home|CODEX_HOME)[^\s'"`]*\/auth\.json\b|\bcodex\s+mcp\s+add\b|^\s*(?:import\s+openai\b|from\s+openai\s+import\b)/m],
  ["package-install",new RegExp([
    PIP+String.raw`\s+(?:install|download|wheel|index|search)\b`,
    String.raw`\b(?:conda|mamba|micromamba)\s+(?:install|create|update|upgrade|search|env\s+(?:create|update))\b`,
    String.raw`\b(?:npm|pnpm|yarn)\s+(?:install|i|ci|add|update|upgrade|up|view|info|show|pack|exec|dlx|create)\b`,
    // Bare `npx <bin>` runs a locally installed binary; only an explicit package fetch is flagged here
    // (an npx registry download shown in the output is caught where the output is paired).
    String.raw`\b(?:npx|pnpx|bunx)\s+(?:-y|--yes|-p|--package)\b`,
    String.raw`\bbun\s+(?:add|install|i|update|x|create)\b`,
    String.raw`\bdeno\s+(?:run|install|cache|add|compile)\b[^\n;|&]*?(?:https?:|npm:|jsr:)`,
    String.raw`\b(?:apt|apt-get|aptitude|apk|yum|dnf|zypper|brew)\s+(?:install|update|upgrade|add|source|download|fetch)\b|\bpacman\s+-S`,
    String.raw`\bcargo\s+(?:install|add|fetch|update|search|vendor)\b`,
    String.raw`\bgo\s+(?:get|install|mod\s+(?:download|tidy|vendor))\b`,
    String.raw`\bgem\s+(?:install|fetch|update)\b|\bbundle\s+(?:install|update|add)\b|\bcomposer\s+(?:require|install|update|create-project)\b`,
    String.raw`\bpoetry\s+(?:add|install|update|lock)\b|\bpipx\s+(?:install|run|inject|upgrade)\b|\buvx\b|\buv\s+(?:add|sync|lock|tool\s+(?:install|run|upgrade)|run\s+--with)\b|\beasy_install\b|\bsetup\.py\s+(?:install|develop)\b`,
    String.raw`\binstall\.packages\s*\(|\bPkg\.add\s*\(|\b(?:luarocks|opam|nimble)\s+install\b|\bcabal\s+(?:install|update)\b|\bdotnet\s+(?:add\s+\S+\s+package|restore|tool\s+install)\b|\bmvn\b[^\n;|&]*\bdependency:(?:get|resolve|copy)\b`,
  ].join("|"),"i")],
];
const NON_NETWORK_KINDS=new Set(["git-history","verifier-path","project-copy"]);
const PATCH_BODY=/\*\*\* Begin Patch[\s\S]*?(?:\*\*\* End Patch|$)/g;
// Python socket destinations: the host in `connect((host, port))`, `create_connection((host, port))`,
// `bind((host, port))` or `getaddrinfo(host, ...)`. C-style `connect(fd, ...)` carries no host.
const SOCKET_TARGET=/\b(?:create_connection|connect(?:_ex)?|bind)\s*\(\s*\(\s*([^,()\n]*)|\bgetaddrinfo\s*\(\s*([^,()\n]*)/g;
// Commands that fetch packages only when needed: flagged when the paired output shows a download. Bare
// `npx <bin>` runs a local binary unless npm installs it; builds download only uncached dependencies.
const OUTPUT_FETCH=[
  [/\b(?:npx|pnpx|bunx)\s+(?!-y\b|--yes\b|-p\b|--package\b)\S/i,/need to install the following packages|(?:was|were) not found and will be installed|npm (?:warn|WARN) exec\b/i],
  [/\bcargo\s+(?:build|run|test|check|clippy|doc|bench|tree|metadata|generate-lockfile)\b/i,/^\s*(?:Updating\s+(?:crates\.io|`[^`\n]+`)\s+index|Download(?:ing|ed)\s+(?:crates\b|[\w-]+\s+v\d))/im],
  [/\bgo\s+(?:build|run|test|vet|generate|list|install)\b/i,/^go: (?:downloading|finding)\s/im],
  [/\b(?:mvnw?|gradlew?|sbt|lein)\b/i,/\bDownload(?:ing|ed)?(?:\s+from\s+[\w.-]+:)?\s+https?:\/\//i],
];
const mayFetchOnRun=command=>OUTPUT_FETCH.some(([run])=>run.test(command));
const outputShowsFetch=(command,output)=>OUTPUT_FETCH.some(([run,fetched])=>run.test(command)&&fetched.test(output));

// `git` followed by its global options, then the subcommand.
const GIT=String.raw`\bgit(?:\s+(?:-[Cc]\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;|&]+)|--?[A-Za-z][\w-]*(?:=[^\s;|&]+)?))*\s+`;
// Reads of refs, objects or history beyond the checked-out branch. `git log`, `git diff` and `git show`
// on the current history stay unflagged.
const GIT_HISTORY=[
  /\bgit\b[^\n;|&]{0,80}?\b(?:log|rev-list|show|shortlog|whatchanged|branch|for-each-ref|describe|tag|cat-file|ls-tree|diff|name-rev)\b[^\n;|&]{0,160}?(?:--all\b|--remotes\b|--branches\b|--tags\b|--glob\b|--reflog\b|--walk-reflogs\b|\borigin\/|\brefs\/|\bFETCH_HEAD\b|\bORIG_HEAD\b|@\{u\})/i,
  new RegExp(GIT+String.raw`(?:reflog|fsck|show-ref|for-each-ref|count-objects)\b`),
  new RegExp(GIT+String.raw`stash\s+(?:list|show)\b`),
  new RegExp(GIT+String.raw`(?:log|shortlog|whatchanged)\b[^\n;|&]*?\s-g\b`),
  new RegExp(GIT+String.raw`tag\b(?=\s*(?:$|[\n|;&)"'\`<>]|\d>|-l\b|-n\d*\b|-i\b|--(?:list|contains|no-contains|points-at|merged|no-merged|sort|format|column|ignore-case)\b))`),
  new RegExp(GIT+String.raw`branch\b[^\n;|&]*?\s(?:-[A-Za-z]*[arv][A-Za-z]*\b|--(?:all|remotes|verbose|contains|no-contains|merged|no-merged|points-at)\b)`),
  new RegExp(GIT+String.raw`cat-file\b[^\n;|&]*?--batch-all-objects\b`),
  new RegExp(GIT+String.raw`describe\b[^\n;|&]*?--(?:contains|all)\b`),
  /\.git\/(?:packed-refs|refs|logs|FETCH_HEAD|ORIG_HEAD)\b|\b(?:ORIG|FETCH)_HEAD\b/,
];
// A path that starts at the filesystem root: preceded by nothing, whitespace, a quote, `(`, `=`, `:`, a
// redirection or a separator, never by a word character, `.` or `/` (so /app/tests and ./tests are local).
const PATH_LEAD=String.raw`(?:^|[\s'"\`(=:<>,[{|;&])`;
const VERIFIER_PATH=[
  new RegExp(PATH_LEAD+String.raw`\/(?:tests|solution|oracle|installed-agent)(?:\/|\b)`,"i"),
  /\btest_outputs\.py\b|\bsolution\.sh\b|\/logs\/verifier\b/i,
  // Harbor's /logs mount outside the agent's own /logs/agent (verifier output, collected artifacts).
  new RegExp(PATH_LEAD+String.raw`\/logs(?!\/agent(?:\/|\b))(?:\/|\b)`,"i"),
  // `cd /` then a relative tests/, solution/, oracle/ or logs/ path (until the next cd).
  /\bcd\s+\/(?=[\s;&|)"'`]|$)(?:(?!\bcd\s)[^\n]){0,240}?(?:^|[\s'"`(=:<>,])(?:\.\/)?(?:tests|solution|oracle|logs(?!\/agent(?:\/|\b)))(?:\/|\b)/i,
  // A filesystem-wide search for verifier or reference-solution files (an agent's own solution.py is not one).
  /\bfind\s+\/(?=[\s"'`])[^\n;|&]{0,200}?-(?:i?name|i?path|i?wholename|i?regex)\s+['"]?[^\s'"]*(?:test_outputs|oracle|verifier|solution(?![\w-]*\.(?!sh\b)\w))/i,
];
// A listing (find, ls -d) that shows a verifier or solution path exists inside the container.
const VERIFIER_LISTING=/^\s*(?:\/(?:tests|solution|oracle)(?:\/\S*)?|\/logs\/verifier\/\S+)\s*$/im;
// `ls /` (any flags) whose output names a tests, solution or oracle directory at the filesystem root.
const ROOT_LISTING_COMMAND=/\bls(?:\s+-[\w-]+(?:=\S+)?)*\s+\/(?=$|[\s;|&)'"`])/m;
const ROOT_LISTING_ENTRY=/(?:^|[ \t])(?:tests|solution|oracle)\/?(?=[ \t]|$)/m;
const verifierListed=(command,output)=>VERIFIER_LISTING.test(output)||(ROOT_LISTING_COMMAND.test(command)&&ROOT_LISTING_ENTRY.test(output));

const URL_PATTERN=/https?:\/\/[^\s"'`\\)<>\]]+/gi;
const SCP_REMOTE=/(?:^|[\s'"=])[\w.-]+@([A-Za-z0-9][\w-]*(?:\.[\w-]+)+):(?!\/\/)/g;
const BARE_CODE_HOST=/(?:^|[\s'"(=@])((?:[\w-]+\.)*(?:github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|pypi\.org|pythonhosted\.org|npmjs\.(?:org|com)|huggingface\.co|code\.djangoproject\.com|bugs\.python\.org))(?=\/)/gi;
const LOCAL_HOST=/^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|example\.(?:com|org|net)|host\.docker\.internal)$/i;
// Loopback and example hosts, and single-label names (task compose services such as `main` or
// `asset-ledger`), which public DNS cannot resolve.
const isLocalHost=host=>LOCAL_HOST.test(host)||!/[.:]/.test(host);
const LOOPBACK_HOST=/^(?:|localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1?|\[::1?\])$/i;
const NETWORK_FAILURE=/could not resolve host|name or service not known|temporary failure in name resolution|network is unreachable|connection refused|connection reset|connection timed out|timed out|failed to establish a new connection|urlopen error|max retries exceeded|nodename nor servname|getaddrinfo|no route to host|connectionerror|http error [45]\d\d|\b(?:401|403|404|410|429|451|500|502|503|504)\s+(?:client error|server error|unauthorized|forbidden|not found|gone|too many requests|internal server error|bad gateway|service unavailable|gateway time-?out)|rate limit|ssl(?:error|_error|: )|certificate verify failed|could not find a version that satisfies|no matching distribution found|curl: \(\d+\)|"message"\s*:\s*"(?:not found|bad credentials|requires authentication|api rate limit exceeded)/i;
const OUTPUT_FRAME_LINE=/^\s*(?:Script (?:completed|failed|timed out|running)\b|Wall time\b|Output:\s*$|Exit code:|Process exited with code|Process running with session ID|Chunk ID:|Original token count:|Total output lines:)/i;
const OUTPUT_NOISE_LINE=/^\s*(?:File "[^"]*", line \d+|[\w.]*(?:Error|Exception)\b|raise\b|During handling of the above exception|\^+\s*$|[*<>]\s|curl: \(\d+\)|HTTP\/[\d.]+\s+\d{3}\b|(?:content-|x-|access-control-|cache-control|date|server|etag|vary|location|set-cookie|strict-transport|via|age|accept-ranges|last-modified|expires|connection|transfer-encoding|alt-svc|cf-)[\w-]*:\s)/i;
const PACKAGE_FETCHED=/\b(?:Downloading|Saved|Successfully (?:installed|downloaded))\b/;
// A response from the OpenAI API (raw JSON or a printed client object).
const HOSTED_MODEL_RESPONSE=/"object"\s*:\s*"(?:response|chat\.completion|text_completion|model|list|embedding)"|\bresp_[0-9a-f]{16,}\b|\bchatcmpl-[A-Za-z0-9]{10,}\b/;
// Fetches of the benchmark itself: Terminal-Bench task repositories and SWE-bench datasets or tooling.
const BENCHMARK_SOURCE=/\b(?:laude-institute|harbor-framework)\/terminal-bench\b|\bterminal-bench\/(?:original-)?tasks\/|\b(?:princeton-nlp|swe-bench|nebius|SWE-Gym)\/SWE-[\w.-]+|\bdatasets\/[\w.-]+\/SWE-(?:bench|smith|Gym)[\w.-]*|\bswe-bench\.github\.io\b|\bswebench\.com\b/i;
const BENCHMARK_PACKAGE=new RegExp(PIP+String.raw`\s+(?:install|download|wheel)\b[^\n;|&]*?\b(?:swe-?bench|terminal-bench)\b`,"i");
const PROJECT_PACKAGE_FETCH=new RegExp(PIP+String.raw`\s+(?:install|download|wheel)\b([^\n;|&]*)|\b(?:conda|mamba|micromamba)\s+install\b([^\n;|&]*)`,"gi");
const NATIVE_COMMAND_TOOL=/^trebell_terminal\./;
const NATIVE_WEB_EVENT=/web|search|brows|fetch|http/i;
// Findings kept out of the evidence list: unrecorded-command counts and informational tool offers.
const NON_EVIDENCE_KINDS=new Set(["unlogged-command","unaudited-command","tools-offered"]);
// Names in a printed tool list (`ALL_TOOLS`), raw or JSON-escaped.
const TOOL_LIST_NAME=/\\?"name\\?"\s*:\s*\\?"([A-Za-z0-9_]+)\\?"/g;
// Native logging caps (src/native-agent-loop.mjs): gateCommand keeps 24,000 characters; builds before it
// existed kept only a 1,200-character redactedCommand; background process events keep 1,000.
const GATE_COMMAND_CAP=24_000,REDACTED_COMMAND_CAP=1_200,BACKGROUND_COMMAND_CAP=1_000;
const SNIPPET_CHARS=600,OUTPUT_CHARS=400,MAX_FINDINGS=60,EVIDENCE_ITEMS=8;

function unescapeJs(text){return String(text||"").replace(/\\n/g,"\n").replace(/\\t/g,"\t").replace(/\\"/g,'"').replace(/\\'/g,"'").replace(/\\\\/g,"\\")}
const escapeRegExp=text=>String(text).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const normalizeCommand=text=>String(text||"").replace(/[\\'"`\s]+/g,"");
const normalizePackage=name=>String(name||"").toLowerCase().replace(/[-_.]+/g,"-");
function withStats(findings,stats){return Object.defineProperty(findings,"stats",{value:stats,enumerable:false,configurable:true})}

export function externalHosts(text,{schemeless=false}={}){
  const hosts=new Set(),value=String(text||"");
  const keep=host=>{const name=String(host||"").toLowerCase().replace(/\.$/,"");if(name&&!isLocalHost(name))hosts.add(name)};
  for(const match of value.matchAll(URL_PATTERN)){try{keep(new URL(match[0]).hostname)}catch{}}
  if(schemeless){for(const match of value.matchAll(SCP_REMOTE))keep(match[1]);for(const match of value.matchAll(BARE_CODE_HOST))keep(match[1])}
  return [...hosts];
}

// Task identity from a Harbor trial directory name (`<task>__<suffix>`). SWE-bench task ids
// (`<org>__<repo>-<number>`) also name the upstream project, so fetches of that project can be recognised.
export function taskContextFromTrialName(name){
  const taskId=String(name||"").replace(/__[A-Za-z0-9]{6,10}$/,"")||null;
  const match=/^([A-Za-z0-9][\w.-]*)__([A-Za-z0-9][\w.-]*?)-(\d+)$/.exec(taskId||"");
  return {taskId,project:match?{org:match[1],repo:match[2]}:null};
}
const PROJECT_PATTERNS=new Map();
function projectPatterns({org,repo}){
  const key=`${org}/${repo}`;
  if(!PROJECT_PATTERNS.has(key)){
    const path=`${escapeRegExp(org)}\\/${escapeRegExp(repo)}`,name=escapeRegExp(repo);
    PROJECT_PATTERNS.set(key,{
      upstream:new RegExp(String.raw`(?:\bgithub\.com|\bgitlab\.com|\bbitbucket\.org|\bgithubusercontent\.com|\bapi\.github\.com\/repos)[\/:]${path}(?:\.git)?(?![\w.-])|\brepo:${path}(?![\w.-])`,"i"),
      copy:new RegExp(String.raw`(?:site|dist)-packages\/${name}(?=[\/\s'"\`]|$)|\b_vendor\/${name}\b|\/pkgs\/${name}-\d`,"i"),
    });
  }
  return PROJECT_PATTERNS.get(key);
}
function projectPackageFetch(text,{repo}){
  const wanted=normalizePackage(repo);
  for(const match of String(text||"").matchAll(PROJECT_PACKAGE_FETCH)){
    for(const token of String(match[1]??match[2]??"").split(/\s+/)){
      const value=token.replace(/^['"]+|['"]+$/g,"");if(!value||value.startsWith("-"))continue;
      const name=/^[A-Za-z0-9][\w.-]*/.exec(value)?.[0];
      if(name&&normalizePackage(name)===wanted)return true;
    }
  }
  return false;
}
// A site of the project itself (issue tracker, docs), recognised by the repository name in a host label
// (code.djangoproject.com, www.sphinx-doc.org). A suspect for review, never a leak by itself: the
// ledger counts documentation lookups as valid.
function projectSiteHost(text,{repo}){
  const name=String(repo||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  if(name.length<4)return false;
  return externalHosts(text).some(host=>host.split(".").slice(0,-1).some(label=>label.replace(/[^a-z0-9]/g,"").includes(name)));
}
// Where a network command points at the task's own upstream project or at the benchmark itself.
function upstreamReference(text,context){
  const value=String(text||"");
  if(BENCHMARK_PACKAGE.test(value))return {target:"benchmark",via:"package"};
  if(BENCHMARK_SOURCE.test(value))return {target:"benchmark",via:"url"};
  if(context?.taskId?.includes("__")&&value.includes(context.taskId))return {target:"benchmark",via:"task-id"};
  if(context?.project){
    if(projectPatterns(context.project).upstream.test(value))return {target:"project",via:"url"};
    if(projectPackageFetch(value,context.project))return {target:"project",via:"package"};
    if(projectSiteHost(value,context.project))return {target:"project-site",via:"url"};
  }
  return null;
}
// True when an output carries real content rather than only errors, tracebacks, headers or tool framing.
function returnedContent(text){
  const value=String(text||"");let chars=0,traceback=false;
  for(const line of value.split(/\r?\n/)){
    if(traceback){if(!line.trim()||/^\s/.test(line))continue;traceback=false;continue}
    if(/^\s*Traceback \(most recent call last\)/.test(line)){traceback=true;continue}
    if(!line.trim()||OUTPUT_FRAME_LINE.test(line)||NETWORK_FAILURE.test(line)||OUTPUT_NOISE_LINE.test(line))continue;
    chars+=line.replace(/\s+/g,"").length;
  }
  return chars>=(NETWORK_FAILURE.test(value)?200:40);
}
function upstreamContentReturned(upstream,text){return upstream?.via==="package"?PACKAGE_FETCHED.test(String(text||"")):returnedContent(text)}
// The benchmark named in what a network command or hosted tool returned (search results or API listings
// that point at the benchmark's task repository, dataset or the SWE-bench task id). Project URLs are not
// used here: a repository's own files (setup.cfg, README) name them.
function outputReference(text,context){
  const value=String(text||"");
  if(BENCHMARK_SOURCE.test(value))return {target:"benchmark",via:"output"};
  if(context?.taskId?.includes("__")&&value.includes(context.taskId))return {target:"benchmark",via:"output"};
  return null;
}

// True when every socket the command opens targets loopback (a local test server), so a plain socket
// call is not counted as network access.
function loopbackSocketsOnly(value){
  if(PYTHON_HTTP_PATTERN.test(value))return false;
  const targets=[...value.matchAll(SOCKET_TARGET)].map(match=>(match[1]??match[2]).trim());
  if(!targets.length)return false;
  return targets.every(target=>{
    const literal=/^(['"])(.*)\1$/.exec(target);
    if(literal)return LOOPBACK_HOST.test(literal[2]);
    if(!/^[A-Za-z_]\w*$/.test(target))return false;
    const assigned=[...value.matchAll(new RegExp(String.raw`\b${target}\s*=\s*(['"])([^'"\n]*)\1`,"g"))].map(match=>match[2]);
    return assigned.length>0&&assigned.every(host=>LOOPBACK_HOST.test(host));
  });
}
export function classifyCommandText(text,{context=null}={}){
  const value=String(text||""),kinds=NETWORK_RULES.filter(([,pattern])=>pattern.test(value)).map(([kind])=>kind);
  if(kinds.includes("python-http")&&loopbackSocketsOnly(value))kinds.splice(kinds.indexOf("python-http"),1);
  if(GIT_HISTORY.some(pattern=>pattern.test(value)))kinds.push("git-history");
  if(VERIFIER_PATH.some(pattern=>pattern.test(value)))kinds.push("verifier-path");
  if(context?.project&&projectPatterns(context.project).copy.test(value))kinds.push("project-copy");
  return kinds;
}
// Kinds of a resolved shell command plus what its output shows: a download the command triggered or a
// verifier path it listed.
function commandKinds(command,output,context){
  const kinds=classifyCommandText(command,{context});
  if(outputShowsFetch(command,output)&&!kinds.includes("package-install"))kinds.push("package-install");
  if(verifierListed(command,output)&&!kinds.includes("verifier-path"))kinds.push("verifier-path");
  return kinds;
}
function outputText(output){
  if(output==null)return "";
  if(typeof output==="string")return output;
  if(Array.isArray(output))return output.map(part=>typeof part==="string"?part:part?.text??"").join("\n");
  if(typeof output==="object")return String(output.output??output.text??JSON.stringify(output));
  return String(output);
}
function parseLines(text){
  const rows=[];let line=0;
  for(const raw of String(text||"").split(/\r?\n/)){line++;if(!raw.trim())continue;try{rows.push({line,row:JSON.parse(raw)})}catch{}}
  return rows;
}
function unwrapShell(command){
  const match=/^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-\w*c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  if(!match)return command;
  return match[1]==="'"?match[2].replace(/'"'"'/g,"'").replace(/'\\''/g,"'"):match[2].replace(/\\(["\\$`])/g,"$1");
}
function commandFromParts(parts){
  if(Array.isArray(parts)){
    const list=parts.map(part=>String(part??""));
    return list.length>=3&&/(?:^|\/)(?:ba|z|da)?sh$/.test(list[0])&&/^-\w*c$/.test(list[1])?list.slice(2).join(" "):list.join(" ");
  }
  return unwrapShell(String(parts??""));
}
function collectStrings(value,out=[]){
  if(typeof value==="string")out.push(value);
  else if(Array.isArray(value))for(const item of value)collectStrings(item,out);
  else if(value&&typeof value==="object")for(const item of Object.values(value))collectStrings(item,out);
  return out;
}
function argumentText(args){
  if(args&&typeof args==="object")return collectStrings(args).join("\n");
  const raw=String(args??"");
  try{return collectStrings(JSON.parse(raw)).join("\n")}catch{return unescapeJs(raw)}
}
const mcpToolName=(server,tool)=>`mcp__${server||"server"}__${tool||"tool"}`.replace(/[^A-Za-z0-9_]/g,"_");
function mcpResultText(result){
  if(result==null)return "";
  if(Array.isArray(result?.content))return result.content.map(part=>part?.text??"").join("\n");
  return typeof result==="string"?result:JSON.stringify(result);
}
// Tools named in code-mode JavaScript: direct calls (`tools.x(`, `tools?.x(`, `tools["x"](`, `.call`),
// references that may be called through an alias or destructuring, and run-time dispatch (`tools[name]`).
function jsToolReferences(source){
  const called=new Set(),referenced=new Set();let dynamic=false;
  for(const match of source.matchAll(/\btools\s*(?:\?\.|\.)\s*([A-Za-z0-9_]+)(\s*(?:\?\.\s*)?\(|\s*\.\s*(?:call|apply)\s*\()?/g))(match[2]?called:referenced).add(match[1]);
  for(const match of source.matchAll(/\btools\s*\[\s*(['"`])([A-Za-z0-9_]+)\1\s*\](\s*(?:\?\.\s*)?\(|\s*\.\s*(?:call|apply)\s*\()?/g))(match[3]?called:referenced).add(match[2]);
  if(/\btools\s*\[\s*(?!['"`][A-Za-z0-9_]+['"`]\s*\])|\bObject\.(?:values|entries)\s*\(\s*tools\s*\)/.test(source))dynamic=true;
  for(const match of source.matchAll(/\{([^{}]*)\}\s*=\s*(?:await\s+)?tools\b(?!\s*(?:\?\.|\.|\[))/g)){
    for(const part of match[1].split(",")){const key=part.trim();if(!key)continue;if(key.startsWith("..."))dynamic=true;else referenced.add(key.split(":")[0].trim())}
  }
  for(const name of called)referenced.delete(name);
  return {called,referenced,dynamic};
}
const hasNetworkKind=kinds=>kinds.some(kind=>!NON_NETWORK_KINDS.has(kind));
// True when a call's network hits all sit inside apply_patch bodies: code written to a file, not a
// command that ran. Such hits still need review (the file may be executed later) but are counted apart.
function networkOnlyInPatch(text,kinds,context,{wholePatch=false}={}){
  if(!hasNetworkKind(kinds))return false;
  if(wholePatch)return true;
  if(!/\*\*\* Begin Patch/.test(text))return false;
  return !hasNetworkKind(classifyCommandText(text.replace(PATCH_BODY," "),{context}));
}
const isLeakTarget=upstream=>Boolean(upstream)&&upstream.target!=="project-site";
function markUpstream(finding,text,context){
  if(isLeakTarget(finding.upstream)||!hasNetworkKind(finding.kinds))return finding;
  const upstream=upstreamReference(text,context);
  if(upstream&&(!finding.upstream||isLeakTarget(upstream)))Object.assign(finding,{upstream,contentReturned:null});
  return finding;
}
function commandFinding(kinds,text,{file,line,callId=null,context=null,source=null}){
  const finding={kind:"command",kinds,hosts:externalHosts(text,{schemeless:true}),file,line,callId,...(source?{source}:{}),snippet:String(text).slice(0,SNIPPET_CHARS)};
  return markUpstream(finding,text,context);
}
function annotateOutput(finding,output,context=null){
  const text=outputText(output);
  Object.assign(finding,{output:text.slice(0,OUTPUT_CHARS),outputChars:text.length,outputHosts:externalHosts(text).slice(0,12),networkFailureSeen:NETWORK_FAILURE.test(text)});
  const reference=outputReference(text,context);
  if(finding.kind==="hosted-web"){if(reference)finding.outputReference=reference;return finding}
  if(finding.kind!=="command"||finding.writtenCode||!hasNetworkKind(finding.kinds))return finding;
  if(reference&&!isLeakTarget(finding.upstream))finding.upstream=reference;
  if(finding.upstream)finding.contentReturned=upstreamContentReturned(finding.upstream,text);
  // A shell call that got a response from the OpenAI/ChatGPT API used a hosted model (which can search).
  if(finding.kinds.includes("hosted-endpoint")&&HOSTED_MODEL_RESPONSE.test(text))finding.hostedEndpointReached=true;
  return finding;
}

export function auditCodexRolloutText(text,{file=null,context=null}={}){
  const rows=parseLines(text),findings=[],byCall=new Map(),calls=[],callsById=new Map();
  // Codex records every executed hosted call as an event (Extension web.*, McpToolCall). When a rollout
  // carries events, a hosted call without one failed or was never reached.
  const eventCoverage=rows.some(({row})=>row?.type==="event_msg"&&row.payload?.type==="item_completed");
  let open=null,auditedCommands=0;const offered=new Set();
  const add=(finding,callId)=>{findings.push(finding);if(callId){if(!byCall.has(callId))byCall.set(callId,[]);byCall.get(callId).push(finding)}return finding};
  const hostedExecution=(tool,line,snippet,{failed=false,output=null}={})=>{
    const call=open,mcp=/mcp/i.test(tool);
    const pending=call?.hosted.find(finding=>finding.executed!==true&&/mcp/i.test(finding.tool)===mcp)||call?.hosted.find(finding=>finding.executed!==true);
    if(call)call.executions++;
    if(pending){Object.assign(pending,{executed:!failed,eventLine:line});return}
    const finding=add({kind:"hosted-web",tool,file,line,callId:call?.callId||null,executed:!failed,snippet:String(snippet||"").slice(0,SNIPPET_CHARS)},call?.callId);
    if(call)call.hosted.push(finding);
    if(output!=null)annotateOutput(finding,output,context);
  };
  const closeCall=call=>{
    if(call.closed)return;call.closed=true;
    // Every hosted call that runs is recorded as an event; with event coverage and no event, the call
    // failed or never ran (an attempt). Without event coverage it is presumed to have run.
    for(const finding of call.hosted)if(finding.executed==null&&eventCoverage)Object.assign(finding,{executed:false,note:call.output!=null&&TOOL_CALL_FAILURE.test(call.output)?"call failed":"no execution event"});
    for(const name of call.referenced){
      if(HOSTED_WEB_TOOL.test(name)&&call.executions>0)continue;
      add({kind:"unknown-tool",tool:name,file,line:call.line,callId:call.callId,note:"referenced without a direct call",snippet:call.snippet},call.callId);
    }
    if(call.dynamic&&!call.executions)add({kind:"unknown-tool",tool:"tools[dynamic]",file,line:call.line,callId:call.callId,note:"tool chosen at run time",snippet:call.snippet},call.callId);
  };
  // Kinds learned from a call's output (a download it triggered, a verifier path it listed).
  const addCallKinds=(call,kinds)=>{
    if(!call.command){call.command=add(commandFinding(kinds,call.text,{file,line:call.line,callId:call.callId,context}),call.callId);return call.command}
    for(const kind of kinds)if(!call.command.kinds.includes(kind))call.command.kinds.push(kind);
    if(hasNetworkKind(kinds))delete call.command.writtenCode;
    return call.command;
  };
  const startCall=(payload,line)=>{
    const type=payload.type,callId=payload.call_id||null;let plain="",refs;
    if(type==="custom_tool_call"){const raw=String(payload.input||"");refs=jsToolReferences(raw);if(payload.name&&payload.name!=="exec")refs.called.add(String(payload.name));plain=unescapeJs(raw)}
    else if(type==="function_call"){refs={called:new Set([String(payload.name||"")]),referenced:new Set(),dynamic:false};plain=argumentText(payload.arguments)}
    else{refs={called:new Set(["local_shell"]),referenced:new Set(),dynamic:false};plain=commandFromParts(payload.action?.command)}
    const call={callId,line,text:plain,snippet:plain.slice(0,SNIPPET_CHARS),norm:normalizeCommand(plain),hosted:[],referenced:[],dynamic:refs.dynamic,executions:0,command:null,fetchOnRun:mayFetchOnRun(plain),output:null,closed:false};
    calls.push(call);if(callId)callsById.set(callId,call);open=call;
    if([...refs.called].some(name=>COMMAND_CODEX_TOOLS.has(name)))auditedCommands++;
    for(const name of refs.called){
      if(USER_INPUT_TOOL.test(name))add({kind:"user-input",tool:name,file,line,callId,snippet:call.snippet},callId);
      else if(LOCAL_CODEX_TOOLS.has(name))continue;
      else if(HOSTED_WEB_TOOL.test(name))call.hosted.push(add({kind:"hosted-web",tool:name,file,line,callId,executed:null,snippet:call.snippet},callId));
      else add({kind:"unknown-tool",tool:name,file,line,callId,snippet:call.snippet},callId);
    }
    for(const name of refs.referenced)if(!LOCAL_CODEX_TOOLS.has(name)&&!USER_INPUT_TOOL.test(name))call.referenced.push(name);
    const kinds=classifyCommandText(plain,{context});
    if(kinds.length){
      const finding=commandFinding(kinds,plain,{file,line,callId,context});
      if(networkOnlyInPatch(plain,kinds,context,{wholePatch:payload.name==="apply_patch"}))finding.writtenCode=true;
      call.command=add(finding,callId);
    }
  };
  const finishCall=payload=>{
    const call=callsById.get(payload.call_id);if(!call)return;
    const output=outputText(payload.output);call.output=output;
    if(call.fetchOnRun&&outputShowsFetch(call.text,output))addCallKinds(call,["package-install"]);
    if(verifierListed(call.text,output))addCallKinds(call,["verifier-path"]).verifierPathSeen=true;
    // A printed tool list (ALL_TOOLS) shows which non-local tools the lane offered.
    if(/\bALL_TOOLS\b/.test(call.text))for(const match of output.matchAll(TOOL_LIST_NAME))if(!LOCAL_CODEX_TOOLS.has(match[1]))offered.add(match[1]);
    closeCall(call);
    for(const finding of byCall.get(call.callId)||[])if(finding.output==null)annotateOutput(finding,output,context);
    if(open===call)open=null;
  };
  // Resolved shell commands (CommandExecution events) catch commands that the exec JavaScript built at
  // run time; each is merged into the exec call that ran it.
  const commandExecution=(item,line)=>{
    const command=commandFromParts(item.command),output=String(item.aggregated_output??item.stdout??"");
    if(!command.trim())return;
    const kinds=commandKinds(command,output,context),listed=verifierListed(command,output);
    if(!kinds.length)return;
    const prefix=normalizeCommand(command).slice(0,300);
    const call=(open&&prefix&&open.norm.includes(prefix)?open:null)||(prefix?calls.findLast(candidate=>candidate.norm.includes(prefix)):null)||open;
    const existing=call?.command;
    if(existing){
      for(const kind of kinds)if(!existing.kinds.includes(kind))existing.kinds.push(kind);
      existing.hosts=[...new Set([...existing.hosts,...externalHosts(command,{schemeless:true})])];
      if(listed)existing.verifierPathSeen=true;
      // A network command that actually ran: no longer only written code.
      if(existing.writtenCode&&hasNetworkKind(kinds))delete existing.writtenCode;
      markUpstream(existing,command,context);
      if(existing.output!=null)annotateOutput(existing,call.output??output,context);
      return;
    }
    const finding=add(commandFinding(kinds,command,{file,line,callId:call?.callId||null,context,source:"command-execution"}),call?.callId);
    if(listed)finding.verifierPathSeen=true;
    if(call)call.command=finding;
    if(!call||call.closed)annotateOutput(finding,output,context);
  };
  const eventItem=(item,line)=>{
    const type=String(item?.type||"");
    if(type==="CommandExecution")return commandExecution(item,line);
    if(type==="McpToolCall")return hostedExecution(mcpToolName(item.server,item.tool),line,JSON.stringify(item.arguments??{}),{failed:item.status==="failed"||Boolean(item.error),output:item.result!=null?mcpResultText(item.result):null});
    if(type==="WebSearch")return hostedExecution("web_search",line,JSON.stringify(item.action??item.query??item));
    if(type==="Extension"){
      const kind=String(item.kind||"");
      if(/^clock\./i.test(kind))return;
      if(/^(?:web|browser|search)\b/i.test(kind))return hostedExecution(`extension:${kind}`,line,JSON.stringify(item.action??item.query??item));
      add({kind:"unknown-tool",tool:`extension:${kind||"unknown"}`,file,line,callId:open?.callId||null,snippet:JSON.stringify(item).slice(0,SNIPPET_CHARS)},open?.callId);
      return;
    }
    if(type&&!QUIET_EVENT_ITEMS.has(type)&&TOOL_LIKE_ITEM.test(type))add({kind:"unknown-tool",tool:`item:${type}`,file,line,callId:open?.callId||null,snippet:JSON.stringify(item).slice(0,SNIPPET_CHARS)},open?.callId);
  };
  for(const {line,row} of rows){
    const payload=row?.payload||{};
    if(row?.type==="event_msg"){if(payload.type==="item_completed")eventItem(payload.item||{},line);continue}
    if(row?.type!=="response_item")continue;
    const type=String(payload.type||"");
    if(type==="web_search_call")hostedExecution("web_search_call",line,JSON.stringify(payload.action||payload));
    else if(type==="custom_tool_call"||type==="function_call"||type==="local_shell_call")startCall(payload,line);
    else if(type==="custom_tool_call_output"||type==="function_call_output"||type==="local_shell_call_output")finishCall(payload);
    else if(type==="mcp_call")hostedExecution(mcpToolName(payload.server_label,payload.name),line,String(payload.arguments||""),{failed:Boolean(payload.error),output:payload.output??null});
    else if(/_call$/.test(type))add({kind:"unknown-tool",tool:type,file,line,snippet:JSON.stringify(payload).slice(0,SNIPPET_CHARS)});
    else if(type==="message"&&!offered.has("recommended_plugins")&&/<recommended_plugins>/.test(outputText(payload.content)))offered.add("recommended_plugins");
  }
  for(const call of calls)closeCall(call);
  if(offered.size)findings.push({kind:"tools-offered",tools:[...offered].sort(),file,line:null,snippet:"non-local tools or plugin recommendations offered to the agent (informational)"});
  return withStats(findings,{auditedCommands});
}

// `codex exec --json` stream (agent/codex.txt): item.started/item.completed events for command_execution
// (command + aggregated_output), web_search and mcp_tool_call items. Each item is audited once, in its
// latest recorded state.
export function auditCodexExecStreamText(text,{file=null,context=null}={}){
  const items=new Map(),findings=[];let auditedCommands=0;
  for(const {line,row} of parseLines(text)){
    const item=row?.item;if(!item||typeof item!=="object"||!/^item\./.test(String(row.type||"")))continue;
    const id=String(item.id??`line-${line}`),completed=row.type==="item.completed",previous=items.get(id);
    if(!previous)items.set(id,{line,item,completed});
    else if(completed||!previous.completed)Object.assign(previous,{line,item,completed:completed||previous.completed});
  }
  for(const {line,item,completed} of items.values()){
    const type=String(item.type||"");
    if(type==="command_execution"){
      auditedCommands++;
      const command=unwrapShell(String(item.command??"")),output=String(item.aggregated_output??"");
      const kinds=commandKinds(command,output,context);
      if(!kinds.length)continue;
      const finding=commandFinding(kinds,command,{file,line,context});
      if(verifierListed(command,output))finding.verifierPathSeen=true;
      if(item.exit_code!=null)finding.exitCode=item.exit_code;
      findings.push(completed?annotateOutput(finding,output,context):finding);
    }else if(type==="web_search"){
      findings.push({kind:"hosted-web",tool:"web_search",file,line,executed:completed?true:null,snippet:JSON.stringify(item.action??{query:item.query}).slice(0,SNIPPET_CHARS)});
    }else if(type==="mcp_tool_call"){
      const failed=item.status==="failed"||Boolean(item.error);
      const finding={kind:"hosted-web",tool:mcpToolName(item.server,item.tool),file,line,executed:failed?false:completed?true:null,snippet:JSON.stringify(item.arguments??{}).slice(0,SNIPPET_CHARS)};
      findings.push(item.result!=null?annotateOutput(finding,mcpResultText(item.result),context):finding);
    }else if(type&&!QUIET_STREAM_ITEMS.has(type)&&TOOL_LIKE_ITEM.test(type)){
      findings.push({kind:"unknown-tool",tool:`item:${type}`,file,line,snippet:JSON.stringify(item).slice(0,SNIPPET_CHARS)});
    }
  }
  return withStats(findings,{auditedCommands});
}

export function auditNativeEventsText(text,{file=null,context=null}={}){
  const findings=[],byCall=new Map();let auditedCommands=0;
  for(const {line,row} of parseLines(text)){
    const data=row?.data||{};
    if(row?.name==="native.tool.requested"){
      const tool=`${data.namespace}.${data.name}`,audit=data.terminalAudit&&typeof data.terminalAudit==="object"?data.terminalAudit:null,callId=data.callId||null;
      if(!/^trebell_(?:repo|workspace|output|terminal|process)\./.test(tool))findings.push({kind:"unknown-tool",tool,file,line,callId,snippet:JSON.stringify(data).slice(0,SNIPPET_CHARS)});
      if(tool==="trebell_process.start"&&!audit){findings.push({kind:"unlogged-command",tool,file,line,callId,snippet:"process command is not recorded in the event log"});continue}
      const gate=audit?.gateCommand!=null?String(audit.gateCommand):null,redacted=audit?.redactedCommand!=null?String(audit.redactedCommand):null,command=gate??redacted??"";
      if(gate==null&&redacted==null){if(NATIVE_COMMAND_TOOL.test(tool))findings.push({kind:"unaudited-command",tool,file,line,callId,snippet:"command is not recorded in the event log"});continue}
      auditedCommands++;
      if(!command.trim())continue;
      if(gate!=null&&gate.length>=GATE_COMMAND_CAP)findings.push({kind:"truncated-command",tool,file,line,callId,commandChars:gate.length,snippet:`gateCommand stops at the ${GATE_COMMAND_CAP}-character logging cap; the rest of the command is not logged`});
      else if(gate==null&&redacted.length>=REDACTED_COMMAND_CAP)findings.push({kind:"partial-command",tool,file,line,callId,commandChars:redacted.length,snippet:`only the first ${REDACTED_COMMAND_CAP} characters (redactedCommand) are logged`});
      const kinds=classifyCommandText(command,{context});
      if(audit.networkLike===true&&!kinds.length)kinds.push("network-like");
      if(!kinds.length)continue;
      const finding=commandFinding(kinds,command,{file,line,callId,context});
      finding.hosts=[...new Set([...(Array.isArray(audit.hosts)?audit.hosts.map(host=>String(host).toLowerCase()):[]),...finding.hosts])].filter(host=>!isLocalHost(host));
      findings.push(finding);if(callId)byCall.set(callId,finding);
    }else if(row?.name==="native.tool.completed"&&byCall.has(data.callId)){
      Object.assign(byCall.get(data.callId),{success:data.success===true,error:data.error?String(data.error).slice(0,OUTPUT_CHARS):null});
    }else if(row?.name==="native.background.started"&&typeof data.command==="string"&&data.command.trim()){
      // trebell_process.start requests carry no command; the background event keeps its first 1,000 characters.
      if(data.command.length>=BACKGROUND_COMMAND_CAP)findings.push({kind:"partial-command",tool:"trebell_process.start",file,line,commandChars:data.command.length,snippet:`only the first ${BACKGROUND_COMMAND_CAP} characters of the background command are logged`});
      const kinds=classifyCommandText(data.command,{context});
      if(kinds.length)findings.push(commandFinding(kinds,data.command,{file,line,context,source:"background"}));
    }else if(NATIVE_WEB_EVENT.test(String(row?.name||""))&&!/^native\.(?:tool|model)\./.test(String(row.name))){
      // Native has no hosted web tools; an event named like one is reported until someone looks at it.
      findings.push({kind:"unknown-tool",tool:`event:${row.name}`,file,line,snippet:JSON.stringify(row).slice(0,SNIPPET_CHARS)});
    }
  }
  return withStats(findings,{auditedCommands});
}

function integrityStatus(summary){
  if(summary.hostedWebCalls>0||summary.upstreamLeaks>0)return "invalid";
  const unrecorded=(summary.unauditedCommands||0)+(summary.unloggedCommands||0);
  if(unrecorded>0&&!(summary.auditedCommands>0))return "unaudited";
  return summary.networkCommands||summary.writtenNetworkCode||summary.gitHistoryCommands||summary.verifierPathReads||summary.projectCopyReads||summary.userInputRequests||summary.hostedWebAttempts||summary.unknownTools?.length||unrecorded||summary.truncatedCommands||summary.partialCommands?"review":"clean";
}

export function summarizeIntegrityFindings(findings=[],stats=null){
  const list=Array.isArray(findings)?findings:[],commands=list.filter(finding=>finding.kind==="command"),hosted=list.filter(finding=>finding.kind==="hosted-web");
  const count=kind=>list.filter(finding=>finding.kind===kind).reduce((sum,finding)=>sum+Math.max(1,Number(finding.count)||1),0);
  const reached=commands.filter(finding=>finding.hostedEndpointReached);
  const summary={
    hostedWebCalls:hosted.filter(finding=>finding.executed!==false).length+reached.length,
    hostedWebTools:[...new Set([...hosted.map(finding=>finding.tool),...reached.map(finding=>`endpoint:${finding.hosts.find(host=>/openai|chatgpt/i.test(host))||"openai-client"}`)])],
    hostedWebAttempts:hosted.filter(finding=>finding.executed===false).length,
    networkCommands:commands.filter(finding=>!finding.writtenCode&&hasNetworkKind(finding.kinds)).length,
    writtenNetworkCode:commands.filter(finding=>finding.writtenCode&&hasNetworkKind(finding.kinds)).length,
    externalHosts:[...new Set(list.flatMap(finding=>[...(finding.hosts||[]),...(finding.outputHosts||[])]))].slice(0,40),
    upstreamLeaks:commands.filter(finding=>isLeakTarget(finding.upstream)&&finding.contentReturned===true).length,
    gitHistoryCommands:commands.filter(finding=>finding.kinds.includes("git-history")).length,
    verifierPathReads:commands.filter(finding=>finding.kinds.includes("verifier-path")).length,
    projectCopyReads:commands.filter(finding=>finding.kinds.includes("project-copy")).length,
    userInputRequests:list.filter(finding=>finding.kind==="user-input").length,
    unknownTools:[...new Set(list.filter(finding=>finding.kind==="unknown-tool").map(finding=>finding.tool))],
    unloggedCommands:count("unlogged-command"),
    unauditedCommands:count("unaudited-command"),
    truncatedCommands:count("truncated-command"),
    partialCommands:count("partial-command"),
    auditedCommands:Number((stats??list.stats)?.auditedCommands)||0,
    // Informational (does not change status): non-local tools a printed tool list or the prompt offered.
    hostedToolsOffered:[...new Set(list.filter(finding=>finding.kind==="tools-offered").flatMap(finding=>finding.tools||[]))],
  };
  summary.status=integrityStatus(summary);
  return summary;
}

// Job totals come from the uncapped per-trial summaries, never from the capped evidence lists.
export function mergeIntegritySummaries(summaries=[]){
  const merged=summarizeIntegrityFindings([],{auditedCommands:0});
  for(const summary of summaries){
    if(!summary)continue;
    for(const [key,value] of Object.entries(summary)){
      if(key==="status")continue;
      if(typeof value==="number")merged[key]=(Number(merged[key])||0)+value;
      else if(Array.isArray(value))merged[key]=[...new Set([...(merged[key]||[]),...value])];
    }
  }
  merged.externalHosts=merged.externalHosts.slice(0,40);
  merged.status=integrityStatus(merged);
  return merged;
}

function findingSeverity(finding){
  if(finding.kind==="hosted-web")return finding.executed===false?50:100;
  if(finding.kind==="command"){
    const kinds=finding.kinds||[];
    if(finding.hostedEndpointReached)return 100;
    if(isLeakTarget(finding.upstream))return finding.contentReturned===true?95:75;
    if(finding.upstream)return 72;
    if(kinds.includes("verifier-path"))return 85;
    if(kinds.includes("project-copy"))return 80;
    if(kinds.includes("hosted-endpoint"))return 78;
    if(kinds.includes("git-history"))return 70;
    if(finding.writtenCode)return 35;
    if(finding.hosts?.length||finding.outputHosts?.length)return finding.networkFailureSeen?45:60;
    return 40;
  }
  if(finding.kind==="user-input")return 55;
  if(finding.kind==="unknown-tool")return 52;
  if(finding.kind==="truncated-command"||finding.kind==="partial-command")return 20;
  return finding.kind==="tools-offered"?5:10;
}
function rankFindings(list){return list.map((finding,index)=>({finding,index,severity:findingSeverity(finding)})).sort((a,b)=>b.severity-a.severity||a.index-b.index).map(entry=>entry.finding)}
// Keep the most severe findings (in log order) when a trial has more than the stored maximum.
function capFindings(list){
  if(list.length<=MAX_FINDINGS)return list.slice();
  const keep=new Set(rankFindings(list).slice(0,MAX_FINDINGS));
  return list.filter(finding=>keep.has(finding));
}

async function walkFiles(root){
  const out=[];let entries=[];try{entries=await readdir(root,{withFileTypes:true})}catch{return out}
  for(const entry of entries){
    const path=join(root,entry.name);
    if(entry.isDirectory())out.push(...await walkFiles(path));
    else if(entry.isFile())out.push(path);
  }
  return out;
}
async function readText(path){try{return await readFile(path,"utf8")}catch{return null}}
// Tool calls an older Native build ran without writing trebell-native-events.jsonl.
async function nativeToolCallsWithoutEvents(logPath,metricsPath){
  let calls=0;
  for(const match of String((logPath&&await readText(logPath))||"").matchAll(/\bnativeToolCalls\s*[:=]\s*(\d+)/g))calls=Math.max(calls,Number(match[1]));
  try{calls=Math.max(calls,Number(JSON.parse((metricsPath&&await readText(metricsPath))||"{}")?.toolCalls)||0)}catch{}
  return calls;
}

export async function auditTrialDirectory(trialDir){
  const context=taskContextFromTrialName(basename(trialDir)),findings=[],logFiles=[],rollouts=new Map(),nativeEvents=[];
  let logs=0,auditedCommands=0,codexStream=null,nativeLog=null,nativeMetrics=null;
  const consume=(audited,name)=>{findings.push(...audited);auditedCommands+=Number(audited.stats?.auditedCommands)||0;logs++;logFiles.push(name)};
  for(const path of await walkFiles(join(trialDir,"agent"))){
    const name=path.split("\\").join("/");
    if(/\/codex-sessions\/.*\.jsonl$/.test(name)||/\/rollout-[^/]*\.jsonl$/.test(name)){
      const text=await readText(path);if(text==null)continue;
      const key=name.split("/").pop(),previous=rollouts.get(key);
      if(!previous||text.length>previous.text.length)rollouts.set(key,{name,text});
    }else if(/\/trebell-native-events\.jsonl$/.test(name)){const text=await readText(path);if(text!=null)nativeEvents.push({name,text})}
    else if(/\/agent\/codex\.txt$/.test(name))codexStream={path,name};
    else if(/\/agent\/trebell-native\.txt$/.test(name))nativeLog=path;
    else if(/\/agent\/trebell-native-metrics\.json$/.test(name))nativeMetrics=path;
  }
  for(const {name,text} of rollouts.values())consume(auditCodexRolloutText(text,{file:name,context}),name);
  const streamText=codexStream?await readText(codexStream.path):null;
  if(streamText!=null){
    const stream=auditCodexExecStreamText(streamText,{file:codexStream.name,context});
    if(!rollouts.size)consume(stream,codexStream.name);
    else{
      // Cross-check: hosted calls the exec stream records but the rollout parse did not see.
      const seen=findings.filter(finding=>finding.kind==="hosted-web"&&finding.executed!==false).length;
      const extra=stream.filter(finding=>finding.kind==="hosted-web"&&finding.executed!==false).slice(seen);
      if(extra.length){findings.push(...extra.map(finding=>({...finding,note:"recorded in codex.txt but not in the rollout"})));logFiles.push(codexStream.name)}
    }
  }
  for(const {name,text} of nativeEvents)consume(auditNativeEventsText(text,{file:name,context}),name);
  if(!nativeEvents.length&&(nativeLog||nativeMetrics)){
    const toolCalls=await nativeToolCallsWithoutEvents(nativeLog,nativeMetrics);
    if(toolCalls>0)findings.push({kind:"unaudited-command",tool:"trebell_native",count:toolCalls,file:String(nativeLog||nativeMetrics).split("\\").join("/"),line:null,snippet:`${toolCalls} Native tool calls ran but the trial kept no event log`});
  }
  // An agent that used model tokens but left no log to audit (a setup failure or an aborted trial never
  // reaches the model, so those stay "no-logs").
  if(!logs&&!findings.some(finding=>finding.kind==="unaudited-command")){
    let tokens=0;try{const usage=JSON.parse(await readText(join(trialDir,"result.json"))||"{}")?.agent_result;tokens=(Number(usage?.n_input_tokens)||0)+(Number(usage?.n_output_tokens)||0)}catch{}
    if(tokens>0)findings.push({kind:"unaudited-command",tool:"agent",count:1,file:join(trialDir,"result.json").split("\\").join("/"),line:null,snippet:`the agent used ${tokens} model tokens but the trial kept no agent log (number of commands unknown)`});
  }
  return {trialDir:trialDir.split("\\").join("/"),logs,logFiles,summary:summarizeIntegrityFindings(findings,{auditedCommands}),findings:capFindings(findings),findingsOmitted:Math.max(0,findings.length-MAX_FINDINGS)};
}

export async function auditJobIntegrity(outputRoot,jobName){
  let entries=[];try{entries=await readdir(join(outputRoot,jobName),{withFileTypes:true})}catch{return null}
  const trials=[];
  for(const entry of entries)if(entry.isDirectory())trials.push(await auditTrialDirectory(join(outputRoot,jobName,entry.name)));
  const audited=trials.filter(trial=>trial.logs>0||trial.summary.unauditedCommands>0);
  if(!audited.length)return {jobName,logs:0,summary:{...summarizeIntegrityFindings([]),status:"no-logs"},trials:[]};
  return {jobName,logs:audited.reduce((sum,trial)=>sum+trial.logs,0),summary:mergeIntegritySummaries(audited.map(trial=>trial.summary)),trials:audited};
}

export function compactIntegrity(audit){
  if(!audit)return null;
  const evidence=rankFindings(audit.trials.flatMap(trial=>trial.findings).filter(finding=>!NON_EVIDENCE_KINDS.has(finding.kind))).slice(0,EVIDENCE_ITEMS);
  return {status:audit.summary.status,logs:audit.logs,...audit.summary,evidence:evidence.map(finding=>({
    kind:finding.kind,kinds:finding.kinds,tool:finding.tool,hosts:finding.hosts,file:finding.file,line:finding.line,snippet:String(finding.snippet||"").slice(0,240),networkFailureSeen:finding.networkFailureSeen,
    ...(finding.upstream?{upstream:finding.upstream,contentReturned:finding.contentReturned}:{}),
    ...(finding.hostedEndpointReached?{hostedEndpointReached:true}:{}),
    ...(finding.outputReference?{outputReference:finding.outputReference}:{}),
    ...(finding.executed!=null?{executed:finding.executed}:{}),
    ...(finding.source?{source:finding.source}:{}),
    ...(finding.writtenCode?{writtenCode:true}:{}),
  }))};
}

async function main(){
  const outputRoot=process.argv[2],jobNames=process.argv.slice(3);
  if(!outputRoot)throw new Error("Usage: node scripts/benchmark-integrity-audit.mjs <jobs-root> [job-name ...]");
  const root=resolve(outputRoot),names=jobNames.length?jobNames:(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>entry.name);
  const results=[];
  for(const name of names){const audit=await auditJobIntegrity(root,name);if(audit)results.push({jobName:name,...compactIntegrity(audit)})}
  process.stdout.write(JSON.stringify(results,null,2)+"\n");
  if(results.some(result=>result.status==="invalid"))process.exitCode=2;
}

if(resolve(process.argv[1]||"")===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error?.message||error);process.exitCode=1});
