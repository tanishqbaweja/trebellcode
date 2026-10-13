// A prompt that Trebell's own session refuses before the harness has it: Claude Code's session while a turn still runs or after it
// closed, background work a new launch would end, a mode an ACP harness does not offer, an ACP session that never started. The
// harness ran nothing and did not fail, so the relay asks it nothing (agent-relay failedWhereItRuns). As with a lost conversation
// (harness-session-lost.mjs), the relay tells it by its class and never reads the message to decide.
export class SessionRefusalError extends Error{
  constructor(message){super(message);this.name="SessionRefusalError"}
}

export function isSessionRefusal(error){return error instanceof SessionRefusalError}
