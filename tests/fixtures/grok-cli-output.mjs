// What Grok Build's own CLI prints, for the tests and specs whose fake `grok` answers as it does. Taken from grok 1.0.41
// (4220f3b224a6): `grok models` run with an empty Grok home on 2026-11-01 printed the sign-in line, a blank line, the default model,
// a blank line and the models on offer. Signed in, the first line names the sign-in instead, in the command's own words
// "You are logged in with <sign-in>.", where the sign-in is grok.com unless an administrator gave another one a label.
const GROK_MODEL_LIST="\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n";
const signedInWith=signIn=>`You are logged in with ${signIn}.\n`;

export const GROK_MODELS_SIGNED_OUT="You are not authenticated.\n"+GROK_MODEL_LIST;
export const GROK_MODELS_SIGNED_IN=signedInWith("grok.com")+GROK_MODEL_LIST;
