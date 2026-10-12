import { build } from "esbuild";

// The bundle is ESM, but some dependencies are CommonJS and call require().
// Recreate require from import.meta.url so they keep working once inlined.
const banner = [
  "#!/usr/bin/env node",
  'import { createRequire as __cfCreateRequire } from "node:module";',
  "const require = __cfCreateRequire(import.meta.url);",
].join("\n");

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/chromefile-host.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: banner },
  logLevel: "info",
});
