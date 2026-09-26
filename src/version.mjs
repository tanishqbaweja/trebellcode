import { readFileSync } from "node:fs";

export const TREBELL_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

export const TREBELL_USER_AGENT = `Trebell-Code/${TREBELL_VERSION}`;
