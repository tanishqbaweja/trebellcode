// What Settings says of a harness that is not ready, with one sentence on what to do. A failed turn's advice (withProbeAdvice)
// reuses the sign-in sentences, so those read as well in a conversation, which has no Refresh button, as in Settings.
import { HARNESS_SIGN_IN_COMMANDS } from "./harness-auth.mjs";

// The harnesses whose sign-in check can find no account, by the name Settings shows. The command is the harness's own sign-in
// (HARNESS_SIGN_IN_COMMANDS); Claude Code's is set as code, as its status has shown it.
const FINDS_NO_ACCOUNT=new Map([
  ["claude",{name:"Claude Code",asCode:true}],
  ["codex",{name:"Codex",asCode:false}],
  ["grok",{name:"Grok Build",asCode:false}],
]);
export function signInNeeded(kind){
  const harness=FINDS_NO_ACCOUNT.get(kind);
  if(!harness)throw new Error(`No sign-in sentence for ${kind}`);
  const command=HARNESS_SIGN_IN_COMMANDS[kind];
  return `${harness.name} has no account signed in. Run ${harness.asCode?`\`${command}\``:command}, then try again.`;
}

// A Claude Code profile that sends its requests to an endpoint of its own (a router or gateway): the endpoint holds the
// credentials, so `claude auth status` has nothing to find, and only a session can tell whether they work. The account's type
// is what Settings and the kept answers know such a profile by.
export const CLAUDE_OWN_ENDPOINT=Object.freeze({
  type:"ownEndpoint",
  label:"Own API endpoint",
  message:"Claude Code sends its requests to this profile's own API endpoint, which holds the credentials. A session checks them when it starts.",
});

// Muse Code's command is not on this machine: Meta's installer for the platform, its page, and the sign-in after it.
export function museNotFound(installCommand){
  return `Trebell Code cannot find Muse Code's muse command. Install Muse Code with ${installCommand} (see https://dev.meta.ai/docs/muse-code), then run muse login.`;
}

// OpenCode's readiness. providers: how many model providers its server says are connected; models: how many models it lists for
// them (null when not counted); ownServer: the profile names a server of its own (its URL), which Trebell Code does not start.
export function openCodeReadiness({providers=0,models=null,ownServer=false}={}){
  const count=Number(providers)>0?Number(providers):0;
  const server=ownServer?"The OpenCode server at this profile's URL":"OpenCode";
  if(!count)return ownServer
    ?"No provider is connected to the OpenCode server at this profile's URL yet. Connect one on that server, then press Refresh."
    :"No provider is connected to OpenCode yet. Add one with opencode auth login, then press Refresh.";
  if(models===0)return `${server} is connected to ${count} provider${count===1?"":"s"} but lists no models yet. Press Refresh to look again.`;
  return `${server} is ready, listing models from ${count===1?"the provider":`the ${count} providers`} it is connected to.`;
}

// A profile's own OpenCode server refused Trebell Code's requests for want of a password. Trebell Code sends an OpenCode 2.x
// server the profile's OPENCODE_SERVER_PASSWORD (or OPENCODE_PASSWORD), and an OpenCode 1.x server a password only when it started
// that server itself, so for a 1.x server (or one whose version was not read) the advice leaves the password alone: it guards a
// server that runs commands for whoever reaches its port.
const PASSWORD_ADVICE=Object.freeze({
  sent:"The OpenCode server at this profile's URL refused Trebell Code's password. Check the URL, and the OPENCODE_SERVER_PASSWORD in the profile's environment.",
  notSent:"The OpenCode server at this profile's URL wants a password, and Trebell Code gives one only to an OpenCode 1.x server it starts itself. Check the URL, or leave it empty so Trebell Code starts OpenCode for you.",
});
export function openCodeServerPassword(version){
  return PASSWORD_ADVICE[/^2\./.test(String(version??""))?"sent":"notSent"];
}
