// The PATH a command run on a WSL or SSH host gets. Such a command may run without the person's interactive profile (bash reads
// none of its profile files when it is not interactive), so a CLI installed through Homebrew or a Node version manager would not
// be found. The lines built here go before every remote command: they use shell built-ins only, and they run in sh, dash, bash,
// ksh and zsh alike, as any of them may be the host's login shell.

// Where each tool keeps its commands, first found first. A folder is written as the host's shell expands it: from the tool's
// documented variable when the host sets it, else from the documented default. nvm's entry names its folder ("versionsOf", or
// "fallback" when that expands to nothing), under which versions/node holds one folder per installed Node version, each with a bin.
const TOOL_FOLDERS=[
  // Version managers whose shims pick the Node version a project asks for.
  {tool:"Volta",folders:['"${VOLTA_HOME:-$HOME/.volta}/bin"']},
  {tool:"mise",folders:['"${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims"',"/usr/local/share/mise/shims"]},
  {tool:"asdf",folders:['"${ASDF_DATA_DIR:-$HOME/.asdf}/shims"','"${ASDF_DIR:-$HOME/.asdf}/bin"']},
  {tool:"nodenv",folders:['"${NODENV_ROOT:-$HOME/.nodenv}/shims"','"${NODENV_ROOT:-$HOME/.nodenv}/bin"']},
  // Version managers with fixed folders: the fnm command's install folder, and every Node version nvm installed.
  {tool:"fnm",folders:['"${XDG_DATA_HOME:-$HOME/.local/share}/fnm"','"$HOME/Library/Application Support/fnm"','"$HOME/.fnm"']},
  {tool:"nvm",versionsOf:'"${NVM_DIR:-${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/nvm}}"',fallback:'"$HOME/.nvm"'},
  // The person's own bins, Homebrew's (Apple Silicon, then Linux) and the system's.
  {tool:"user",folders:['"$HOME/.local/bin"','"$HOME/bin"']},
  {tool:"Homebrew",folders:["/opt/homebrew/bin","/home/linuxbrew/.linuxbrew/bin"]},
  {tool:"system",folders:["/usr/local/bin","/usr/bin","/bin"]},
];

// trebell_path_front puts each existing folder it is given in front of PATH unless PATH already holds it, so the folder given last
// is found first; an empty PATH gets no empty entry, which would stand for the current folder. trebell_path_versions does that for
// each version's bin, in name order, so the version whose name sorts last is found first; zsh, where a glob that matches nothing
// stops the command, gets null_glob for that one function.
const HELPERS=`trebell_path_front() {
  for trebell_path_folder in "$@"; do
    [ -d "$trebell_path_folder" ] || continue
    case ":$PATH:" in
      *":$trebell_path_folder:"*) ;;
      *) PATH="$trebell_path_folder\${PATH:+:$PATH}" ;;
    esac
  done
}
trebell_path_versions() {
  trebell_path_root=$1
  [ -n "$trebell_path_root" ] || trebell_path_root=$2
  [ -d "$trebell_path_root/versions/node" ] || return 0
  [ -z "\${ZSH_VERSION-}" ] || setopt local_options null_glob
  trebell_path_front "$trebell_path_root"/versions/node/*/bin
}`;

// Each folder is put in front of the ones before it, as each tool's own profile line does, so the lines walk the list from the
// last tool to the first.
function toolPathLines(){
  const lines=[HELPERS];
  for(const entry of [...TOOL_FOLDERS].reverse()){
    if(entry.versionsOf)lines.push(`trebell_path_versions ${entry.versionsOf} ${entry.fallback}`);
    else lines.push(`trebell_path_front ${[...entry.folders].reverse().join(" ")}`);
  }
  // The helpers go before PATH is exported, so the lines end with the export, where callers put their own lines.
  lines.push("unset -f trebell_path_front trebell_path_versions","unset trebell_path_folder trebell_path_root","export PATH");
  return lines.join("\n");
}

const TOOL_PATH_LINES=toolPathLines();

// The lines a remote command runs first. Callers add their own lines (a profile's prelude, a cd) and the command after them.
export function remoteToolPathPrelude(){return TOOL_PATH_LINES}
