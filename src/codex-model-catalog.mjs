import { codexConfiguredServiceTier } from "./model-service-tier.mjs";

// What Trebell takes from the person's own Codex model list (`model/list`): the model a new Codex thread starts on, the tier each
// model runs at by default, and how a reasoning level reads in the composer. The UI bundles this module, so it stays free of
// Node built-ins.

// The model a new Codex thread starts on, picked as Codex picks its own (codex-rs/models-manager/src/manager.rs at the tag
// rust-v0.155.1, default_model_from_available): the first row model/list flags as its default (isDefault exactly true), else the
// first row, else none. rows: model/list's rows in Codex's order, as the GUI server lists them. Codex flags one model, the first
// its picker shows (codex-rs/protocol/src/openai_models.rs), so the flag decides whenever Codex gives one.
export function codexStartingModel(rows) {
  const listed = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = listedIdOf(row);
    if (id === "") continue;
    if (row.isDefault === true) return id;
    listed.push(id);
  }
  return listed[0] ?? null;
}

// The id a model/list row is listed under: its id, else its model, as text without the blanks around it. A row with neither
// reads as "" and is no model; the GUI server reads a row's id by the same rule.
function listedIdOf(row) {
  const named = row?.id || row?.model;
  return named ? String(named).trim() : "";
}

// The tier the person's Codex config runs new threads at (config/read's service_tier) is the
// default tier of each model that lists it, so the Speed picker shows it while nothing is picked; a model without it keeps its own.
export function withConfiguredCodexServiceTier(rows = [], serviceTier = null) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    const tier = codexConfiguredServiceTier(row, serviceTier);
    return tier ? { ...row, defaultServiceTier: tier } : row;
  });
}

// How a reasoning level id reads in the composer, for every harness: by the label Codex's own level picker gives it (OpenAI's
// openai/codex, codex-rs/tui/src/chatwidget/model_popups.rs, reasoning_effort_label). Codex accepts any level a model advertises,
// so any other id reads exactly as given (a harness's own level names stay its own), and no id reads as "".
export function codexReasoningEffortLabel(effort) {
  const id = effort ? String(effort) : "";
  return Object.hasOwn(CODEX_PICKER_LEVEL_LABELS, id) ? CODEX_PICKER_LEVEL_LABELS[id] : id;
}

// The picker's label for each level id.
const CODEX_PICKER_LEVEL_LABELS = Object.freeze({
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  persistent: "Persistent",
});
