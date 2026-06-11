# Coconote project rules

## Simplify after every change

- After any code change lands (feature, fix, refactor), run a simplify pass
  over the touched area before reporting done: reuse existing helpers instead
  of new near-duplicates, delete fallbacks/branches the change made dead,
  collapse duplication the change introduced, keep new comments minimal.
- Scope it to the change: the diff and the files it touches, not the repo.
- Test code under .claude/ is exempt unless explicitly asked.

## Written content characters

- Applies to **natural-language text written to disk**: documentation, the `introduction/` spec files, code comments, commit messages, README, and user-facing UI strings. It does **not** apply to program syntax.
- Use only characters typeable on a standard keyboard (ASCII). Do not use:
  - **semicolons (`;`)** as a sentence connector. Split into two sentences, or use a comma, colon, or parentheses.
  - **em-dash / en-dash (`—` `–`)**. Use a plain hyphen `-`, a colon, or parentheses.
  - **other non-keyboard characters**: curly quotes `"" ''` become `" '`, ellipsis `…` becomes `...`, right arrow `→` becomes `->`, multiplication sign `×` becomes `x`, bullets `•` in prose become `-`.
- These non-keyboard characters are called **non-ASCII characters** (a.k.a. **typographic characters**).
- Exceptions:
  - **Code syntax** that genuinely requires a character (semicolons in JavaScript / Rust, operators, and so on) is unaffected. This rule is about prose, not code.
  - When the character is itself **the thing being documented or rendered** (for example listing the bullet glyphs `• ◦ ▪ ‣` in a markdown spec), keep it.
