// An agent's log: what an ACP harness or Muse Code prints on stderr while it runs. Trebell keeps only its newest part, for a
// failure to quote, and quotes it as an excerpt that hides what the person should not see repeated: the secrets redactSecretText
// hides, the person's home folders (written as ~) and Google sign-in links, whose query carries the sign-in's state and the local
// address that answers it. Used by acp-client.mjs and muse-host.mjs; acp-start-exit.mjs reads an excerpt's sign-in mark.
import { redactSecretText, replaceWebAddresses } from "./secret-redactor.mjs";

// How much of a log is kept: its newest 4,096 characters.
export const AGENT_LOG_KEPT_CHARS=4096;

// log with chunk added at its end (each a string, a Buffer read as text, or missing), its oldest characters dropped past the bound
// (a negative slice of a shorter text is the whole text).
export function extendAgentLog(log,chunk){return `${log??""}${chunk??""}`.slice(-AGENT_LOG_KEPT_CHARS)}

// The mark a Google sign-in link leaves in an excerpt.
export const SIGN_IN_LINK_MARK="[redacted sign-in link]";

// Google's sign-in host, accounts.google.com, right after an address's scheme (and any user part), and ending there: the host is
// followed by the end of the address or by / ? # or : (a port). Google's OAuth 2.0 endpoints (/o/oauth2/v2/auth) and its account
// pages (AccountChooser, ServiceLogin) live on it.
const GOOGLE_SIGN_IN=/https?:\/\/(?:[^\/?#@]*@)?accounts\.google\.com(?![^\/?#:])/i;

// text (read as a string; null or undefined is empty) with each Google sign-in link replaced by SIGN_IN_LINK_MARK, from its scheme
// to the end of the address it is in, also when it is a parameter of another address (whose own start stays). Nothing else changes.
export function hideGoogleSignInLinks(text){
  return replaceWebAddresses(String(text??""),address=>{
    const at=address.search(GOOGLE_SIGN_IN);
    return at<0?null:address.slice(0,at)+SIGN_IN_LINK_MARK;
  });
}

// What a failure or a warning quotes of an agent's log, which only the person reads: its secrets and home folders hidden
// (redactSecretText for people, which removes NUL characters first), then its Google sign-in links, with white space at both ends
// trimmed last. environment: where the secret values and home folders come from, process.env unless given.
export function agentLogExcerpt(log,environment=process.env){
  const redacted=redactSecretText(log,{environment,redactHomes:true,forPeople:true});
  return hideGoogleSignInLinks(redacted).trim();
}

// Whether an excerpt hid a Google sign-in link: the agent asked the person to sign in.
export function excerptAskedForSignIn(excerpt){return String(excerpt??"").includes(SIGN_IN_LINK_MARK)}
