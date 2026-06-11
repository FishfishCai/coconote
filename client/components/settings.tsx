import type { ClientContext as Client } from "../core/context.ts";
import type { AppViewState } from "../types/ui.ts";
import { patchConfig } from "../lib/config_api.ts";
import { AppearanceSection } from "./settings/appearance_section.tsx";
import { SnippetsSection } from "./settings/snippets_section.tsx";
import { ShortcutsSection } from "./settings/shortcuts_section.tsx";
import { PagesSection } from "./settings/pages_section.tsx";
import { RemoteVaultsSection } from "./settings/remote_vaults_section.tsx";
import { ConfigPathSection } from "./settings/config_path_section.tsx";

type Props = {
  client: Client;
  uiOptions: AppViewState["uiOptions"];
};

export function Settings({ client, uiOptions }: Props) {
  const set = (k: string, v: unknown) => client.setUiOption(k, v);
  // Snippets persist to the server-side snippet.json sidecar (editor.md
  // Snippet, same lookup path as coconote.yaml). The local mirror keeps
  // the editor responsive without a round trip.
  const onSnippetsChange = (v: string) => {
    set("snippets", v);
    void patchConfig({ snippets: v })
      .catch((e) => console.warn("snippet.json save failed:", e));
  };
  return (
    <div className="coconote-settings">
      <header className="coconote-settings-head">
        <h1>Setting</h1>
        <button
          type="button"
          className="coconote-settings-content-btn"
          onClick={() => {
            client.navigateRoute({ kind: "content", view: "path" });
          }}
        >
          content
        </button>
      </header>

      <AppearanceSection uiOptions={uiOptions} set={set} />
      <SnippetsSection
        value={uiOptions.snippets}
        onChange={onSnippetsChange}
      />
      <ShortcutsSection client={client} />
      <PagesSection client={client} />
      <RemoteVaultsSection />
      <ConfigPathSection />
    </div>
  );
}
