// Native-selection quality fix for the pdf.js text layer, ported from
// pdf.js's viewer-level TextLayerBuilder (#bindMouse + the global
// selectionchange handler). coconote renders the text layer with the
// low-level `TextLayer` class, which paints the absolutely-positioned
// runs but does NOT bind this logic — so without it, dragging into a
// page's empty margin makes the browser greedily extend the selection
// to the end of the page (the "select '1 Motivation' → grab half the
// page" bug).
//
// The mechanism: each text layer gets an empty `.endOfContent` backstop.
// While selecting, it's repositioned in the DOM to sit immediately after
// the current selection anchor and stretched to fill the layer, so the
// nearest caret position for the empty area is right at the visible text
// boundary instead of the document end.
//
// We keep only the selection part — the viewer's copy/permissions and
// search-highlight handling are not relevant here.

const END_OF_CONTENT_CLASS = "coconote-pdf-end-of-content";
const TEXT_LAYER_CLASS = "coconote-pdf-text-layer";

// textLayerDiv → its endOfContent backstop. Drives both the per-layer
// reset and lifetime of the shared document listeners.
const textLayers = new Map<HTMLElement, HTMLElement>();
let globalListeners: AbortController | null = null;
let isFirefox: boolean | undefined;
let prevRange: Range | null = null;

/**
 * Wire up selection handling for one rendered text layer. Returns a
 * cleanup fn the caller runs when the page is released.
 */
export function attachTextLayerSelection(textLayerDiv: HTMLElement): () => void {
  const end = document.createElement("div");
  end.className = END_OF_CONTENT_CLASS;
  textLayerDiv.append(end);

  const onMouseDown = () => textLayerDiv.classList.add("selecting");
  textLayerDiv.addEventListener("mousedown", onMouseDown);

  textLayers.set(textLayerDiv, end);
  enableGlobalListeners();

  return () => {
    textLayerDiv.removeEventListener("mousedown", onMouseDown);
    textLayers.delete(textLayerDiv);
    end.remove();
    if (textLayers.size === 0) {
      globalListeners?.abort();
      globalListeners = null;
      prevRange = null;
    }
  };
}

function reset(end: HTMLElement, textLayer: HTMLElement) {
  textLayer.append(end);
  end.style.width = "";
  end.style.height = "";
  end.style.userSelect = "";
  textLayer.classList.remove("selecting");
}

function resetAll() {
  textLayers.forEach(reset);
}

function enableGlobalListeners() {
  if (globalListeners) return;
  globalListeners = new AbortController();
  const { signal } = globalListeners;

  let pointerDown = false;
  document.addEventListener("pointerdown", () => (pointerDown = true), { signal });
  document.addEventListener("pointerup", () => {
    pointerDown = false;
    resetAll();
  }, { signal });
  window.addEventListener("blur", () => {
    pointerDown = false;
    resetAll();
  }, { signal });
  document.addEventListener("keyup", () => {
    if (!pointerDown) resetAll();
  }, { signal });

  document.addEventListener("selectionchange", onSelectionChange, { signal });
}

function onSelectionChange() {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) {
    resetAll();
    return;
  }

  // Only the layers the selection actually touches keep the `selecting`
  // class; the rest reset (so a stale backstop in another page doesn't
  // linger).
  const active = new Set<HTMLElement>();
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    for (const layer of textLayers.keys()) {
      if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
    }
  }
  for (const [layer, end] of textLayers) {
    if (active.has(layer)) layer.classList.add("selecting");
    else reset(end, layer);
  }

  // Firefox's selection model doesn't need the backstop reposition (and
  // mis-detects the caret if we do it), so bail there. Detected via the
  // backstop's computed -moz-user-select: it's `none` (our CSS) only on
  // Gecko; on Chromium the property is unknown → "".
  const first = textLayers.values().next().value;
  if (first) {
    isFirefox ??=
      getComputedStyle(first).getPropertyValue("-moz-user-select") === "none";
  }
  if (isFirefox) return;

  const range = selection.getRangeAt(0);
  // Are we extending the selection's start (vs its end)? If the live
  // range shares an end boundary with the previous one, the user is
  // dragging the start; otherwise the end.
  const modifyStart = !!prevRange &&
    (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
      range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);

  let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
  if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;

  // endOffset 0 means the boundary sits at the very start of a node — the
  // real content is in the previous non-empty sibling. Walk back to it.
  if (!modifyStart && range.endOffset === 0 && anchor) {
    do {
      while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
      anchor = anchor?.previousSibling ?? null;
    } while (anchor && !anchor.childNodes.length);
  }

  const anchorEl = anchor as HTMLElement | null;
  const parentTextLayer = anchorEl?.parentElement?.closest(`.${TEXT_LAYER_CLASS}`) as
    | HTMLElement
    | null;
  const end = parentTextLayer ? textLayers.get(parentTextLayer) : undefined;
  if (parentTextLayer && end && anchorEl?.parentElement) {
    end.style.width = parentTextLayer.style.width;
    end.style.height = parentTextLayer.style.height;
    end.style.userSelect = "text";
    anchorEl.parentElement.insertBefore(
      end,
      modifyStart ? anchorEl : anchorEl.nextSibling,
    );
  }
  prevRange = range.cloneRange();
}
