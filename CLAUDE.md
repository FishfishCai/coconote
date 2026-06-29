# Coconote project rules

## Layout and commands

- client/ is the Preact + CodeMirror 6 web client. server-rs/ is the Rust
  axum server that embeds the built client. electron/ is the desktop shell
  running the server as a sidecar.
- The product spec lives in .claude/docs/ (local-only, gitignored):
  .claude/docs/design.md is the Chinese product spec and the source of truth
  (code follows it). .claude/docs/markdown.md is the markdown syntax reference
  (kept in English). README, code comments, and commit messages stay
  English/ASCII; only the spec prose is Chinese.
- When the user says they want to try, run, or (re)compile the app, that means:
  delete the previous build artifacts (make clean), then build the
  double-clickable desktop app (make app - it bundles the client + release
  server into electron/dist/mac-arm64/Coconote.app plus a .dmg installer), and
  then let the user open it themselves (they double-click the .app, or install
  the .dmg). Do NOT launch the app or start the server on their behalf.
- Checks: `npm run check` (tsc), `npm run boundaries` (dependency-cruiser
  import tiers), `npm run lint` (biome), `npm run build` (client bundle),
  `npm run test:unit` (vitest), and
  `cargo test --manifest-path server-rs/Cargo.toml`. `make build` runs the
  client bundle plus the cargo build end to end.
- client/ is layered in tiers - core (foundation + the ctx contract) <-
  capabilities (markdown, links, collab: reusable mechanisms) <- features
  (md-editor, pdf, sync, graph, export, settings, recent) + shell (the app
  skeleton, which may import anything). Imports only point DOWN; features
  never import each other - share by pushing the common part into a capability
  or core. Each unit exposes one index.ts; reach a unit only through it.
  `npm run boundaries` (config in .dependency-cruiser.cjs, also a CI step)
  fails on any up- or sideways-import, so the layering cannot erode.

## Written content characters

- Applies to natural-language prose you produce: documentation, the
  .claude/docs/ spec files, code comments, commit messages, README, and UI
  strings. It does not apply to program syntax. The contents of a string
  literal shown to users count as prose, the code around it is syntax.
- Use only ASCII characters typeable on a standard keyboard. Common
  typographic characters map as follows:
  - em-dash and en-dash (`—` `–`) become a plain hyphen `-`, a colon, or
    parentheses.
  - curly quotes `“” ‘’` become `" '`, ellipsis `…` becomes `...`, right
    arrow `→` becomes `->`, multiplication sign `×` becomes `x`, bullets
    `•` in prose become `-`.
- Do not use a semicolon (`;`) to join two clauses in prose. Split into
  two sentences, or use a comma, colon, or parentheses. Semicolons in code
  are unaffected.
- Exceptions:
  - Code syntax that genuinely requires a character is unaffected. This
    rule is about prose, not code.
  - When the character is itself the thing being documented or rendered
    (for example listing the bullet glyphs `• ◦ ▪ ‣` in a markdown spec),
    keep it.
  - Proper nouns and genuinely non-English text keep their original
    characters.
