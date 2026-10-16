// The terminal drawer takes the keyboard late: the active terminal's command line (or Create terminal or New, for Focus terminal)
// gets it once the drawer's code has loaded and its terminals are listed, which can be well after the press that asked for it by
// opening the drawer (a project action's run, the Terminal toggle) or by showing a terminal in it (an action that runs already). It
// goes there only while nothing was pressed outside the drawer since: a menu opened meanwhile (More actions, which may have run the
// action) stays open instead of closing as the keyboard leaves it, and keys typed in the composer stay there. A press in the drawer
// asks for it again, as the control pressed may go with what it does (a tab's close button, Create terminal). A key held down counts
// as the one press it began with.
let presses=0,asked=0;
if(typeof document!=="undefined")for(const type of ["pointerdown","keydown"])document.addEventListener(type,event=>{if(event.repeat)return;presses++;if(event.target?.closest?.(".terminal-drawer"))asked=presses},true);
// Asked as the drawer opens, as App shows a terminal in it, and by Focus terminal: at once, so a press that comes after counts.
export function askTerminalKeyboard(){asked=presses}
// Whether the keyboard asked for can still go into the drawer: nothing was pressed outside it since.
export const terminalKeyboardAsked=()=>presses===asked;
