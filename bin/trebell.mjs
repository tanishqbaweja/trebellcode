#!/usr/bin/env node
import { main } from "../src/trebell.mjs";

main(process.argv.slice(2)).catch((error) => {
  console.error(`Trebell Code failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
