import { yaml as yamlLanguage } from "@codemirror/legacy-modes/mode/yaml";
import { styleTags, tags as t } from "@lezer/highlight";
import {
  type Element,
  type Line,
  type MarkdownConfig,
  Strikethrough,
} from "@lezer/markdown";
import { markdown } from "@codemirror/lang-markdown";
import { foldNodeProp, StreamLanguage } from "@codemirror/language";
import * as ct from "./customtags.ts";
import {
  ANCHOR_NAME_RE,
  nakedUrlRegex,
  pWikiLinkRegex,
} from "./constants.ts";
import { CALLOUT_OPEN_RE } from "../../lib/callout.ts";

const namedAnchorRegex = new RegExp(`^@(${ANCHOR_NAME_RE.source})`);
import { parse } from "./parse_tree.ts";
import type { ParseTree } from "coconote/lib/tree";

const ALIAS_SEGMENT_NAMES = [
  "WikiLinkAlias",
  "WikiLinkDimensions",
  "WikiLinkAlign",
];
const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: "WikiLink" },
    { name: "WikiLinkPage", style: ct.WikiLinkPartTag },
    { name: "WikiLinkAlias", style: ct.WikiLinkPartTag },
    { name: "WikiLinkDimensions", style: ct.WikiLinkPartTag },
    { name: "WikiLinkAlign", style: ct.WikiLinkPartTag },
    { name: "WikiLinkMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "WikiLink",
      parse(cx, next, pos) {
        if (next !== 91 /* '[' */ && next !== 33 /* '!' */) return -1;

        pWikiLinkRegex.lastIndex = 0;
        const match = pWikiLinkRegex.exec(cx.slice(pos, cx.end));
        if (!match || !match.groups) return -1;

        const { leadingTrivia, stringRef, alias } = match.groups;
        const endPos = pos + match[0].length;
        const aliasElts: Element[] = [];
        if (alias !== undefined) {
          let segPos = pos + leadingTrivia.length + stringRef.length;
          const segments = alias.split("|");
          for (let i = 0; i < segments.length; i++) {
            aliasElts.push(cx.elt("WikiLinkMark", segPos, segPos + 1));
            segPos += 1;
            const segName = ALIAS_SEGMENT_NAMES[i] ?? "WikiLinkAlias";
            aliasElts.push(
              cx.elt(segName, segPos, segPos + segments[i].length),
            );
            segPos += segments[i].length;
          }
        }

        let allElts = cx.elt("WikiLink", pos, endPos, [
          cx.elt("WikiLinkMark", pos, pos + leadingTrivia.length),
          cx.elt(
            "WikiLinkPage",
            pos + leadingTrivia.length,
            pos + leadingTrivia.length + stringRef.length,
          ),
          ...aliasElts,
          cx.elt("WikiLinkMark", endPos - 2, endPos),
        ]);

        if (next === 33) {
          allElts = cx.elt("Image", pos, endPos, [allElts]);
        }

        return cx.addElement(allElts);
      },
      after: "Emphasis",
    },
  ],
};

// Content is opaque: returning only the two HighlightMark children consumes
// the range so lezer-markdown won't re-scan inline parsers inside it.
const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: ct.Highlight },
    { name: "HighlightMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== 61 /* '=' */) return -1;
        if (cx.char(pos + 1) !== 61) return -1;
        if (cx.char(pos + 2) === 61) return -1; // `===` is setext underline
        const slice = cx.slice(pos + 2, cx.end);
        const m = /^([^\n=]+?)==(?!=)/.exec(slice);
        if (!m) return -1;
        const endPos = pos + 2 + m[1].length + 2;
        return cx.addElement(
          cx.elt("Highlight", pos, endPos, [
            cx.elt("HighlightMark", pos, pos + 2),
            cx.elt("HighlightMark", endPos - 2, endPos),
          ]),
        );
      },
      after: "Emphasis",
    },
  ],
};

// Opaque to markdown so emphasis / strikethrough inside a formula stay literal.
const MathConfig: MarkdownConfig = {
  defineNodes: [
    { name: "Math" },
    { name: "MathMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "Math",
      parse(cx, next, pos) {
        if (next !== 36 /* '$' */) return -1;
        const slice = cx.slice(pos, cx.end);
        if (cx.char(pos + 1) === 36) {
          const m = /^\$\$([\s\S]+?)\$\$/.exec(slice);
          if (!m) return -1;
          const endPos = pos + m[0].length;
          return cx.addElement(cx.elt("Math", pos, endPos, [
            cx.elt("MathMark", pos, pos + 2),
            cx.elt("MathMark", endPos - 2, endPos),
          ]));
        }
        // `\$` literal dollar must not open math.
        if (pos > 0 && cx.char(pos - 1) === 92 /* '\\' */) return -1;
        const m = /^\$([^$\n]+?)\$(?!\$)/.exec(slice);
        if (!m) return -1;
        const endPos = pos + m[0].length;
        return cx.addElement(cx.elt("Math", pos, endPos, [
          cx.elt("MathMark", pos, pos + 1),
          cx.elt("MathMark", endPos - 1, endPos),
        ]));
      },
      before: "Emphasis",
    },
  ],
};

// `@` sigil chosen over `$` so math `$..$` doesn't collide with a stray anchor.
const NamedAnchor: MarkdownConfig = {
  defineNodes: [
    { name: "NamedAnchor", style: ct.NamedAnchorTag },
    { name: "NamedAnchorMark", style: ct.NamedAnchorMarkTag },
  ],
  parseInline: [
    {
      name: "NamedAnchor",
      parse(cx, next, pos) {
        if (next !== 64 /* '@' */) return -1;
        const m = namedAnchorRegex.exec(cx.slice(pos, cx.end));
        if (!m) return -1;
        const endPos = pos + m[0].length;
        return cx.addElement(cx.elt("NamedAnchor", pos, endPos, [
          cx.elt("NamedAnchorMark", pos, pos + 1),
        ]));
      },
      before: "Emphasis",
    },
  ],
};

const nakedUrlAnchored = new RegExp(`^${nakedUrlRegex.source}`);
const NakedURL: MarkdownConfig = {
  defineNodes: ["NakedURL"],
  parseInline: [
    {
      name: "NakedURL",
      parse(cx, next, pos) {
        if (next !== 104 /* 'h' */) return -1;
        const m = nakedUrlAnchored.exec(cx.slice(pos, cx.end));
        if (!m) return -1;
        return cx.addElement(cx.elt("NakedURL", pos, pos + m[0].length));
      },
    },
  ],
};

const yamlLang = StreamLanguage.define(yamlLanguage);
const FrontMatter: MarkdownConfig = {
  defineNodes: [
    { name: "FrontMatter", block: true },
    { name: "FrontMatterMarker" },
    { name: "FrontMatterCode" },
  ],
  parseBlock: [
    {
      name: "FrontMatter",
      parse: (cx, line: Line) => {
        if (cx.parsedPos !== 0) return false;
        if (line.text !== "---") return false;
        const frontStart = cx.parsedPos;
        const elts = [
          cx.elt(
            "FrontMatterMarker",
            cx.parsedPos,
            cx.parsedPos + line.text.length + 1,
          ),
        ];
        cx.nextLine();
        const startPos = cx.parsedPos;
        let endPos = startPos;
        let text = "";
        let lastPos = cx.parsedPos;
        do {
          text += `${line.text}\n`;
          endPos += line.text.length + 1;
          cx.nextLine();
          if (cx.parsedPos === lastPos) return false; // EOF without closer
          lastPos = cx.parsedPos;
        } while (line.text !== "---");
        const yamlTree = yamlLang.parser.parse(text);
        elts.push(
          cx.elt("FrontMatterCode", startPos, endPos, [
            cx.elt(yamlTree, startPos),
          ]),
        );
        endPos = cx.parsedPos + line.text.length;
        elts.push(
          cx.elt(
            "FrontMatterMarker",
            cx.parsedPos,
            cx.parsedPos + line.text.length,
          ),
        );
        cx.nextLine();
        cx.addElement(cx.elt("FrontMatter", frontStart, endPos, elts));
        return true;
      },
      before: "HorizontalRule",
    },
  ],
};

// Only opener tokens are tagged - body and closer flow through default block
// parsing so inline math, wiki links, lists etc. still render inside.
const FencedDiv: MarkdownConfig = {
  defineNodes: [
    { name: "FencedDivOpener", block: true },
    { name: "FencedDivMark", style: t.processingInstruction },
    { name: "FencedDivKeyword", style: t.keyword },
    // Unstyled: `:label` should look like plain text in source view.
    { name: "FencedDivLabel" },
    { name: "FencedDivLabelSep" },
  ],
  parseBlock: [
    {
      name: "FencedDivOpener",
      parse(cx, line) {
        const m = CALLOUT_OPEN_RE.exec(line.text);
        if (!m) return false;
        const fenceLen = m[1].length;
        const lineStart = cx.lineStart;
        const children = [
          cx.elt("FencedDivMark", lineStart, lineStart + fenceLen),
        ];
        const kwStart = lineStart + line.text.indexOf(m[2]);
        children.push(
          cx.elt("FencedDivKeyword", kwStart, kwStart + m[2].length),
        );
        if (m[3]) {
          const kwEnd = kwStart + m[2].length;
          const sepIdx = line.text.indexOf(":", kwEnd - lineStart) + lineStart;
          // Spaces may surround the colon (`::: def : label`), so anchor
          // on the captured label text itself, not `sepIdx + 1`.
          const labelStart = lineStart +
            line.text.indexOf(m[3], kwEnd - lineStart);
          children.push(cx.elt("FencedDivLabelSep", sepIdx, sepIdx + 1));
          children.push(
            cx.elt("FencedDivLabel", labelStart, labelStart + m[3].length),
          );
        }
        cx.addElement(
          cx.elt(
            "FencedDivOpener",
            lineStart,
            lineStart + line.text.length,
            children,
          ),
        );
        cx.nextLine();
        return true;
      },
      before: "HorizontalRule",
    },
  ],
};

const baseMarkdownExtensions: MarkdownConfig[] = [
  FrontMatter,
  WikiLink,
  MathConfig,
  Highlight,
  NamedAnchor,
  NakedURL,
  FencedDiv,
  Strikethrough,
  {
    props: [
      foldNodeProp.add({
        BulletList: () => null,
        OrderedList: () => null,
        ListItem: (tree, state) => ({
          from: state.doc.lineAt(tree.from).to,
          to: tree.to,
        }),
        FrontMatter: (tree) => ({ from: tree.from, to: tree.to }),
      }),
      styleTags({
        Comment: ct.CommentTag,
        "StrikethroughMark": t.processingInstruction,
        CodeInfo: ct.CodeInfoTag,
        HorizontalRule: ct.HorizontalRuleTag,
        NakedURL: ct.NakedURLTag,
        // `[..]`/`[..](..)` are not navigable here - brackets render as plain text.
        LinkMark: t.content,
      }),
    ],
  },
];

const extendedMarkdownLanguage = markdown({
  extensions: baseMarkdownExtensions,
}).language;

export function buildExtendedMarkdownLanguage() {
  return extendedMarkdownLanguage;
}

export function parseMarkdown(text: string, offset?: number): ParseTree {
  return parse(extendedMarkdownLanguage, text, offset);
}
