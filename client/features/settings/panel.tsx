import type { UICtx } from "../../core/ctx/ui.ts";
type Client = UICtx;
import type { AppViewState } from "../../types/ui.ts";
import { Modal } from "../../core/ui";
import { AppearanceSection } from "./appearance_section.tsx";
import { SnippetsSection } from "./snippets_section.tsx";
import { ShortcutsSection } from "./shortcuts_section.tsx";
import { ServerSection } from "./server_section.tsx";

type Props = {
  client: Client;
  uiOptions: AppViewState["uiOptions"];
  onClose: () => void;
};

export function Settings({ client, uiOptions, onClose }: Props) {
  const set = (k: string, v: unknown) => client.setUiOption(k, v);
  // Snippets persist to the browser localStorage userPrefs only (the
  // server dropped the snippet.json sidecar). setUiOption writes the prefs.
  const onSnippetsChange = (v: string) => set("snippets", v);
  // Setting opens as a modal off its shortcut (it shares the one Modal base
  // with recent / history / graph). The Modal header carries the title, so
  // the section list is all the body needs.
  return (
    <Modal title="Setting" size="large" onClose={onClose}>
      <div className="coconote-settings">
        {/* setting.md L105: top-to-bottom Appearance, Shortcuts, Snippets,
            Server. The Server node is last and writes to the server yaml via
            /.config, not localStorage. */}
        <AppearanceSection uiOptions={uiOptions} set={set} />
        <ShortcutsSection client={client} />
        <SnippetsSection
          value={uiOptions.snippets}
          onChange={onSnippetsChange}
        />
        <ServerSection />
      </div>
    </Modal>
  );
}
