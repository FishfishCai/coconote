// VaultService: the vault-access layer - owns the space primitives, the
// content manager, and the opt-in known-file index. initSpace wires the
// HTTP space (welcome.md auth), updatePageListCache refreshes the local +
// remote page list and broadcasts it through the UI.

import { nameToFsPath } from "../../lib/path_url.ts";
import { absFsBase } from "../../spaces/constants.ts";
import { getAuthToken } from "../../lib/authed_fetch.ts";
import { HttpSpacePrimitives } from "../../spaces/http_space_primitives.ts";
import { Space } from "../space.ts";
import type { ContentManager } from "../content_manager.ts";
import type { SpaceCtx } from "../ctx/space.ts";
import type { Client } from "../client.ts";

export class VaultService implements SpaceCtx {
  space!: Space;
  httpSpacePrimitives!: HttpSpacePrimitives;
  contentManager!: ContentManager;
  // Opt-in page index (filled by updatePageListCache). Wiki link
  // rendering uses it to mark missing/ambiguous targets.
  readonly allKnownFiles = new Set<string>();
  knownFilesLoaded = false;

  constructor(private client: Client) {}

  initSpace() {
    this.httpSpacePrimitives = new HttpSpacePrimitives(
      absFsBase(),
      (message, actionOrRedirectHeader) => {
        alert(message);
        if (actionOrRedirectHeader === "reload") {
          location.reload();
        } else if (typeof actionOrRedirectHeader === "string") {
          location.href = actionOrRedirectHeader;
        }
      },
      // welcome.md: remote browser clients present the auth token -
      // boot.ts's token gate stored it and seeded the module state.
      getAuthToken(),
    );
    this.space = new Space(this.httpSpacePrimitives);
  }

  reloadEditor() {
    return this.contentManager.reloadEditor();
  }

  async updatePageListCache() {
    try {
      const [localPages, remotePages] = await Promise.all([
        this.space.fetchPageList(),
        // Lazy import: don't pull remote-vault code at boot.
        import("../../lib/remote_index.ts").then((m) => m.fetchAllRemotePages()),
      ]);
      const allPages = localPages.concat(remotePages);
      this.allKnownFiles.clear();
      for (const p of allPages) {
        this.allKnownFiles.add(nameToFsPath(p.name));
      }
      this.knownFilesLoaded = true;
      this.client.ui.updatePageList(allPages);
    } catch (e) {
      console.warn("Could not fetch page list", e);
    }
  }
}
