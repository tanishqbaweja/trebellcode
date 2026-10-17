// The terminal drawer takes the keyboard late: the active terminal's command line (or Create terminal or New, for Focus terminal)
// gets it once the drawer's code has loaded and its terminals are listed, which can be well after the press that asked for it by
// opening the drawer (the Terminal toggle, a project action's run, a send's worktree setup, a harness's sign in) or by showing a
// terminal in it (an action that runs already). It goes there only while nothing was pressed outside the drawer since: a menu opened
// meanwhile (More actions, which may have run the action) stays open instead of closing as the keyboard leaves it, and keys typed in
// the composer stay there. A press in the drawer asks for it again, as the control pressed may go with what it does (a tab's close
// button, Create terminal). A key held down counts as the one press it began with.
let presses=0,asked=0,askedAt=0;
if(typeof document!=="undefined")for(const type of ["pointerdown","keydown"])document.addEventListener(type,event=>{if(event.repeat)return;presses++;if(event.target?.closest?.(".terminal-drawer"))asked=presses},true);
// The presses so far, read at a press whose terminal shows a while later (a project action's run, from the header or its Projects
// card; a send that sets up a new worktree; a harness's sign in): that terminal asks as of them, so a press made meanwhile counts.
export const terminalPresses=()=>presses;
// Asked as App shows a terminal in the drawer, by Focus terminal and by the keys that start a terminal: at once, so a press that
// comes after counts, or as of the presses read at the press that asked for it (at). An ask never goes back: one made since (the
// drawer opened, Focus terminal, a press in the drawer while a run starts) stands, and the terminal takes the keyboard for it.
export function askTerminalKeyboard(at=presses){asked=Math.max(asked,at);askedAt=presses}
// The drawer opening asks for it at once, unless App asked since the last press: what opens it a while after the press that asked
// for it asked as of that press.
export function terminalDrawerOpened(node){if(node&&askedAt!==presses)asked=presses}
// Whether the keyboard asked for can still go into the drawer: nothing was pressed outside it since.
export const terminalKeyboardAsked=()=>presses===asked;
