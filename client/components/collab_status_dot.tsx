import { useEffect, useState } from "preact/hooks";
import type {
  CollabUiStatus,
  EditorCtx as Client,
} from "../core/ctx/editor.ts";

// Live collab WS state dot (editor.md Collaboration: "green / yellow").
// The short interval re-bind covers loadPage swapping in a new handle.
export function CollabStatusDot({ client }: { client: Client }) {
  const [status, setStatus] = useState<CollabUiStatus>("connecting");
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let currentHandle: unknown = null;
    const bind = () => {
      const h = client.collabHandle;
      if (h === currentHandle) return;
      unsub?.();
      currentHandle = h;
      if (!h) {
        setStatus("disposed");
        unsub = undefined;
        return;
      }
      setStatus(h.status());
      unsub = h.onStatusChange(setStatus);
    };
    bind();
    const id = window.setInterval(bind, 500);
    return () => {
      unsub?.();
      window.clearInterval(id);
    };
  }, [client]);
  const title = status === "connected"
    ? "Collab: connected"
    : status === "disposed"
    ? "Collab: off"
    : "Collab: reconnecting…";
  return (
    <span
      className={`coconote-collab-status coconote-collab-status-${status}`}
      title={title}
      aria-label={title}
    />
  );
}
