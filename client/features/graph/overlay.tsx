// The relation graph (Cmd/Ctrl+Shift+G): a recursive ego-graph from the
// current file along `refs` (out) and `backrefs` (in), force-directed.
// Edges point referrer -> referenced. Clicking a node opens that file.
// Wraps the shared SVG renderer (force_graph.tsx); physics in
// lib/graph_layout.ts.

import { useMemo } from "preact/hooks";
import type { UICtx as Client } from "../../core/ctx/ui.ts";
import type { NavigationCtx } from "../../core/ctx/navigation.ts";
import type { PageMeta } from "coconote/type/page";
import { Modal } from "../../core/ui";
import {
  bucketColor,
  ForceGraphSvg,
  type NodeStyle,
  tagBucket,
} from "./force_graph.tsx";
import { buildGraph, type Node } from "./layout.ts";

type Props = {
  client: Client & NavigationCtx;
  /** Id of the current file (graph root). */
  startId: string;
  onClose: () => void;
};

const PARAMS = { attract: 0.02, repulse: 1200 };

export function GraphOverlay({ client, startId, onClose }: Props) {
  const allPages = client.ui.viewState.allPages;
  const { nodes, edges } = useMemo(
    () => buildGraph(startId, allPages),
    [startId, allPages],
  );

  const styleOf = (n: Node<PageMeta>): NodeStyle => ({
    color: bucketColor(tagBucket(n.page.tags, 1)),
  });
  const labelOf = (n: Node<PageMeta>) => n.page.title || n.page.id;
  const radiusOf = (n: Node<PageMeta>) => (n.page.id === startId ? 9 : 7);

  const onActivate = (n: Node<PageMeta>) => {
    onClose();
    void client.navigate({ id: n.page.id, title: n.page.title });
  };

  return (
    <Modal title="Relation graph" size="wide" onClose={onClose}>
      <div class="coconote-cb-graph">
        {nodes.length === 0
          ? (
            <div class="coconote-cb-graph-empty">
              No references from this file.
            </div>
          )
          : (
            <ForceGraphSvg
              nodes={nodes}
              edges={edges}
              params={PARAMS}
              styleOf={styleOf}
              labelOf={labelOf}
              radiusOf={radiusOf}
              onActivate={onActivate}
            />
          )}
      </div>
    </Modal>
  );
}
