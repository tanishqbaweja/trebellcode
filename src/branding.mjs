const REPLACEMENTS = [
  [/OpenAI Codex/g, "Trebell Code"],
  [/Codex CLI/g, "Trebell Code"],
  [/codex CLI/g, "Trebell Code"],
  [/\bcodex\b/g, "trebell"],
];

export function rebrandTerminalChunk(input) {
  let output = String(input);
  for (const [pattern, replacement] of REPLACEMENTS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}
