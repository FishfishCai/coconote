# Coconote project rules

## Layout and commands

- client/ is the Preact + CodeMirror 6 web client. server-rs/ is the Rust
  axum server that embeds the built client. electron/ is the desktop shell
  running the server as a sidecar. mcp/ is the MCP server giving AI agents
  access to a vault.
- introduction/ holds the product spec (10 markdown files). It is the
  source of truth for behavior: code follows the spec, and behavior changes
  update it.
- .claude/ (gitignored) holds throwaway scripts plus the feature-test
  scaffolding: .claude/feature/FEATURES.md, .claude/feature/tests/, and
  .claude/feature/fixtures/ (the test vault). The harness mounts fixtures
  as root `fixtures` and introduction/ as root `spec`.
- Checks: `npm run check` (tsc), `npm run lint` (biome), `npm run build`
  (client bundle), `cargo test --manifest-path server-rs/Cargo.toml`.
  Feature tests: `node .claude/feature/tests/test_<name>.cjs` (they spawn
  `server-rs/target/release/coconote`, so run `make release` first).

## Simplify after every change

- After finishing the code changes for a task, run one simplify pass over
  the touched area before reporting done: reuse existing helpers instead
  of new near-duplicates, delete fallbacks and branches the change made
  dead, collapse duplication the change introduced, keep new comments
  minimal.
- Limit simplification edits to the changed code and its immediate
  surroundings in touched files. Leave unrelated code in those files
  alone.
- Scratch and test scripts under .claude/ are exempt from the simplify
  pass unless the user explicitly asks to simplify them. Tests elsewhere
  in the repo are in scope.

## Change workflow

Every change batch goes through these steps, in this order:

1. Implement. Code follows the introduction/ spec.
2. Simplify pass over the touched area (rules above). The bar: the
   changed code is modular and clear, and it actually delivers every
   requested feature in full (not a partial or stubbed version).
3. Documentation pass, all three surfaces, before any feature run:
   - introduction/ spec (the 10 files): the behavior the batch changed
     is written, correct, and terse. Read the changed sections and fix
     anything wrong, missing, mis-stated, or redundant. Spec is the
     source of truth, so it leads the other two.
   - .claude/feature/FEATURES.md: every new or changed behavior has a
     row, every row is correct, nothing is duplicated or stale.
   - mcp/: when the spec changed, propagate it. The guides (mcp/guide/)
     must agree with the spec, and the principle holds that anything a
     human can change through the UI the AI must be able to do through
     an MCP tool. So check whether the batch needs a new or changed
     tool, and add it. Read paths matter, mutations are mandatory.
4. Feature verification: update .claude/feature/ tests for the new or
   changed behavior. The FULL suite is run only ONCE, at the end, when
   the code is frozen and will not change again. Running it earlier
   wastes a cycle, because any later edit invalidates the result. Fix
   until the full frozen-code run is green.
5. Periphery check: .gitignore coverage, the three version manifests,
   .github/workflows, README.
6. Staged commits (one concern per commit), push.
7. Release only: fast-forward main, tag vX.Y.Z matching the manifests,
   push the tag, then watch the GitHub release workflow until every
   asset is attached. Debug failures immediately.

## Written content characters

- Applies to natural-language prose you produce: documentation, the
  introduction/ spec files, code comments (including comments in .claude/
  scripts), commit messages, README, and user-facing UI strings. It does
  not apply to program syntax. The contents of a string literal shown to
  users count as prose, the code around it is syntax.
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
