import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The client uses two import styles that Node/tsc resolve but Vite does
// not out of the box:
//   1. Relative specifiers that keep the `.ts` extension
//      (e.g. `import ... from "./path_url.ts"`). Vite/esbuild resolve
//      these natively, so they need no help here.
//   2. The `coconote/*` subpath imports declared in package.json
//      "exports" (e.g. `import type { Path } from "coconote/lib/ref"`).
//      Vite does not honor a package's own "exports" for self-imports,
//      so we replicate that map as resolve.alias. Deriving the aliases
//      straight from package.json keeps the two from drifting: add a
//      subpath export and the test resolver picks it up for free.
const root = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

const alias = Object.entries(pkg.exports).map(([subpath, target]) => ({
  // "./lib/ref" -> "coconote/lib/ref"; the target is repo-relative
  // ("./client/lib/ref.ts") and resolved to an absolute path.
  find: `coconote/${subpath.replace(/^\.\//, "")}`,
  replacement: fileURLToPath(new URL(target, import.meta.url)),
}));

export default defineConfig({
  root,
  resolve: { alias },
  test: {
    // The targeted libs are framework-free pure logic - no DOM needed.
    environment: "node",
    include: ["client/**/*.test.ts"],
  },
});
