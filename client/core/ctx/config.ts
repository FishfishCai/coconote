// ConfigCtx: read-only access to the appearance/behavior config.

import type { Config } from "../config.ts";

export interface ConfigCtx {
  readonly config: Config;
}
