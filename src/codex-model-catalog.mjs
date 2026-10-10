// Codex model catalog helpers, aligned with T3 Code's Codex provider (applyPreferredCodexDefaultModel,
// mapCodexModelCapabilities). The catalog itself always comes from the user's installed Codex `model/list`.

export const PREFERRED_DEFAULT_CODEX_MODELS = Object.freeze(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"]);

export function codexModelFamily(slug) {
  const id = String(slug || "");
  return id.startsWith("openai.gpt-") ? id.slice("openai.".length) : id;
}

function rowId(row) {
  return String(row?.id || row?.model || "").trim();
}

// Prefer T3's default-model ranking when one of its preferred families is in the live catalog; otherwise keep the model
// Codex itself flags as default.
export function preferredCodexDefaultModel(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).filter(row => rowId(row));
  for (const family of PREFERRED_DEFAULT_CODEX_MODELS) {
    const hit = list.find(row => codexModelFamily(rowId(row)) === family);
    if (hit) return rowId(hit);
  }
  const flagged = list.find(row => row?.isDefault === true);
  return flagged ? rowId(flagged) : null;
}

const REASONING_EFFORT_LABELS = Object.freeze({
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
});

export function codexReasoningEffortLabel(effort) {
  const value = String(effort || "");
  return REASONING_EFFORT_LABELS[value] || value;
}
