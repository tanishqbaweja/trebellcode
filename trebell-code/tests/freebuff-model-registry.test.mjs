import test from "node:test";
import assert from "node:assert/strict";
import {
  ModelRegistry,
  parseFreeAgents,
  parseFreebuffPickerModels,
} from "../vendor/freebuff2api/src/models.ts";

const constants = `
export const FREEBUFF_GLM_V53_FLASH_MODEL_ID = 'z-ai/glm-5.3-flash'
export const FREEBUFF_GLM_V53_MODEL_ID = 'z-ai/glm-5.3'

const GLM_V53_FLASH_MODEL = {
  id: FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  displayName: 'GLM 5.3 Flash',
}

const GLM_V53_PROVISIONED_MODEL = {
  id: FREEBUFF_GLM_V53_MODEL_ID,
  displayName: 'GLM 5.3',
}

// Provisioned only: GLM_V53_PROVISIONED_MODEL must never leak into the picker.
export const FREEBUFF_MODELS = [
  GLM_V53_FLASH_MODEL,
]
`;

const agents = `
export const FREEBUFF_AGENT_MODEL_CONFIG = {
  'base2-free-glm-5-3-flash': new Set([FREEBUFF_GLM_V53_FLASH_MODEL_ID]),
  'base2-free-glm-5-3': new Set([FREEBUFF_GLM_V53_MODEL_ID]),
}
`;

test("public picker parser excludes provisioned models even when an agent root exists", () => {
  const picker = parseFreebuffPickerModels(constants);
  assert.deepEqual([...picker], ["z-ai/glm-5.3-flash"]);

  const mapping = parseFreeAgents(agents, constants);
  assert.deepEqual(mapping.get("base2-free-glm-5-3-flash"), ["z-ai/glm-5.3-flash"]);
  assert.deepEqual(mapping.get("base2-free-glm-5-3"), ["z-ai/glm-5.3"]);
});

test("ModelRegistry advertises only Freebuff regular-picker models", async () => {
  const fetchFn = async (url) => {
    if (String(url).endsWith("/free-agents.ts")) return new Response(agents, { status: 200 });
    if (String(url).endsWith("/freebuff-models.ts")) return new Response(constants, { status: 200 });
    return new Response("", { status: 200 });
  };

  const registry = new ModelRegistry(fetchFn, () => {});
  await registry.start();
  registry.stop();

  assert.deepEqual(registry.models(), ["freebuff/z-ai/glm-5.3-flash"]);
  assert.equal(registry.agentForModel("freebuff/z-ai/glm-5.3-flash"), "base2-free-glm-5-3-flash");
  assert.equal(registry.agentForModel("freebuff/z-ai/glm-5.3"), undefined);
});
