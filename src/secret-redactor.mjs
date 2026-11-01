import { homedir } from "node:os";
import { win32 } from "node:path";

const SECRET_ENV_KEY=/(?:^|_)(?:api_?key|token|secret|password|credential|authorization|cookie)(?:$|_)/i;
const SENSITIVE_KEYS=new Set([
  "authorization","apikey","xapikey","cookie","password","secret","accesstoken","refreshtoken","authtoken",
  "bearertoken","credential","credentials","proof","challenge","privatekey","clientsecret",
]);
const SECRET_FLAGS=new Set(["--api-key","--token","--password","--secret","--credential"]);

function normalizedKey(value){return String(value||"").replace(/[^a-z0-9]/gi,"").toLowerCase()}
export function isSecretEnvironmentName(value){return SECRET_ENV_KEY.test(String(value||""))}
export function isSecretCliFlag(value){return SECRET_FLAGS.has(String(value||"").trim().toLowerCase())}
export function isSecretCliArgument(value){return /^--(?:api-key|token|password|secret|credential)(?:=|$)/i.test(String(value||"").trim())}
export function withoutSecretEnvironment(value={}){
  if(!value||typeof value!=="object"||Array.isArray(value))return {};
  return Object.fromEntries(Object.entries(value).filter(([key])=>!isSecretEnvironmentName(key)));
}

// Text as Trebell shows, stores or sends it on: without the secrets a harness, an agent or a tool printed in it. A secret value
// becomes MASK, Trebell's one mark for it; an address that is itself the secret (a pairing link) goes whole and its mark says what
// it was. Two sets of shapes: MODEL_SHAPES for any text that can reach a model, which is the default, and PEOPLE_SHAPES, wider, for
// text only a person reads (forPeople), such as an agent's log excerpt (agent-log.mjs), which also hides Google sign-in links.
const MASK="[redacted]";
export const PAIRING_LINK_MARK="[redacted pairing link]";
const MODEL_PAIRING_MARK="[pairing-url]";

// Whether text already carries a mark that the redaction of text a model reads writes, in any case: [redacted] or [pairing-url].
export function showsRedactionMark(text){return /\[(?:redacted|pairing-url)\]/i.test(String(text??""))}

// ---- Web addresses ------------------------------------------------------------------------------------------------------
// RFC 3986 (appendix C) has text set an address off with white space, double quotes or angle brackets, and Markdown uses a
// backtick: an address runs from its http:// or https:// (any case, also inside a word) to the first of those. A scheme inside an
// address already read belongs to that address, so a link given as a parameter of another goes with the outer one, and a long
// run of schemes is read once.
const SCHEME_START=/https?:\/\//gi;
const ADDRESS_END=/[\s"<>`]/g;

// text with each web address in it passed to pick, which gives the text to show in its place, or null to keep it. ends, a global
// pattern, finds where an address ends: ADDRESS_END unless given.
export function replaceWebAddresses(text,pick,ends=ADDRESS_END){
  let shown="",copied=0,readTo=0;
  for(const scheme of text.matchAll(SCHEME_START)){
    if(scheme.index<readTo)continue;
    ends.lastIndex=scheme.index;
    readTo=ends.exec(text)?.index??text.length;
    const instead=pick(text.slice(scheme.index,readTo));
    if(instead==null)continue;
    shown+=text.slice(copied,scheme.index)+instead;
    copied=readTo;
  }
  return copied?shown+text.slice(copied):text;
}

// A pairing link: an address whose path has a "pair" segment right before its "#", the one-time pairing code after the "#".
const isPairingLink=address=>address.toLowerCase().includes("/pair#",address.indexOf("//")+2);

// ---- Credentials in text a person reads -----------------------------------------------------------------------------------
// Such text quotes files Native's tools read, so a credential is told from code by its shape and by how it is written, and only
// the credential's own characters become MASK: the field name, quotes, colon, blanks and scheme word stay as printed.

// The characters of a printed credential: RFC 9110's token68 and RFC 6750's b64token (letters, digits and - . _ ~ + /) with =, which
// is taken anywhere because some tokens join padded parts. CREDENTIAL_AT reads one such word where it is asked to.
const CREDENTIAL_AT=/[A-Za-z0-9._~+\/=-]+/y;
const ONE_CREDENTIAL_WORD=/^[A-Za-z0-9._~+\/=-]+$/;
function wordAt(text,at){
  CREDENTIAL_AT.lastIndex=at;
  return CREDENTIAL_AT.exec(text)?.[0]??"";
}

// A JSON Web Token in compact form (RFC 7519, RFC 7515 and RFC 7516): three or five base64url parts joined by dots, the first a JSON
// header, which base64url writes as eyJ.
function isJsonWebToken(word){
  if(!word.startsWith("eyJ"))return false;
  const parts=word.split(".");
  return (parts.length===3||parts.length===5)&&parts.every(part=>/^[\w-]*$/.test(part))&&parts[1]!=="";
}

// Random text that a person or a program could be holding as a credential: a JWT, or a dotless word holding letters and digits that
// is at least `shortest` long. A dotted word that is not a JWT is a member chain (request.headers.authorization) and never one.
function looksIssued(word,shortest){
  if(isJsonWebToken(word))return true;
  return !word.includes(".")&&word.length>=shortest&&/\d/.test(word)&&/[a-z]/i.test(word);
}

// Where a credential stands decides how short it may be. On a header line (RFC 9112 section 5) Trebell's tests hide values of 8;
// a value written as a string in code or JSON is where tests and documentation put short placeholders such as "invalid" or "tobi",
// while every documented API key family is longer than 16.
const SHORTEST_ON_HEADER_LINE=8;
const SHORTEST_IN_STRING=16;

// A Basic credential is the base64 of user-id ":" password (RFC 7617 section 2), padded as RFC 4648 section 4 asks.
function isBasicCredential(word){
  return word.length%4===0&&/^[A-Za-z0-9+\/]+={0,2}$/.test(word)&&Buffer.from(word,"base64").includes(0x3a);
}

// An auth-param list (RFC 9110 section 11.4) rather than one token68: a name, =, then a value or a quoted string. Digest, OAuth 1.0
// and AWS Signature Version 4 send their credentials this way; it stays as printed.
function startsAuthParams(word,after){
  const named=/^[A-Za-z][\w-]*=/.exec(word);
  if(!named)return false;
  const value=word.slice(named[0].length);
  return value?!value.startsWith("="):after==='"';
}

// Values a credential never starts with: a variable, a placeholder, a template, a list or a mark.
const NOT_A_VALUE=/^[$%<{[(`]/;

// The authentication schemes an Authorization or Proxy-Authorization value may start with: the IANA HTTP Authentication Scheme
// registry, Microsoft's NTLM, the "token" scheme of GitHub, Gitea and Forgejo, and AWS Signature Version 4, in any case.
const AUTH_SCHEME_WORDS=new Set([
  "basic","bearer","concealed","digest","dpop","gnap","hoba","mutual","negotiate","oauth","privatetoken","scram-sha-1","scram-sha-256",
  "vapid","ntlm","token","aws4-hmac-sha256",
]);

// Header fields that carry a credential, any case (RFC 9110 section 5.1). A scheme field holds a scheme word, then the credential
// (RFC 9110 sections 11.6.2 and 11.7.2); a key field holds the key itself: Anthropic's x-api-key, Google's x-goog-api-key and
// GitLab's PRIVATE-TOKEN.
const FIELD_HOLDS=new Map([
  ["authorization","scheme"],["proxy-authorization","scheme"],["x-api-key","key"],["x-goog-api-key","key"],["private-token","key"],
]);
const CREDENTIAL_FIELD=/\b(?:(?:proxy-)?authorization|x-(?:goog-)?api-key|private-token)/gi;
const QUOTED_AT={'"':/"([^"\n]*)"/y,"'":/'([^'\n]*)'/y};
const SCHEME_THEN_WORD=/^([A-Za-z][\w-]*)[ \t]+([A-Za-z0-9._~+\/=-]+)$/;

// Where the credential of the field named at `at` lies, as [start, end), or null when the field holds none: see the four ways a
// field and its value are written below.
function fieldCredential(text,at,name){
  let next=at+name.length;
  const nameQuoted=text[next]==='"'||text[next]==="'";
  if(nameQuoted)next++;
  next=skipBlanks(text,next);
  if(text[next]!==":")return null;
  next=skipBlanks(text,next+1);
  const holds=FIELD_HOLDS.get(name.toLowerCase());
  // 1. The value is a string: judged by its shape whatever the name, since code and JSON write placeholders here.
  const quoted=QUOTED_AT[text[next]];
  if(quoted){
    quoted.lastIndex=next;
    const string=quoted.exec(text)?.[1];
    return string===undefined?null:credentialInString(string,next+1,holds);
  }
  // 2. A name in quotes before a bare value: a JSON or code key whose value is a variable, a call or a formatted string.
  if(nameQuoted)return null;
  // 3. A bare key field and value: a header line or YAML (code cannot write these names bare). The key runs to white space, a quote
  // or one of , ; ) ] }.
  if(holds==="key"){
    const key=/[^\s"'`,;)\]}]+/y;
    key.lastIndex=next;
    const value=key.exec(text)?.[0];
    return value&&!NOT_A_VALUE.test(value)?[next,next+value.length]:null;
  }
  // 4. A bare scheme field and value. After a scheme word, the next word on the line is the credential, as a header line sends it
  // (see schemeCredential). Without a scheme word only a JWT goes: a typed declaration (authorization: Uint8Array in TypeScript,
  // authorization: Base64Str in pydantic) is written the same way as a bare token would be, and is far more common.
  const first=wordAt(text,next);
  if(!first)return null;
  if(AUTH_SCHEME_WORDS.has(first.toLowerCase())){
    const start=skipBlanks(text,next+first.length);
    const credential=start>next+first.length?wordAt(text,start):"";
    const end=start+credential.length;
    if(!schemeCredential(first,credential)||startsAuthParams(credential,text[end])||"([{".includes(text[end]||"\n"))return null;
    return [start,end];
  }
  return isJsonWebToken(first)?[next,next+first.length]:null;
}

// Whether the word after a scheme word on a bare header line is a credential. After Basic or Bearer any word with a letter or a
// digit is. After the other schemes, which documentation more often shows with a placeholder in capitals (Authorization: token
// OAUTH-TOKEN), only a word with a digit, or with small and capital letters both, as random text has.
function schemeCredential(scheme,word){
  if(!/[A-Za-z0-9]/.test(word))return false;
  if(/^(?:basic|bearer)$/i.test(scheme))return true;
  return /\d/.test(word)||(/[a-z]/.test(word)&&/[A-Z]/.test(word));
}

// The credential inside a field's string value that starts at `start`: after a scheme word, the word that follows, a Basic one when
// it decodes to user:pass and any other when it looks issued; without a scheme, the whole string when it is one word that does.
function credentialInString(string,start,holds){
  const schemed=holds==="scheme"?SCHEME_THEN_WORD.exec(string):null;
  if(schemed&&AUTH_SCHEME_WORDS.has(schemed[1].toLowerCase())){
    const word=schemed[2];
    const taken=schemed[1].toLowerCase()==="basic"?isBasicCredential(word):looksIssued(word,SHORTEST_IN_STRING);
    return taken?[start+string.length-word.length,start+string.length]:null;
  }
  return ONE_CREDENTIAL_WORD.test(string)&&looksIssued(string,SHORTEST_IN_STRING)?[start,start+string.length]:null;
}

function skipBlanks(text,at){
  while(text[at]===" "||text[at]==="\t")at++;
  return at;
}

// text with the credential of each header field in it as MASK. A field found inside a credential already taken is not read again.
function hideFieldCredentials(text){
  let shown="",copied=0;
  for(const field of text.matchAll(CREDENTIAL_FIELD)){
    if(field.index<copied)continue;
    const span=fieldCredential(text,field.index,field[0]);
    if(!span)continue;
    shown+=text.slice(copied,span[0])+MASK;
    copied=span[1];
  }
  return copied?shown+text.slice(copied):text;
}

// A Bearer token wherever it is printed (RFC 6750 section 2.1): the word bearer, white space, then the token. On the same line any
// word goes, as the scheme says the token follows. Across a line break only a word that looks issued goes, so a comment marker or a
// key on the next line (an OpenAPI bearerFormat: JWT) stays.
const BEARER_THEN_WORD=/\bbearer(\s+)([A-Za-z0-9._~+\/=-]+)/gi;
function hideBearerTokens(text){
  return text.replace(BEARER_THEN_WORD,(whole,gap,word)=>{
    if(gap.includes("\n")&&!looksIssued(word,SHORTEST_ON_HEADER_LINE))return whole;
    return whole.slice(0,whole.length-word.length)+MASK;
  });
}

// ---- Issued tokens --------------------------------------------------------------------------------------------------------
// Tokens told by the prefix their issuer documents, each starting a word, prefix case as the issuer writes it. One search for all,
// so a token that runs into another goes whole, once.
const ISSUED_FAMILIES=[
  // GitHub: the two kinds of token a person makes and pastes, ghp_ personal access tokens (classic) and github_pat_ fine-grained
  // ones. GitHub writes the part after ghp_ in base62, letters and digits only, so a ghp_ word that goes on with _ is a name. The
  // tokens GitHub issues to programs (gho_, ghu_, ghs_, ghr_) stay as printed, as 2.1.2 left them: names in code such as ghs_count
  // or gho_users start the same way. No length is fixed.
  String.raw`ghp_[A-Za-z0-9]+(?!\w)`,
  String.raw`github_pat_\w+`,
  // Secret API keys that start sk-, as OpenAI (sk-proj-, sk-svcacct-, sk-admin-) and Anthropic (sk-ant-api03-, sk-ant-oat01-) issue
  // them: sk-, then letters, digits and - ending in a letter or a digit, where the word ends. A run that goes on with _ is left:
  // the keys' alphabet has _, but code has far more names like that (scikit-learn's CSS class sk-toggleable__label). How short
  // the run may be is SK_KEY_SHORTEST below.
  String.raw`sk-[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?!\w)`,
  // Slack: xoxb- bot, xoxp- user, xapp- app-level and xwfp- workflow tokens, each also after xoxe. once rotated; xoxe- refresh tokens;
  // the legacy xoxa-, xoxr- and xoxs-. Then letters, digits and -. Slack's examples write a number and a hyphen right after the
  // prefix (xoxp-111-222-333-d6bc76, and xapp-1-123 in its Socket Mode guide); xapp- and xwfp- are asked for that, since they
  // also start everyday names such as xapp-settings.json.
  String.raw`(?:xoxe\.)?(?:xox[bpars]-|(?:xapp|xwfp)-\d+-)[A-Za-z0-9-]+`,
  String.raw`xoxe-[A-Za-z0-9-]+`,
  // Slack's browser tokens, the xoxc- client token and the xoxd- d cookie, whole with the percent escapes a cookie is written with.
  String.raw`xox[cd]-(?:[A-Za-z0-9-]|%[0-9A-Fa-f]{2})+`,
];
const ISSUED_TOKEN_WORD=new RegExp(String.raw`\b(?:${ISSUED_FAMILIES.join("|")})`,"g");
// The fewest characters after sk- that make a key: 9, as many as Anthropic's own prefix has after it (ant-api03, ant-oat01), so a
// documented key goes at least to the end of its prefix; a shorter word (sk-learn) is a name. A key's characters also hold a
// digit (Anthropic's prefixes do, and random text of that length nearly always does), where names in code such as scikit-learn's
// sk-hidden--visually and sk-estimator-doc-link hold none.
const SK_KEY_SHORTEST=9;
const isSkKey=word=>word.length-3>=SK_KEY_SHORTEST&&/[0-9]/.test(word.slice(3));
const hideIssuedToken=word=>word.startsWith("sk-")&&!isSkKey(word)?word:MASK;

// ---- Secrets written as a name and a value, and secret flags --------------------------------------------------------------
// A secret written as a name and a value: the name as a word (api key, or access, refresh or auth token, with _, - or nothing
// between the words; password; secret; credential; any case), = or : with white space around it or not, then the value up to
// white space, a comma or a semicolon. The name and the sign stay.
const NAMED_SECRET=/\b(api[-_]?key|(?:access|refresh|auth)[-_]?token|password|secret|credential)\b(\s*[=:]\s*)[^\s,;]+/gi;

// A secret's command-line flag (SECRET_FLAGS, any case; they hold only letters and hyphens, which a pattern takes as written),
// the white space after it, then its value: the value goes.
const FLAG_VALUE=new RegExp(`(${[...SECRET_FLAGS].join("|")})(\\s+)\\S+`,"gi");

// The user information of an address (RFC 3986: scheme://user:password@host): what lies between :// and the first @, with no white
// space or / in it, when a scheme ends right at the :// (a letter, then at most 31 letters, digits, +, . or -). Each :// found looks
// back for its scheme, so a long run of letters is never searched again from each of them.
const ADDRESS_USER=/:\/\/(?<=[a-z][a-z\d+.-]{0,31}:\/\/)[^\s\/@]+@/gi;

// The shapes for text only a person reads, each on the text the one before left. A pairing link goes whole before a token in it
// could go alone. Header fields come before Bearer tokens, so a field's scheme is read as printed, and both before the issued
// tokens and the name=value form, which could take part of them.
const PEOPLE_SHAPES=[
  text=>replaceWebAddresses(text,address=>isPairingLink(address)?PAIRING_LINK_MARK:null),
  text=>text.replace(ADDRESS_USER,"://"+MASK+"@"),
  hideFieldCredentials,
  hideBearerTokens,
  text=>text.replace(ISSUED_TOKEN_WORD,hideIssuedToken),
  text=>text.replace(NAMED_SECRET,(_,name,sign)=>name+sign+MASK),
  text=>text.replace(FLAG_VALUE,(_,flag,gap)=>flag+gap+MASK),
];

// ---- Text a model reads ---------------------------------------------------------------------------------------------------
// A tool's result, the error a tool threw and a command a gate quotes can all reach a model. Those are redacted as Trebell 2.1.2
// redacted them, the release Trebell Native was benchmarked with, so the model reads what it read there, mark for mark: hiding more
// would keep from it a credential a task asks it to find or rotate, and a different mark is different text. Each rule below says
// what it takes and how it writes what it took.

// One ASCII character at a time, as these rules read text: a missing character (before the start, after the end) is none of these.
const isLetterOrDigit=character=>character!==undefined&&/^[A-Za-z0-9]$/.test(character);
const isWordCharacter=character=>character==="_"||isLetterOrDigit(character);
const isLetterDigitOrHyphen=character=>character==="-"||isLetterOrDigit(character);
const isWhiteSpace=character=>character!==undefined&&/^\s$/.test(character);
const isPrintedCharacter=character=>character!==undefined&&!isWhiteSpace(character);
// A word starts or ends at `at` when a word character (letter, digit or _) stands on one side of it only.
const wordEdgeAt=(text,at)=>isWordCharacter(text[at-1])!==isWordCharacter(text[at]);
// The characters of a Bearer token here: letters, digits and . _ - + = /.
const isBearerCharacter=character=>isLetterOrDigit(character)||(character!==undefined&&"._-+=/".includes(character));

function skipWhile(text,at,test){
  while(at<text.length&&test(text[at]))at++;
  return at;
}

// Whether text holds `word` (small letters and signs) at `at`, its letters in either case.
function holdsWordAt(text,at,word){
  if(text.length-at<word.length)return false;
  for(let index=0;index<word.length;index++){
    const character=text[at+index];
    if(character!==word[index]&&character!==word[index].toUpperCase())return false;
  }
  return true;
}

// text with the runs that `judge` takes replaced. `finder`, a global pattern, finds where a run could start, in order; `judge`,
// given the text, where the part found starts and ends and the part itself, gives [where the run ends, what to write instead], or
// null to leave it. A start inside a run already replaced is passed over.
function replaceRuns(text,finder,judge){
  let shown="",copied=0;
  for(const found of text.matchAll(finder)){
    if(found.index<copied)continue;
    const run=judge(text,found.index,found.index+found[0].length,found[0]);
    if(!run)continue;
    shown+=text.slice(copied,found.index)+run[1];
    copied=run[0];
  }
  return copied?shown+text.slice(copied):text;
}

// The word bearer, in any case and starting a word, white space (a line break too), then one or more Bearer characters: all of it
// is written Bearer [redacted].
const hideBearerForModel=text=>replaceRuns(text,/bearer/gi,(text,start,end)=>{
  if(isWordCharacter(text[start-1]))return null;
  const token=skipWhile(text,end,isWhiteSpace);
  const stop=skipWhile(text,token,isBearerCharacter);
  return token>end&&stop>token?[stop,"Bearer "+MASK]:null;
});

// Authorization: (any case, starting a word), white space or none, Basic (any case), white space, then everything up to the next
// white space: all of it is written Authorization: Basic [redacted].
const hideBasicForModel=text=>replaceRuns(text,/authorization:/gi,(text,start,end)=>{
  if(isWordCharacter(text[start-1]))return null;
  const scheme=skipWhile(text,end,isWhiteSpace);
  if(!holdsWordAt(text,scheme,"basic"))return null;
  const credential=skipWhile(text,scheme+5,isWhiteSpace);
  const stop=skipWhile(text,credential,isPrintedCharacter);
  return credential>scheme+5&&stop>credential?[stop,"Authorization: Basic "+MASK]:null;
});

// x-api-key: (any case, starting a word), white space or none, then everything up to the next white space: all of it is written
// x-api-key: [redacted].
const hideApiKeyForModel=text=>replaceRuns(text,/x-api-key:/gi,(text,start,end)=>{
  if(isWordCharacter(text[start-1]))return null;
  const key=skipWhile(text,end,isWhiteSpace);
  const stop=skipWhile(text,key,isPrintedCharacter);
  return stop>key?[stop,"x-api-key: "+MASK]:null;
});

// Tokens told by their issuer's prefix where a word starts, prefix case as written: sk- then a letter or digit and 7 or more
// letters, digits or -; ghp_ then letters and digits; github_pat_ then letters, digits and _; xox, one letter and - (Slack), then
// letters, digits and -. The token ends where a word does, at the last such place its characters reach (so it may stop before a
// hyphen, or short of a run that goes on with _), and becomes [redacted]; with no such place, nothing goes.
const MODEL_TOKEN_START=/\b(?:sk-|ghp_|github_pat_|xox[A-Za-z]-)/g;
const MODEL_TOKEN_RULES={"sk-":[isLetterDigitOrHyphen,8],"ghp_":[isLetterOrDigit,1],"github_pat_":[isWordCharacter,1]};
const hideIssuedTokensForModel=text=>replaceRuns(text,MODEL_TOKEN_START,(text,start,end,prefix)=>{
  const [belongs,fewest]=MODEL_TOKEN_RULES[prefix]||[isLetterDigitOrHyphen,1];
  if(prefix==="sk-"&&!isLetterOrDigit(text[end]))return null;
  for(let stop=skipWhile(text,end,belongs);stop>=end+fewest;stop--)if(wordEdgeAt(text,stop))return [stop,MASK];
  return null;
});

// The rules for text a model reads, in 2.1.2's order: a pairing link, which runs to white space and is written [pairing-url]; an
// address's user part; Bearer tokens; Basic credentials; x-api-key values; issued tokens; named secrets; secret flags.
const WHITE_SPACE=/\s/g;
const MODEL_SHAPES=[
  text=>replaceWebAddresses(text,address=>isPairingLink(address)?MODEL_PAIRING_MARK:null,WHITE_SPACE),
  text=>text.replace(ADDRESS_USER,"://"+MASK+"@"),
  hideBearerForModel,
  hideBasicForModel,
  hideApiKeyForModel,
  hideIssuedTokensForModel,
  text=>text.replace(NAMED_SECRET,(_,name,sign)=>name+sign+MASK),
  text=>text.replace(FLAG_VALUE,(_,flag,gap)=>flag+gap+MASK),
];

// The home folders text a model reads has written as ~: the environment's HOME, its USERPROFILE and the account's home, each text
// of two characters or more, each once, replaced wherever they appear, in that order.
function modelHomeFolders(environment){
  const folders=[];
  for(const folder of [environment?.HOME,environment?.USERPROFILE,homedir()]){
    // Not text, a single character or none, or a folder listed already: passed over.
    if(typeof folder!=="string"||folder.length<2||folders.includes(folder))continue;
    folders.push(folder);
  }
  return folders;
}

// ---- The environment's secret values and the person's home folders --------------------------------------------------------
// The value of each variable whose name reads as a secret, when it is text of six characters or more (a shorter one could be an
// everyday word). Each value once and the longest first, so that a value which is part of a longer one cannot split the longer one
// before it goes whole; values of the same length keep the environment's order.
function secretValuesIn(environment){
  const named=Object.entries(environment||{}).filter(([name,value])=>typeof value==="string"&&value.length>=6&&isSecretEnvironmentName(name));
  return [...new Set(named.map(([,value])=>value))].sort((first,second)=>second.length-first.length);
}

// The person's home folders: the home of the account Trebell runs as and the environment's USERPROFILE and HOME, in no order of
// their own. Only an absolute folder that is not a root (a root would turn every path into ~), without its trailing separators,
// also with forward slashes when it has backslashes (Windows programs print both), the longest first so a home inside another goes
// whole.
function homeFoldersIn(environment){
  const folders=new Set();
  for(const value of [homedir(),environment?.USERPROFILE,environment?.HOME]){
    if(typeof value!=="string"||!win32.isAbsolute(value))continue;
    const folder=value.replace(/[\\/]+$/,"");
    if(!folder||/^[a-z]:$/i.test(folder))continue;
    folders.add(folder);
    if(folder.includes("\\"))folders.add(folder.replaceAll("\\","/"));
  }
  return [...folders].sort((first,second)=>second.length-first.length);
}

// A character that continues a folder's name: where one follows, the folder found is the start of another (/home/adam is not
// /home/ada) and stays.
const NAME_GOES_ON=/[\p{L}\p{N}_-]/u;
function writeHomesAsTilde(text,folders){
  for(const folder of folders){
    let shown="",copied=0;
    for(let at=text.indexOf(folder);at>=0;at=text.indexOf(folder,at+1)){
      const after=text[at+folder.length];
      if(at<copied||(after!==undefined&&NAME_GOES_ON.test(after)))continue;
      shown+=text.slice(copied,at)+"~";
      copied=at+folder.length;
    }
    text=shown+text.slice(copied);
  }
  return text;
}

function replaceEach(text,values,standIn){
  for(const value of values)text=text.split(value).join(standIn);
  return text;
}

// text (read as a string; null or undefined is empty) without its secrets. The steps, in order: NUL characters out (one inside a
// secret would keep it from matching, and some stores end text at one); with redactHomes, the person's home folders as ~; the
// environment's secret values; the shapes; with trim, white space at both ends last (a secret value may itself begin or end with
// white space). Options: environment, where the secret values and home folders come from (process.env unless given); forPeople,
// true for text only a person reads, never a model, which takes PEOPLE_SHAPES and its home folders instead of the model's;
// _environmentSecrets, the environment's secret values when the caller has listed them already (redactSecretValue).
export function redactSecretText(text,options={}){
  const environment=options.environment===undefined?process.env:options.environment;
  const secrets=Array.isArray(options._environmentSecrets)?options._environmentSecrets:secretValuesIn(environment);
  const forPeople=options.forPeople===true;
  const writeHomes=forPeople?shown=>writeHomesAsTilde(shown,homeFoldersIn(environment))
    :shown=>replaceEach(shown,modelHomeFolders(environment),"~");
  const steps=[
    shown=>shown.replaceAll("\0",""),
    options.redactHomes?writeHomes:null,
    shown=>replaceEach(shown,secrets,MASK),
    ...(forPeople?PEOPLE_SHAPES:MODEL_SHAPES),
    options.trim?shown=>shown.trim():null,
  ];
  return steps.reduce((shown,step)=>step?step(shown):shown,String(text??""));
}

export function redactSecretValue(value,options={},depth=0){
  const {environment=process.env,maxDepth=10,maxArray=100,maxFields=200,forPeople=false,_environmentSecrets=null}=options;
  if(depth>maxDepth)return "[bounded]";
  if(typeof value==="string")return redactSecretText(value,{environment,forPeople,_environmentSecrets});
  if(value==null||typeof value==="number"||typeof value==="boolean")return value;
  const environmentSecrets=Array.isArray(_environmentSecrets)?_environmentSecrets:secretValuesIn(environment);
  const deeper={environment,maxDepth,maxArray,maxFields,forPeople,_environmentSecrets:environmentSecrets};
  if(Array.isArray(value))return value.slice(0,maxArray).map((item,index,array)=>{
    if(index>0&&isSecretCliFlag(array[index-1]))return "[redacted]";
    return redactSecretValue(item,deeper,depth+1);
  });
  if(typeof value!=="object")return redactSecretText(String(value),{environment,forPeople,_environmentSecrets:environmentSecrets});
  const out={};
  for(const [key,item] of Object.entries(value).slice(0,maxFields)){
    if(SENSITIVE_KEYS.has(normalizedKey(key))){out[key]="[redacted]";continue}
    out[key]=redactSecretValue(item,deeper,depth+1);
  }
  return out;
}
