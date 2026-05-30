import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  outDir: "dist",
  target: "esnext",
  // Emit `.js` / `.d.ts` rather than tsdown's default `.mjs` / `.d.mts`, so the
  // entry points declared in package.json (main/module/types/exports) keep
  // resolving without changes.
  fixedExtension: false,
  // spectrum-ts and zod are peer dependencies (zod must be the same instance
  // spectrum-ts parses with); @linqapp/sdk is a runtime dependency. tsdown
  // treats all dependencies and peerDependencies — including subpaths like
  // spectrum-ts/authoring — as external by default, so none of them are bundled.
});
