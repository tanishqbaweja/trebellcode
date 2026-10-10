import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The Markdown renderer for replies (react-markdown, remark-gfm and the unified packages under them) gets its own chunk, as React does.
const MARKDOWN_VENDOR=/\/node_modules\/(react-markdown|remark-[^/]+|micromark[^/]*|mdast-util-[^/]+|hast-util-[^/]+|unist-util-[^/]+|unified|vfile[^/]*|bail|ccount|character-entities[^/]*|character-reference-invalid|comma-separated-tokens|decode-named-character-reference|dequal|devlop|escape-string-regexp|estree-util-is-identifier-name|extend|html-url-attributes|inline-style-parser|is-alphabetical|is-alphanumerical|is-decimal|is-hexadecimal|is-plain-obj|longest-streak|markdown-table|parse-entities|property-information|space-separated-tokens|stringify-entities|style-to-js|style-to-object|trim-lines|trough|zwitch|@ungap\/structured-clone)\//;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/")) return "react-vendor";
          if (MARKDOWN_VENDOR.test(id)) return "markdown-vendor";
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3210",
    },
  },
});
