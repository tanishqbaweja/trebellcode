import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";

// Opened from the Dock, Finder or a Linux launcher, the desktop app gets the session's bare PATH (launchd's
// /usr/bin:/bin:/usr/sbin:/sbin on macOS) instead of the one the person's shell profile builds. Harness CLIs installed under
// ~/.local/bin, Homebrew or mise would then look missing, and a JDK outside the system folders would have no JAVA_HOME. So, once
// as the app starts and before its GUI server exists, desktop/main.mjs asks the person's login shell for a few variables and
// copies them into process.env. The values come back between two copies of a boundary drawn anew for each run, so whatever the
// profile itself prints around them does not matter. The shell gets two seconds; one that fails, hangs or prints nothing changes
// nothing. Windows is left alone.

// mise's own note of the PATH entries it added, which mise reads back to tell its entries from the person's.
const MISE_NOTE = "__MISE_DIFF";
// The variables asked for, in this order.
const ASKED_NAMES = Object.freeze(["PATH", "JAVA_HOME", MISE_NOTE]);
// Two seconds: Git Bash's login start took 0.3-0.5 s on an idle machine, so this leaves room for a loaded one, and the first window,
// which waits for the read, waits at most this long.
const READ_BOUND_MS = 2_000;
// Output kept from the shell, in characters: a profile that prints without end cannot fill memory.
const OUTPUT_ROOM = 1_048_576;
const READ_ON = new Set(["darwin", "linux"]);
// Off Windows the shell leads a process group of its own (see askLoginShell).
const OWN_GROUP = process.platform !== "win32";

// ---- What the shell is asked to print -----------------------------------------------------------------------------------------
// One run's output, as the shell prints it:
//   <boundary> NUL <first name's value> LF NUL <second name's value> LF NUL ... <boundary> LF
// The boundary is new on every run, so nothing a profile prints can hold it. A value cannot hold NUL (the environment keeps C
// strings), so a NUL ends each one; printenv prints a value and a line break, and nothing for a name that is not set.
const NUL = "\0";

// A new boundary: Trebell's prefix and 16 hex digits drawn at random. It holds no % or \, so printf prints it as it is.
export function newShellBoundary() {
  return "trebell-login-shell-" + randomBytes(8).toString("hex");
}

// POSIX's portable variable names (XBD 8.1): capital letters, digits and _, not starting with a digit. Only these are written into
// the command line.
const PORTABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

// The command line for names, in their order, around boundary. printf's format here has no conversion, and its \0 is the octal
// escape for a NUL byte (POSIX printf); `|| true` keeps a profile that turned on errexit from ending at a name that is not set.
export function loginShellCommand(names = ASKED_NAMES, boundary = newShellBoundary()) {
  const parts = [`printf '${boundary}\\0'`];
  for (const asked of names) {
    const name = String(asked);
    if (!PORTABLE_NAME.test(name)) {
      throw new Error(`Trebell asks a login shell only for variable names made of capital letters, digits and _ that do not start with a digit, and '${name}' is not one.`);
    }
    parts.push(`printenv ${name} || true`, `printf '\\0'`);
  }
  parts.push(`printf '${boundary}\\n'`);
  return parts.join("; ");
}

// One printed value without the line break printenv ends it with (\n, or \r\n where the output's line ends were changed).
function withoutPrintedBreak(piece) {
  if (piece.endsWith("\r\n")) return piece.slice(0, -2);
  if (piece.endsWith("\n")) return piece.slice(0, -1);
  return piece;
}

// The values of names in a run's output: what lies between the first "<boundary> NUL" and the next boundary has to be one
// NUL-ended piece per name, in order, or nothing is read (the shell was cut off, or this is not that command's output). A name
// whose value is empty, or that is not set, is left out.
export function parseLoginShellOutput(output, names = ASKED_NAMES, boundary = "") {
  const text = output == null ? "" : String(output);
  const opening = boundary ? text.indexOf(boundary + NUL) : -1;
  if (opening < 0) return {};
  const from = opening + boundary.length + 1;
  const closing = text.indexOf(boundary, from);
  if (closing < 0) return {};
  const pieces = text.slice(from, closing).split(NUL);
  if (pieces.length !== names.length + 1 || pieces[names.length] !== "") return {};
  const values = {};
  names.forEach((name, index) => {
    const value = withoutPrintedBreak(pieces[index]);
    if (value) values[name] = value;
  });
  return values;
}

// ---- PATH ----------------------------------------------------------------------------------------------------------------------
// The login shell's PATH entries first, in its order, then the app's own that it lacks. Entries are taken as written (a space is a
// valid character of a folder's name); a zero-length entry is dropped, since POSIX (XBD 8.3) reads one as the current folder, which
// Trebell never wants searched; an entry already taken is not added again.
export function mergeShellPath(shellSide, appSide) {
  const merged = [];
  for (const side of [shellSide, appSide]) {
    for (const entry of String(side ?? "").split(":")) {
      if (entry && !merged.includes(entry)) merged.push(entry);
    }
  }
  return merged.join(":");
}

// The shell to ask: the one the caller names, else the session's SHELL, else the shell of the person's account.
function shellToAsk(named, env) {
  if (named !== undefined) return named ? String(named) : "";
  const fromSession = String(env?.SHELL ?? "").trim();
  if (fromSession) return fromSession;
  try {
    return String(userInfo().shell ?? "").trim();
  } catch {
    return "";
  }
}

const describeError = error => error?.message || String(error);

// Ends a shell that ran past its bound: off Windows its whole process group (what its profile started goes too), then the shell.
function stopShell(child) {
  if (OWN_GROUP && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group has already gone.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The shell has already gone.
  }
}

// Waits for the shell to end, keeping its output up to OUTPUT_ROOM characters. Resolves { output } when it exits with code 0,
// and { failure } with the reason when it exits otherwise, ends on a signal, reports an error or outlives boundMs.
function awaitShell(child, boundMs) {
  return new Promise(resolve => {
    const pieces = [];
    let room = OUTPUT_ROOM;
    let finished = false;
    let bound = null;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(bound);
      resolve(result);
    };
    bound = setTimeout(() => {
      stopShell(child);
      finish({ failure: `it did not finish within ${boundMs / 1000} seconds.` });
    }, boundMs);
    const stdout = child.stdout;
    if (stdout) {
      stdout.setEncoding?.("utf8");
      stdout.on("data", chunk => {
        if (room <= 0) return;
        const piece = String(chunk).slice(0, room);
        pieces.push(piece);
        room -= piece.length;
      });
    }
    child.once("error", error => finish({ failure: describeError(error) }));
    child.once("close", (code, signal) => {
      if (code === 0) finish({ output: pieces.join("") });
      else if (signal) finish({ failure: `it ended on ${signal}.` });
      else finish({ failure: `it exited with code ${code}.` });
    });
  });
}

// Asks the login shell for the names and resolves the values it printed, or {} when there is no shell, or it cannot start,
// fails or runs past timeoutMs (each of those logged once). It runs as `<shell> -ilc`, interactive and login so that the profile
// files that set PATH are read, with the given environment, in the home folder, with no input and only its stdout read. Off
// Windows it leads a process group of its own: started from a terminal, the app could otherwise see the shell stopped by the
// terminal's job control, and a timeout ends what the profile started too. On Windows (tests only) a detached child would open
// a console window.
export async function askLoginShell({
  env = process.env,
  shell,
  names = ASKED_NAMES,
  timeoutMs = READ_BOUND_MS,
  cwd = homedir(),
  spawnFn = spawn,
  boundary = newShellBoundary(),
  log = () => {},
} = {}) {
  const program = shellToAsk(shell, env);
  if (!program) return {};
  const giveUp = reason => {
    log(`Trebell could not read PATH from the login shell (${program} -ilc): ${reason}`);
    return {};
  };
  let child;
  try {
    const options = { cwd, env, stdio: ["ignore", "pipe", "ignore"], detached: OWN_GROUP, windowsHide: true };
    child = spawnFn(program, ["-ilc", loginShellCommand(names, boundary)], options);
  } catch (error) {
    return giveUp(describeError(error));
  }
  const ended = await awaitShell(child, timeoutMs);
  return "output" in ended ? parseLoginShellOutput(ended.output, names, boundary) : giveUp(ended.failure);
}

// Reads the login shell (macOS and Linux only) and puts what it gave into env, the desktop app's process.env that the GUI server
// and every harness start from: its PATH ahead of the app's own entries, with mise's note of that PATH, and its JAVA_HOME when env
// has none. mise's note only describes the shell's PATH, so it is not taken without it. It reaches what takes the whole
// environment (the terminal drawer's shell), and a harness only when its profile lists the note's name, since the note can carry
// the values of mise's [env] settings, secrets among them; a CLI started through a `mise x` wrapper of the same name needs it, or
// mise puts that wrapper first on PATH again and the wrapper keeps starting itself. Resolves the values read.
export async function hydrateLoginShellEnvironment(env = process.env, { platform = process.platform, ...readOptions } = {}) {
  if (!READ_ON.has(platform)) return {};
  const found = await askLoginShell({ ...readOptions, env });
  if (found.PATH) {
    env.PATH = mergeShellPath(found.PATH, env.PATH);
    if (found[MISE_NOTE]) env[MISE_NOTE] = found[MISE_NOTE];
  }
  const javaHomeSet = String(env.JAVA_HOME ?? "").trim() !== "";
  if (!javaHomeSet && found.JAVA_HOME) env.JAVA_HOME = found.JAVA_HOME;
  return found;
}
