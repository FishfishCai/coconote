// Build an HttpSpacePrimitives pointed at a remote Coconote instance for
// push / pull. Remotes are addressed by id (`?id=`): the same id is the
// same file across instances. The base URL comes from the config `url`
// list.

import { fsEndpoint, HttpSpacePrimitives } from "../../core/transport";

export function makeRemoteSpace(
  url: string,
  token?: string,
): HttpSpacePrimitives {
  const base = url.replace(/\/+$/, "") + fsEndpoint;
  return new HttpSpacePrimitives(base, () => {/* remote auth is per-call */}, token);
}
