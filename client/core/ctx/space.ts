// SpaceCtx: the vault-access surface (the space primitives, the known-file
// set, the content manager, and page-list refresh).

import type { Space } from "../../shell/space.ts";
import type { ContentManager } from "../../shell/content_manager.ts";
import type { HttpSpacePrimitives } from "../transport";

export interface SpaceCtx {
  space: Space;
  httpSpacePrimitives: HttpSpacePrimitives;
  readonly allKnownFiles: ReadonlySet<string>;
  knownFilesLoaded: boolean;
  contentManager: ContentManager;
  /** Rebuild the known-page index (the closure of recent U pin over each
   *  file's frontmatter refs/backrefs) and broadcast it through
   *  `ui.updatePageList`. Call after any mutation the recent list / graph
   *  should reflect. */
  updatePageListCache(): Promise<void>;
}
