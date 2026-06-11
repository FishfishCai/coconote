export type ParseTree = {
  type?: string; // undefined = text node
  from?: number;
  to?: number;
  text?: string;
  children?: ParseTree[];
  /** Only set after addParentPointers. */
  parent?: ParseTree;
};

export function addParentPointers(tree: ParseTree) {
  if (!tree.children) {
    return;
  }
  for (const child of tree.children) {
    child.parent = tree;
    addParentPointers(child);
  }
}

export function removeParentPointers(tree: ParseTree) {
  tree.parent = undefined;
  if (!tree.children) {
    return;
  }
  for (const child of tree.children) {
    removeParentPointers(child);
  }
}

export function findParentMatching(
  tree: ParseTree,
  matchFn: (tree: ParseTree) => boolean,
): ParseTree | null {
  let node = tree.parent;
  while (node) {
    if (matchFn(node)) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

export function findNodeMatching(
  tree: ParseTree,
  matchFn: (tree: ParseTree) => boolean,
): ParseTree | null {
  if (matchFn(tree)) {
    return tree;
  }
  if (tree.children) {
    for (const child of tree.children) {
      const result = findNodeMatching(child, matchFn);
      if (result) {
        return result;
      }
    }
  }
  return null;
}

export function findNodeOfType(
  tree: ParseTree,
  nodeType: string,
): ParseTree | null {
  if (tree.type === nodeType) {
    return tree;
  }
  if (tree.children) {
    for (const child of tree.children) {
      const result = findNodeOfType(child, nodeType);
      if (result) {
        return result;
      }
    }
  }
  return null;
}

export function traverseTree(
  tree: ParseTree,
  // Return true to stop traversal into children.
  matchFn: (tree: ParseTree) => boolean,
  // Log visitor errors but keep traversing.
  catchVisitorErrors = false,
): void {
  let stop = false;
  if (catchVisitorErrors) {
    try {
      stop = matchFn(tree);
    } catch (e: unknown) {
      const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error(
        `traverseTree visitor failed at node ${tree.type}@${tree.from}:`,
        detail,
      );
      return;
    }
  } else {
    stop = matchFn(tree);
  }
  if (stop) {
    return;
  }
  if (tree.children) {
    for (const child of tree.children) {
      traverseTree(child, matchFn, catchVisitorErrors);
    }
  }
}

export function nodeAtPos(tree: ParseTree, pos: number): ParseTree | null {
  if (pos < tree.from! || pos >= tree.to!) {
    return null;
  }
  if (!tree.children) {
    return tree;
  }
  for (const child of tree.children) {
    const n = nodeAtPos(child, pos);
    if (n && n.text !== undefined) {
      // text node — return its parent (caller wants non-text)
      return tree;
    }
    if (n) {
      return n;
    }
  }
  return null;
}

export function renderToText(tree?: ParseTree): string {
  if (!tree) {
    return "";
  }
  if (tree.text !== undefined) {
    return tree.text;
  }
  const children = tree.children!;
  if (children.length === 1) {
    return renderToText(children[0]);
  }
  let result = "";
  for (const child of children) {
    result += renderToText(child);
  }
  return result;
}

