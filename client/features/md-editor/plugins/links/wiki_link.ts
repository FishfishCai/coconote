import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import {
  encodeRef,
  parseToRef,
  resolveCalloutDisplay,
} from "../../../../capabilities/links/index.ts";
import { resolveTitle, titleForId } from "../../../../capabilities/links/index.ts";
import { isInRefs } from "../../../../capabilities/links/index.ts";
import { extractFrontmatter } from "../../../../core/file";
import type { ClickEvent } from "coconote/type/client";
import type { EditorCtx } from "../../../../core/ctx/editor.ts";
import type { SpaceCtx } from "../../../../core/ctx/space.ts";
import type { UICtx } from "../../../../core/ctx/ui.ts";
import type { LifecycleCtx } from "../../../../core/ctx/lifecycle.ts";
type Client = EditorCtx & SpaceCtx & UICtx & LifecycleCtx;
import { decoratorStateField, isCursorInRange, LinkWidget } from "../../util/util.ts";
import { wikiLinkRegex } from "../../../../capabilities/markdown/index.ts";

// SPEC link states (title-based): missing = no known file has the title
// (red, not clickable); ambiguous-title = several files share the title
// with no tag/title to single one out (red, not clickable); not-in-refs =
// resolves to one file but isn't in this file's `refs` (not jumpable,
// gated); ok = resolvable + jumpable; invalid = unparseable.
type LinkStatus =
  | "missing"
  | "not-in-refs"
  | "ambiguous-title"
  | "default"
  | "invalid";

export function cleanWikiLinkPlugin(client: Client) {
  return decoratorStateField((state: EditorState) => {
    const widgets: Range<Decoration>[] = [];
    const allPages = client.ui.viewState.allPages;
    const refs = extractFrontmatter(state.sliceDoc(0, 4096)).refs;

    syntaxTree(state).iterate({
      enter: ({ type, from, to }) => {
        if (type.name !== "WikiLink") return;
        // Skip `![[..]]` - image transclusion owns that range. Parser
        // nests WikiLink inside Image starting at the `!` itself.
        if (state.sliceDoc(from, from + 1) === "!") return;
        const text = state.sliceDoc(from, to);
        wikiLinkRegex.lastIndex = 0;
        const match = wikiLinkRegex.exec(text);
        if (!match || !match.groups) return;

        const { leadingTrivia, stringRef, alias, trailingTrivia } =
          match.groups as Record<string, string>;
        const isExternal = /^https?:\/\//i.test(stringRef);
        const ref = isExternal ? null : parseToRef(stringRef);

        let linkStatus: LinkStatus = "default";
        let displayTitle: string | undefined;

        if (isExternal) {
          linkStatus = "default";
        } else if (!ref) {
          linkStatus = "invalid";
        } else if (ref.title === "") {
          // In-page jump (e.g. [[#heading]]) - always allowed.
          linkStatus = "default";
        } else {
          // SPEC: resolve the title to an id, then gate on this file's
          // refs. Red when missing / ambiguous; gated when resolved but
          // not in `refs`.
          const resolved = resolveTitle(ref.title, allPages);
          if (resolved.state === "missing") {
            linkStatus = "missing";
          } else if (resolved.state === "ambiguous") {
            linkStatus = "ambiguous-title";
          } else {
            // Resolves to exactly one file: show its CURRENT title. A
            // gated link (resolves but not in this file's refs) stays
            // muted and non-clickable, but still shows the resolved
            // title rather than the raw `tag/title`.
            displayTitle = titleForId(resolved.id, allPages);
            linkStatus = isInRefs(resolved.id, refs) ? "default" : "not-in-refs";
          }
        }

        const css = {
          "missing": "coconote-wiki-link-missing",
          "not-in-refs": "coconote-wiki-link-gated",
          "ambiguous-title":
            "coconote-wiki-link-missing coconote-wiki-link-ambiguous",
          "invalid": "coconote-wiki-link-invalid",
          "default": "",
        }[linkStatus];

        if (isCursorInRange(state, [from, to])) {
          if (linkStatus !== "default") {
            widgets.push(
              Decoration.mark({ class: css }).range(
                from + leadingTrivia.length,
                to - trailingTrivia.length,
              ),
            );
          }
          return;
        }

        // Display = alias, else the target's current title (SPEC: a chip
        // shows the target's title), else the raw ref.
        let linkText = alias || stringRef;
        if (!isExternal && ref) {
          if (!alias && ref.details?.type === "callout" && ref.title === "") {
            const display = resolveCalloutDisplay(
              state.sliceDoc(),
              ref.details.target,
            );
            linkText = display ?? encodeRef(ref);
          } else if (!alias && displayTitle) {
            linkText = displayTitle;
          } else {
            linkText = alias || encodeRef(ref);
          }
        }

        widgets.push(
          Decoration.replace({
            widget: new LinkWidget({
              text: linkText,
              stringRef,
              cssClass: `coconote-wiki-link ${css}`,
              from,
              callback: (e) => onClick(client, e, {
                stringRef, leadingTrivia, from, linkStatus,
              }),
            }),
          }).range(from, to),
        );
      },
    });
    return Decoration.set(widgets, true);
  });
}

function onClick(
  client: Client,
  e: MouseEvent,
  ctx: {
    stringRef: string;
    leadingTrivia: string;
    from: number;
    linkStatus: LinkStatus;
  },
) {
  if (e.altKey) {
    client.editorView.dispatch({
      selection: { anchor: ctx.from + ctx.leadingTrivia.length },
    });
    client.focus();
    return;
  }
  if (ctx.linkStatus === "missing") {
    console.error(`No file titled: ${ctx.stringRef}`);
    return;
  }
  if (ctx.linkStatus === "not-in-refs") {
    // Gated: resolves but not in this file's refs (not jumpable).
    return;
  }
  if (ctx.linkStatus === "ambiguous-title") {
    console.error(
      `Link "${ctx.stringRef}" is ambiguous - use tag/title to disambiguate`,
    );
    return;
  }
  if (ctx.linkStatus === "invalid") {
    console.error(`Invalid wiki link: ${ctx.stringRef}`);
    return;
  }
  const clickEvent: ClickEvent = {
    page: client.currentId(),
    altKey: e.altKey,
    pos: ctx.from,
  };
  client.onPageClick?.(clickEvent);
}
