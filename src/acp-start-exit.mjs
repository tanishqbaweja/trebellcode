// Why an ACP harness's start failed, in plain words, for whatever starts one: a chat's session (acp-agent-session.mjs) and the Git text
// (harness-text-generation.mjs). An Antigravity this machine gives no IPv6 sockets says so (antigravityIpv6Failure). One whose process
// ended as it started (as it initialized, signed in, took the conversation up again or set the thread's model) names the harness, how it
// ended and what it printed. A log that asks for a Google sign-in is not repeated, as the link it points to is hidden ([sign-in-url],
// acp-client.mjs): the message says to sign in in Settings instead, or, for an Antigravity set to run on its Gemini API key, to check
// that key. Any other failure is the error as it is. The Antigravity check runs only when a start fails, so a module of
// antigravity-auth.mjs's own can use this too.
import { antigravityIpv6Failure } from "./antigravity-auth.mjs";

const text=value=>String(value??"").trim();

// env: the harness's environment, whose Gemini API key says whether Antigravity runs on the key saved in Settings.
function startExitFailure(runtime,label,error,env){
  const exit=error?.processExit||error?.cause?.processExit;if(!exit)return null;
  const said=text(exit.excerpt),ended=Number.isInteger(exit.code)?`${label} stopped as it started, with exit code ${exit.code}`:exit.signal?`${label} was stopped by ${exit.signal} as it started`:`${label} stopped as it started`;
  const message=!said?ended+".":!said.includes("[sign-in-url]")?`${ended}: ${said}`
    :runtime==="antigravity"&&text(env?.GEMINI_API_KEY)?`${ended}, asking for a Google sign-in, though it runs on the Google Gemini API key saved in Settings. Check that key there, then try again.`
    :`${ended}, asking for a Google sign-in. Sign in to ${label} in Settings, then try again.`;
  return new Error(message,{cause:error});
}

export function acpStartFailure(runtime,label,error,env){
  return (runtime==="antigravity"&&antigravityIpv6Failure(error))||startExitFailure(runtime,label,error,env)||error;
}
