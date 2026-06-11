// setting.md Config file. The api helper hides Electron-shell vs
// browser-against-headless-server. Reset writes the pointer + restarts:
// on next boot the server reads `<dir>/coconote.yaml`, overwriting it
// with a default if missing/unparseable, so no client-side validation.

import { useEffect, useState } from "preact/hooks";
import { applyConfigPath, getConfigPath } from "../../lib/config_path_api.ts";

export function ConfigPathSection() {
  const [draft, setDraft] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getConfigPath().then((v) => setDraft(v));
  }, []);

  const onReset = async () => {
    setBusy(true);
    // applyConfigPath() either restarts the host (Electron) or returns
    // after the server re-execs. Transport errors have nowhere to
    // surface yet, so just re-enable the form so the user isn't stuck.
    try {
      await applyConfigPath(draft);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="coconote-pages-head">
        <h2>Config file</h2>
      </div>
      <div className="coconote-config-path-row">
        <input
          type="text"
          value={draft}
          spellcheck={false}
          disabled={busy}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        />
        <button
          type="button"
          className="coconote-pages-add"
          disabled={busy}
          title="Restart with this directory"
          onClick={() => void onReset()}
        >
          Reset
        </button>
      </div>
    </section>
  );
}
