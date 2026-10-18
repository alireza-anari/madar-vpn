import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    {
      name: "sales-html-text",
      enforce: "pre",
      load(id) {
        if (id.endsWith(".png"))
          return "export default Uint8Array.from(atob(" + JSON.stringify(readFileSync(id).toString("base64")) + "), c => c.charCodeAt(0)).buffer;";
        if (id.endsWith(".html"))
          return (
            "export default " + JSON.stringify(readFileSync(id, "utf8")) + ";"
          );
      },
    },
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { compatibilityDate: "2026-10-13" },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
