// Enforces the client 3-tier architecture (see .claude/feature-arch.md):
//   core  <-  capabilities  <-  features  <-  shell
// Imports may only point DOWN; no sideways edges between features. This is
// the structural guarantee made executable - `npm run boundaries` fails CI
// the moment an up- or sideways-import is introduced, so the layering cannot
// silently erode.
module.exports = {
  forbidden: [
    {
      name: "core-no-up",
      comment:
        "core/ is the foundation: it must not import capabilities, features, " +
        "or shell. The ONLY tolerated up-reference is a type-only ctx contract " +
        "naming its concrete implementor (e.g. SpaceCtx: Space) - those are " +
        "erased at build, so dependencyTypesNot exempts them.",
      severity: "error",
      from: { path: "^client/core/" },
      to: {
        path: "^client/(capabilities|features|shell)/",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "capabilities-no-up",
      comment:
        "capabilities/ are reusable mechanisms built on core only - never on " +
        "a feature or the shell.",
      severity: "error",
      from: { path: "^client/capabilities/" },
      to: { path: "^client/(features|shell)/" },
    },
    {
      name: "features-no-shell",
      comment:
        "features/ must not import the shell. The shell composes features, " +
        "not the reverse.",
      severity: "error",
      from: { path: "^client/features/" },
      to: { path: "^client/shell/" },
    },
    {
      name: "no-sibling-feature",
      comment:
        "features/ are siblings and must not import each other - share by " +
        "pushing the common part DOWN into a capability or core.",
      severity: "error",
      from: { path: "^client/features/([^/]+)/" },
      to: {
        path: "^client/features/([^/]+)/",
        pathNot: "^client/features/$1/",
      },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    // Surface type-only imports so the core-no-up exemption can see them.
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    // Tests are not part of the runtime tier graph.
    exclude: { path: "(\\.test\\.ts$|node_modules)" },
    enhancedResolveOptions: { extensions: [".ts", ".tsx", ".js", ".mjs"] },
  },
};
