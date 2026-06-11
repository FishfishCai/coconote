// The "nothing here yet" hint shared by settings lists (Local roots,
// Remote servers). Single class so a CSS tweak applies to every empty
// list at once.

import type { ComponentChildren } from "preact";

export function EmptyState({ children }: { children: ComponentChildren }) {
  return <p className="coconote-settings-hint">{children}</p>;
}
