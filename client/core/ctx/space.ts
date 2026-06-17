// SpaceCtx: the vault-access surface (the space primitives, the known-file
// set, the content manager, and page-list refresh).

import type { Space } from "../space.ts";
import type { ContentManager } from "../content_manager.ts";
import type { HttpSpacePrimitives } from "../../spaces/http_space_primitives.ts";

export interface SpaceCtx {
  space: Space;
  httpSpacePrimitives: HttpSpacePrimitives;
  readonly allKnownFiles: ReadonlySet<string>;
  knownFilesLoaded: boolean;
  contentManager: ContentManager;
  reloadEditor(): Promise<void> | void;
  /** Re-fetch the local + remote page list and broadcast it through
   *  `ui.updatePageList`. Cheap (~1 HTTP round trip). Call after any
   *  mutation the content browser should reflect. */
  updatePageListCache(): Promise<void>;
}
