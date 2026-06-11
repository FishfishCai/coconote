import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { basename } from "../../../lib/path_url.ts";
import {
  encodeRef,
  parseToRef,
  resolveCalloutDisplay,
} from "coconote/lib/ref";
import { resolveWikiLink } from "../../../lib/wikilink.ts";
import type { ClickEvent } from "coconote/type/client";
import type { ClientContext as Client } from "../../../core/context.ts";
import { decoratorStateField, isCursorInRange, LinkWidget } from "../../util/util.ts";
import { wikiLinkRegex } from "../../../markdown/parser/constants.ts";

type LinkStatus = "file-missing" | "ambiguous" | "default" | "invalid";

export function cleanWikiLinkPlugin(client: Client) {
  return decoratorStateField((state: EditorState) => {
    const widgets: Range<Decoration>[] = [];
    const shortWikiLinks = client.config.get("shortWikiLinks", true);

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
        let ambiguousCandidates: string[] | undefined;

        if (isExternal) {
          linkStatus = "default";
        } else if (!ref) {
          linkStatus = "invalid";
        } else if (ref.path === "") {
          linkStatus = "default";
        } else {
          // New resolver supports 4 locator forms: [[name]] / [[path/name]] /
          // [[tag/name]] / [[path/title]] etc. filename wins over title
          // (wikilink.md), tag wins over path. See client/lib/wikilink.ts.
          const query = ref.path.endsWith(".md")
            ? ref.path.slice(0, -3)
            : ref.path;
          const result = resolveWikiLink(
            query,
            client.ui.viewState.allPages,
          );
          if (result.kind === "ok") {
            ref.path = (result.page.name + ".md") as typeof ref.path;
            linkStatus = "default";
          } else if (result.kind === "ambiguous") {
            linkStatus = "ambiguous";
            ambiguousCandidates = result.pages.map((p) => p.name);
          } else {
            linkStatus = "file-missing";
          }
        }

        const css = {
          "file-missing": "coconote-wiki-link-missing",
          ambiguous: "coconote-wiki-link-missing coconote-wiki-link-ambiguous",
          invalid: "coconote-wiki-link-invalid",
          default: "",
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

        let linkText = alias || stringRef;
        if (linkStatus === "default" && !isExternal && ref) {
          // Shallow copy is enough: only `path` is reassigned below and
          // `details` is never mutated.
          const renderedRef = { ...ref };
          if (ref.details) renderedRef.details = { ...ref.details };
          renderedRef.path = shortWikiLinks
            ? basename(renderedRef.path) as typeof renderedRef.path
            : renderedRef.path;
          // Callout `:target` -> resolve to the title-widget form so the
          // chip reads naturally. Only resolvable inside the current
          // file's text, cross-file refs fall back to raw encoded form.
          if (!alias && ref.details?.type === "callout" && ref.path === "") {
            const display = resolveCalloutDisplay(
              state.sliceDoc(),
              ref.details.target,
            );
            if (display) linkText = display;
            else linkText = encodeRef(renderedRef);
          } else {
            linkText = alias || encodeRef(renderedRef);
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
                ambiguousCandidates,
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
    ambiguousCandidates?: string[];
  },
) {
  if (e.altKey) {
    client.editorView.dispatch({
      selection: { anchor: ctx.from + ctx.leadingTrivia.length },
    });
    client.focus();
    return;
  }
  if (ctx.linkStatus === "file-missing") {
    console.error(`No file: ${ctx.stringRef}`);
    return;
  }
  if (ctx.linkStatus === "ambiguous") {
    console.error(
      `Multiple files match "${ctx.stringRef}": ${
        (ctx.ambiguousCandidates ?? []).join(", ")
      } - write the full path`,
    );
    return;
  }
  if (ctx.linkStatus === "invalid") {
    console.error(`Invalid wiki link: ${ctx.stringRef}`);
    return;
  }
  const clickEvent: ClickEvent = {
    page: client.currentName(),
    altKey: e.altKey,
    newTab: e.metaKey || e.ctrlKey,
    pos: ctx.from,
  };
  client.onPageClick?.(clickEvent);
}
