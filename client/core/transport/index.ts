// The server API client: the HttpSpacePrimitives /.file read/write/resolve/
// ping client, the /.file and /.history URL builders, and the auth-token
// injecting fetch wrapper for code paths outside HttpSpacePrimitives.

export {
  HttpSpacePrimitives,
  isStaleWriteError,
} from "./http_space_primitives.ts";
export type {
  FileAddr,
  SaveType,
  StaleWriteError,
} from "./http_space_primitives.ts";
export {
  absFsBase,
  assetUrl,
  fileUrl,
  fsEndpoint,
  historyUrl,
} from "./constants.ts";
export { authedFetch, getAuthToken, setAuthToken } from "./authed_fetch.ts";
