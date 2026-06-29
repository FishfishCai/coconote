import { yaml as yamlLanguage } from "@codemirror/legacy-modes/mode/yaml";
import { type Language, StreamLanguage } from "@codemirror/language";

const yamlStreamLanguage = StreamLanguage.define(yamlLanguage);

// The supported set is exactly the spec list in docs/behavior/markdown.md
// ("Code"): yaml, json, javascript/js, typescript/ts, python/py, rust/rs,
// c, cpp/c++, java, csharp/cs, go/golang, sh/bash/zsh/fish, sql, css,
// xml, swift, kotlin, scala, dart, ruby, perl, r, toml, protobuf, diff,
// powershell, dockerfile, cmake, nix. yaml stays eager so frontmatter
// highlights on first paint without an async load.
const eagerLanguages: Record<string, Language> = {
  yaml: yamlStreamLanguage,
};

// Each entry is a lazy loader. import() is cached by the JS runtime so
// aliases sharing a module (c/cpp/java from clike) don't re-fetch.
// Specifiers stay literal so esbuild can statically split the bundle.
export const lazyLanguages: Record<string, () => Promise<Language>> = {
  javascript: async () =>
    (await import("@codemirror/lang-javascript")).javascriptLanguage,
  js: async () =>
    (await import("@codemirror/lang-javascript")).javascriptLanguage,
  typescript: async () =>
    (await import("@codemirror/lang-javascript")).typescriptLanguage,
  ts: async () =>
    (await import("@codemirror/lang-javascript")).typescriptLanguage,
  json: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/javascript")).json,
    ),
  sql: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/sql")).standardSQL,
    ),
  css: async () => (await import("@codemirror/lang-css")).cssLanguage,
  nix: async () =>
    (await import("@replit/codemirror-lang-nix")).nixLanguage,
  python: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/python")).python,
    ),
  py: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/python")).python,
    ),
  rust: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/rust")).rust,
    ),
  rs: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/rust")).rust,
    ),
  r: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/r")).r,
    ),
  sh: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/shell")).shell,
    ),
  bash: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/shell")).shell,
    ),
  zsh: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/shell")).shell,
    ),
  fish: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/shell")).shell,
    ),
  go: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/go")).go,
    ),
  golang: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/go")).go,
    ),
  xml: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/xml")).xml,
    ),
  swift: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/swift")).swift,
    ),
  toml: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/toml")).toml,
    ),
  protobuf: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/protobuf")).protobuf,
    ),
  diff: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/diff")).diff,
    ),
  powershell: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/powershell")).powerShell,
    ),
  perl: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/perl")).perl,
    ),
  ruby: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/ruby")).ruby,
    ),
  dockerfile: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile,
    ),
  cmake: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/cmake")).cmake,
    ),
  c: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/clike")).c,
    ),
  cpp: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/clike")).cpp,
    ),
  "c++": async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/clike")).cpp,
    ),
  java: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/clike")).java,
    ),
  csharp: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/clike")).csharp,
    ),
  cs: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/clike")).csharp,
    ),
  scala: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/clike")).scala,
    ),
  kotlin: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/clike")).kotlin,
    ),
  dart: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/clike")).dart,
    ),
};

const cache: Record<string, Language> = {};

export function languageFor(name: string): Language | null {
  return eagerLanguages[name] ?? cache[name] ?? null;
}

export async function loadLanguageFor(
  name: string,
): Promise<Language | null> {
  const eager = eagerLanguages[name];
  if (eager) return eager;
  if (cache[name]) return cache[name];
  const loader = lazyLanguages[name];
  if (!loader) return null;
  cache[name] = await loader();
  return cache[name];
}
