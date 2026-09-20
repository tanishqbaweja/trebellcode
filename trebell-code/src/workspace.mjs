import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, join, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const SKIP = new Set([".git","node_modules","target","dist","build",".next",".cache","desktop-dist"]);

export async function workspaceTree(root, { depth = 3, limit = 500 } = {}) {
  const absolute = resolve(root || process.cwd());
  const result = [];
  let remaining = limit;

  async function walk(dir, level) {
    if (level > depth || remaining <= 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (remaining-- <= 0) break;
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      result.push({
        name: entry.name,
        path: full,
        relativePath: full.slice(absolute.length + (absolute.endsWith("/") || absolute.endsWith("\\") ? 0 : 1)),
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        depth: level,
      });
      if (entry.isDirectory()) await walk(full, level + 1);
    }
  }
  await walk(absolute, 0);
  return { root: absolute, entries: result, truncated: remaining <= 0 };
}

export async function workspaceDiff(root) {
  const cwd = resolve(root || process.cwd());
  try {
    const { stdout, stderr } = await execFileAsync("git", ["diff","--no-ext-diff","--no-color"], {
      cwd,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const { stdout: statusOut } = await execFileAsync("git", ["status","--short"], {
      cwd,
      windowsHide: true,
      maxBuffer: 512 * 1024,
    }).catch(() => ({stdout:""}));
    return { cwd, isGit: true, status: statusOut, diff: stdout, stderr };
  } catch (error) {
    return { cwd, isGit: false, status: "", diff: "", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function workspaceFile(filePath, maxBytes = 512_000) {
  const absolute = resolve(filePath);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error("Not a file");
  if (info.size > maxBytes) throw new Error(`File is too large to preview (${Math.ceil(info.size/1024)} KB)`);
  const content = await readFile(absolute, "utf8");
  return { path: absolute, name: basename(absolute), content, size: info.size };
}


export async function workspaceSearch(root, query, { limit = 100 } = {}) {
  const absolute=resolve(root||process.cwd());
  const needle=String(query||"").trim().toLowerCase();
  if(!needle) return {root:absolute,items:[]};
  const tree=await workspaceTree(absolute,{depth:8,limit:3000});
  const items=tree.entries
    .filter(entry=>entry.isFile && (entry.name.toLowerCase().includes(needle)||entry.relativePath.toLowerCase().includes(needle)))
    .slice(0,limit);
  return {root:absolute,items};
}

export async function workspaceWriteFile(filePath, content) {
  const absolute=resolve(filePath);
  await mkdir(join(absolute,".."),{recursive:true}).catch(()=>{});
  await writeFile(absolute,String(content??""),"utf8");
  return workspaceFile(absolute,2*1024*1024);
}
