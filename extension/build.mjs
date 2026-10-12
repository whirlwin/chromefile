import { cp, rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/background.ts", "src/popup.ts"],
  outdir: "dist",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome135",
  logLevel: "info",
});

// manifest.json, popup.html and anything else static ship as-is.
await cp("static", "dist", { recursive: true });
