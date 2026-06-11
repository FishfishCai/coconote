import { syntaxTree } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import type { ClientContext as Client } from "../../../../core/context.ts";
import {
  decoratorStateField,
  isCursorInRange,
} from "../../../util/util.ts";
import {
  findCalloutBounds,
  resolveTemplate,
} from "../../../../lib/callout.ts";
import { CalloutPrefixWidget, CalloutSuffixWidget } from "./widgets.ts";

export function calloutPlugin(_client: Client) {
  return decoratorStateField((state) => {
    const widgets: Range<Decoration>[] = [];
    // LaTeX-style shared counter: all numbered theorem-like callouts
    // count together.
    let sharedCounter = 0;

    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name !== "FencedDivOpener") return;

        let keyword = "";
        let label = "";
        let child = node.node.firstChild;
        while (child) {
          if (child.name === "FencedDivKeyword") {
            keyword = state.sliceDoc(child.from, child.to);
          } else if (child.name === "FencedDivLabel") {
            label = state.sliceDoc(child.from, child.to);
          }
          child = child.nextSibling;
        }

        const tpl = resolveTemplate(keyword);
        if (!tpl) return;
        const cssKey = tpl.cssClass ?? keyword.toLowerCase();
        const anchor = label;

        const openerLine = state.doc.lineAt(node.from);
        // Shared scan (lib/callout.ts): stops at end-of-doc or another
        // opener — both mean unclosed → bail without decorating.
        const bounds = findCalloutBounds(
          (n) => (n <= state.doc.lines ? state.doc.line(n) : null),
          openerLine.number,
        );
        if (!bounds) return;

        // Number AFTER the closer is found: an unclosed callout that
        // bailed above must not bump the shared counter, otherwise
        // every well-formed callout below it gets shifted by one.
        const number: number | null = tpl.numbered ? ++sharedCounter : null;

        const bodyLines: { from: number; to: number }[] = [];
        for (let n = openerLine.number + 1; n < bounds.closerLineNo; n++) {
          const ln = state.doc.line(n);
          bodyLines.push({ from: ln.from, to: ln.to });
        }

        const calloutTo = bounds.closerTo;
        const cursorInside = isCursorInRange(state, [openerLine.from, calloutTo]);

        // If body is empty AND closer will be hidden, opener becomes the
        // only visible row and carries both top and bottom borders.
        const openerIsLast = bodyLines.length === 0 && !cursorInside;
        widgets.push(
          Decoration.line({
            class: [
              "coconote-callout",
              `coconote-callout-${cssKey}`,
              "coconote-callout-head",
              "coconote-callout-first",
              openerIsLast ? "coconote-callout-last" : "",
            ].filter(Boolean).join(" "),
            attributes: anchor ? { "data-anchor": anchor } : undefined,
          }).range(openerLine.from),
        );
        if (tpl.title && !cursorInside) {
          widgets.push(
            Decoration.replace({
              widget: new CalloutPrefixWidget(
                tpl.title,
                number,
                cssKey,
                openerLine.from,
                label,
              ),
            }).range(openerLine.from, openerLine.to),
          );
        }

        // When cursor is outside, closer is hidden so body's last line
        // carries `coconote-callout-last` and the bottom border.
        bodyLines.forEach((ln, i) => {
          const isVisualLast =
            !cursorInside && i === bodyLines.length - 1;
          widgets.push(
            Decoration.line({
              class: [
                "coconote-callout",
                `coconote-callout-${cssKey}`,
                "coconote-callout-body",
                `coconote-callout-${cssKey}-body`,
                tpl.narrower ? "coconote-callout-narrower" : "",
                tpl.italic ? "coconote-callout-italic" : "",
                isVisualLast ? "coconote-callout-last" : "",
              ].filter(Boolean).join(" "),
            }).range(ln.from),
          );
        });

        const isProof = cssKey === "proof";
        if (!cursorInside) {
          // Hidden closer — no extra row between body's last line and the
          // next paragraph. Proof's ∎ floats at end of last body line.
          if (isProof && tpl.suffix && bodyLines.length > 0) {
            widgets.push(
              Decoration.widget({
                widget: new CalloutSuffixWidget(tpl.suffix, cssKey),
                side: 1,
              }).range(bodyLines[bodyLines.length - 1].to),
            );
          }
          widgets.push(
            Decoration.line({ class: "coconote-callout-closer-hidden" })
              .range(bounds.closerFrom),
          );
        } else {
          // Cursor inside → reveal closer so `:::` is editable. It also
          // carries the bottom border / padding for the frame.
          widgets.push(
            Decoration.line({
              class: [
                "coconote-callout",
                `coconote-callout-${cssKey}`,
                "coconote-callout-last",
                "coconote-callout-closer",
              ].join(" "),
            }).range(bounds.closerFrom),
          );
        }
      },
    });

    // `true` second arg sorts; no need for the manual pre-sort.
    return Decoration.set(widgets, true);
  });
}
