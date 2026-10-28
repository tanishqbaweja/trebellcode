import { shortcutHint } from "./keybindings.js";

// The command palette's commands, which come with the palette's own code (CommandPalette.jsx) instead of with the app (B11): the
// palette is drawn only once the person opens it, and its first open shows App's stand-in ("Loading commands…") until that code is
// in. app is what App's render hands the palette: the actions the commands run and what decides which of them show, as that render
// has them. keywords: another name a command is found by, the one the sidebar gives its destination.
export function paletteActions({commandKey,newTask,newGeneralChat,pickWorkspace,projectPath,navigateSection,openRightPanel,projectlessMode,gitInfo,paletteThread,askText,linkPullRequestUrl,panel,setPanel,focusTerminalDrawer,currentProject,runProjectAction,runtimeCapabilities,goal,agentRuntimeLabel,startReview,saveAppSettings,settings,messages,shareThread}){
  return [
    {id:"new",label:"New thread",detail:"Start a clean coding task",keywords:"New task",shortcut:shortcutHint(commandKey("newChat")),onRun:newTask},
    {id:"new-general",label:"New general chat",detail:"Start without attaching a project or repository",onRun:newGeneralChat},
    ...(window.trebellDesktop?.pickDirectory?[{id:"folder",label:"Open workspace folder",detail:projectPath||"Choose a local folder",onRun:pickWorkspace}]:[]),
    {id:"projects",label:"Recent projects",detail:"Switch checkouts or clone a repository",onRun:()=>navigateSection("projects")},
    {id:"files",label:"Files",detail:"Browse and edit the workspace",onRun:()=>openRightPanel("files")},
    ...(!projectlessMode?[{id:"diff",label:"Changes",detail:"Inspect the current Git diff",onRun:()=>openRightPanel("diff")},{id:"git",label:"Source control",detail:gitInfo?.branch||"Git and pull requests",onRun:()=>openRightPanel("source")}]:[]),
    ...(!projectlessMode?[{id:"context",label:"Trebell context",detail:"Inspect repository context supplied to the latest turn",onRun:()=>openRightPanel("context")}]:[]),
    ...(paletteThread?[{id:"link-pr",label:"Link pull request",detail:"Attach a hosted review to this thread",onRun:async()=>{const url=await askText("Pull request URL");if(url)await linkPullRequestUrl(url,"manual")}}]:[]),
    // Toggle terminal's key opens the terminal only while it is closed (it closes an open one), so this row offers it only then.
    {id:"terminal",label:"Terminal",detail:"Open the persistent PTY",shortcut:panel==="terminal"?"":shortcutHint(commandKey("terminal")),onRun:()=>{setPanel("terminal");focusTerminalDrawer()}},
    ...((currentProject?.scripts||[]).map(script=>({id:"project-action:"+script.id,label:"Run "+script.name,detail:script.command,onRun:()=>runProjectAction(script)}))),
    {id:"browser",label:"Browser",detail:window.trebellDesktop?.browser?"Open Trebell Agent Browser":"Open hosted preview and local dev-server tools",onRun:()=>openRightPanel("preview")},
    ...(runtimeCapabilities.delegation?[{id:"agents",label:"Agents & collaboration",detail:"Delegated threads and collaboration mode",onRun:()=>openRightPanel("agents")}]:[]),
    ...(paletteThread?[{id:"goal",label:"Thread goal",detail:goal?.objective||"Set a durable objective",onRun:()=>openRightPanel("goal")}]:[]),
    ...(paletteThread&&gitInfo?.isGit?[{id:"review",label:"Review changes",detail:`Ask ${agentRuntimeLabel} to review uncommitted changes`,onRun:()=>startReview()}]:[]),
    ...(runtimeCapabilities.harnessTools?[{id:"tools",label:"Harness capabilities",detail:"Skills, MCP, plugins, apps and hooks",onRun:()=>navigateSection("tools")}]:[]),
    {id:"environments",label:"Environments",detail:"Local, WSL and SSH",onRun:()=>navigateSection("environments")},
    {id:"usage",label:"Usage",detail:"Tokens and cost across recorded turns",onRun:()=>navigateSection("usage")},
    {id:"licenses",label:"Open source licenses",detail:"Third-party packages and installed license notices",onRun:()=>navigateSection("licenses")},
    // Cycle appearance mode and Cycle theme step on to the next choice, whatever it is, so no single row here offers their keys.
    {id:"appearance-system",label:"Appearance: System",detail:"Follow the operating system light/dark setting",onRun:()=>saveAppSettings({appearanceMode:"system"})},
    {id:"appearance-light",label:"Appearance: Light",detail:"Use light appearance",onRun:()=>saveAppSettings({appearanceMode:"light"})},
    {id:"appearance-dark",label:"Appearance: Dark",detail:"Use dark appearance",onRun:()=>saveAppSettings({appearanceMode:"dark"})},
    {id:"theme-trebell",label:"Theme: Trebell",detail:"Default purple Trebell palette",onRun:()=>saveAppSettings({appearance:"dark"})},
    {id:"theme-midnight",label:"Theme: Midnight",detail:"Cooler deep-blue Trebell palette",onRun:()=>saveAppSettings({appearance:"midnight"})},
    {id:"theme-black",label:"Theme: Black",detail:"OLED-friendly black Trebell palette",onRun:()=>saveAppSettings({appearance:"black"})},
    ...(settings.customThemes||[]).map(theme=>({id:"theme-custom:"+theme.id,label:"Theme: "+theme.name,detail:`Custom ${theme.appearance||"dark"} theme`,onRun:()=>saveAppSettings({appearance:theme.id})})),
    {id:"settings",label:"Settings",detail:window.trebellDesktop?"Providers, permissions and desktop behavior":"Providers, permissions and workspace behavior",onRun:()=>navigateSection("settings")},
    ...(paletteThread&&messages.length?[{id:"copy",label:"Copy conversation",detail:"Copy this thread as text",onRun:shareThread}]:[]),
  ];
}
