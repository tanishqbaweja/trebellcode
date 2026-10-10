// What a thread and each of its turns carry to the agent relay for the external harnesses it runs (Claude Code, OpenCode,
// Cursor, Grok Build, Antigravity), so the composer's choices reach every harness the way its adapter applies them (T3 Code's
// per-turn runtime policy and model options). Codex and Trebell Native take theirs in their own shapes.
const RELAY_HARNESSES=new Set(["claude","opencode","cursor","grok","antigravity"]);
// The composer choices each harness takes: effort (Claude Code's effort, OpenCode's model variant, Grok's and Cursor's effort),
// speed (Claude Code's and Cursor's Fast mode) and the model's other settings (Cursor's context size and thinking switch).
const TAKES_EFFORT=new Set(["claude","opencode","cursor","grok"]);
const TAKES_SPEED=new Set(["claude","cursor"]);
const TAKES_MODEL_OPTIONS=new Set(["cursor"]);

export function relayHarness(runtime){return RELAY_HARNESSES.has(String(runtime||""))}

// thread/start: the access level the thread starts in. The relay could otherwise only read it from the Codex-style sandbox and
// approval policy, which cannot tell Auto-accept edits from Supervised.
export function harnessThreadOptions(runtime,{permissionMode="supervised"}={}){
  return relayHarness(runtime)?{permissionProfile:permissionMode||"supervised"}:{};
}

// turn/start: the access level, plus the effort, speed and model settings the harness takes. A null effort or speed tells the
// harness to use its own default for the model.
export function harnessTurnOptions(runtime,{permissionMode="supervised",reasoningEffort=null,serviceTier=null,modelOptions={}}={}){
  if(!relayHarness(runtime))return {};
  return {
    permissionProfile:permissionMode||"supervised",
    ...(TAKES_EFFORT.has(runtime)?{reasoningEffort:reasoningEffort||null}:{}),
    ...(TAKES_SPEED.has(runtime)?{serviceTier:serviceTier||null}:{}),
    ...(TAKES_MODEL_OPTIONS.has(runtime)?{modelOptions:modelOptions&&typeof modelOptions==="object"&&!Array.isArray(modelOptions)?modelOptions:{}}:{}),
  };
}

// The menus a new chat or an opened thread shows: the harness's own (its model catalog's inventory) with what the thread's
// session listed over them (available_commands_update, config_option_update, session_info_update). A list neither names is
// empty, so one harness's commands, agents or skills never linger under another. Codex lists its skills itself (withSkills false).
export function harnessInventory(runtimeInventory=null,providerMeta=null,{withSkills=true}={}){
  const object=value=>value&&typeof value==="object"&&!Array.isArray(value)?value:{};
  const meta=object(providerMeta);
  const merged={...object(runtimeInventory),...object(meta.available_commands_update),...object(meta.config_option_update),...object(meta.session_info_update)};
  const list=value=>Array.isArray(value)?value:[];
  return {commands:list(merged.commands),agents:list(merged.agents),...(withSkills?{skills:list(merged.skills)}:{})};
}

// The Speed picker's tooltip names what the choice changes for the harness.
export function serviceTierPickerTitle(runtime){
  if(runtime==="codex")return "Codex service tier";
  if(runtime==="claude")return "Claude Code Fast mode";
  if(runtime==="cursor")return "Cursor Fast mode";
  return "OpenAI processing speed tier";
}
