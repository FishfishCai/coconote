// setting.md Setting panel: the Watch + Server sections (rendered last, after
// Snippets). Unlike appearance / shortcuts / snippets (localStorage), these
// read and write the server's coconote.yaml through GET / PATCH /.config:
//   - Watch: the `watch` directory roots (addWatch / removeWatch).
//   - Server: the listening port (read-only) and the `url` list of remote
//     Coconote instances to push / pull with (addUrl / removeUrl).
// Both are the same shape - an add-row over an editable list whose mutations
// PATCH the yaml and return the updated config - so they share one ConfigList.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  addUrl,
  addWatch,
  type CoconoteConfig,
  getConfig,
  removeUrl,
  removeWatch,
} from "../../core/config/index.ts";
import { errMessage } from "../../core/util";
import { Button } from "../../core/ui";
import { SettingRow } from "./setting_row.tsx";

type Field = { key: string; placeholder: string; narrow?: boolean };

/** A settings section that edits one server-config list (watch dirs or remote
 *  urls): an add-row of one or more fields over a removable list, each PATCH
 *  returning the fresh config. Owns its own draft + inline error, so the
 *  message sits next to the input that produced it. */
function ConfigList(props: {
  heading: string;
  before?: ComponentChildren;
  items: Array<{ key: string; text: string }>;
  emptyText: string;
  fields: Field[];
  onAdd: (values: Record<string, string>) => Promise<CoconoteConfig>;
  onRemove: (key: string) => Promise<CoconoteConfig>;
  onChange: (config: CoconoteConfig) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const values = Object.fromEntries(
      props.fields.map((f) => [f.key, (draft[f.key] ?? "").trim()]),
    );
    if (!values[props.fields[0].key]) return; // first field is required
    setError(null);
    void props.onAdd(values)
      .then((c) => {
        props.onChange(c);
        setDraft({});
      })
      // Server 400 (bad dir / url) carries its reason text.
      .catch((e) => setError(errMessage(e)));
  };
  const remove = (key: string) => {
    setError(null);
    void props.onRemove(key).then(props.onChange).catch((e) =>
      setError(errMessage(e))
    );
  };

  return (
    <section>
      <h2>{props.heading}</h2>
      {props.before}

      <div className="coconote-watch-list">
        {props.items.length === 0 && (
          <div className="coconote-watch-empty">{props.emptyText}</div>
        )}
        {props.items.map((it) => (
          <div key={it.key} className="coconote-watch-row">
            <span className="coconote-watch-path">{it.text}</span>
            <Button onActivate={() => remove(it.key)}>Remove</Button>
          </div>
        ))}
      </div>

      <div className="coconote-watch-add">
        {props.fields.map((f) => (
          <input
            key={f.key}
            type="text"
            className={f.narrow
              ? "coconote-watch-input coconote-url-auth"
              : "coconote-watch-input"}
            placeholder={f.placeholder}
            value={draft[f.key] ?? ""}
            onInput={(e) => setDraft({ ...draft, [f.key]: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        ))}
        <Button primary onActivate={submit}>Add</Button>
      </div>

      {error && <div className="coconote-server-error">{error}</div>}
    </section>
  );
}

export function ServerSection() {
  const [config, setConfig] = useState<CoconoteConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    void getConfig().then(setConfig).catch((e) => setLoadError(errMessage(e)));
  }, []);
  const port = config?.port ?? null;

  // A load failure is shown up front: without it the lists read as an empty
  // config ("No watch directories.") and the user can't tell the difference.
  if (loadError) {
    return (
      <section>
        <h2>Server</h2>
        <div className="coconote-server-error">{loadError}</div>
      </section>
    );
  }

  return (
    <>
      <ConfigList
        heading="Watch"
        items={(config?.watch ?? []).map((d) => ({ key: d, text: d }))}
        emptyText="No watch directories."
        fields={[{ key: "dir", placeholder: "/absolute/directory/path" }]}
        onAdd={(v) => addWatch(v.dir)}
        onRemove={(d) => removeWatch(d)}
        onChange={setConfig}
      />
      <ConfigList
        heading="Server"
        before={
          <SettingRow label="Listening port">
            <span className="coconote-value">
              {port === null ? "..." : port}
            </span>
          </SettingRow>
        }
        items={(config?.url ?? []).map((u) => ({ key: u.url, text: u.url }))}
        emptyText="No remote instances."
        fields={[
          { key: "url", placeholder: "https://other-coconote.example.com" },
          { key: "auth", placeholder: "auth token", narrow: true },
        ]}
        onAdd={(v) => addUrl(v.url, v.auth)}
        onRemove={(u) => removeUrl(u)}
        onChange={setConfig}
      />
    </>
  );
}
