# Markdown

The markdown syntax Coconote renders.

## Headings

Four levels of headings.

```markdown
# H1
## H2
### H3
#### H4
```

## Inline Marks

Four inline marks:
- `**bold**` (also `__bold__`)
- `*italic*` (also `_italic_`)
- `~~strike~~`
- `==highlight==`

Bold, italic, and strike nest in any order, with either marker spelling:
- `***bold italic***`
- `**~~bold strike~~**`
- `~~_strike italic_~~`

Highlight cannot be combined with the other three inline marks.

Backslash escapes a marker so it renders literally:
- `\*not italic\*`

## Lists

Unordered lists use `-`, ordered lists use `1.`. Indent a sub-item by four
spaces. Each level cycles a marker: unordered `• ◦ ▪ ‣`, ordered
`1. a. i. A.`. An ordered item keeps the number you type, restyled to its
level's marker.

```markdown
- one
    - two
        - three
            - four

1. first
    1. second
        1. third
            1. fourth
```

## Table

A table uses GFM pipe syntax: a header row, a delimiter row of dashes, then
body rows. Colons in the delimiter row set column alignment: `:---` left,
`:---:` center, `---:` right.

```markdown
| Name | Score |
| :--- | ---: |
| Ada  | 100  |
| Bob  | 42   |
```

## Quote Block

A quote block uses `>`. Only the first `>` on each line acts as the quote
marker, any further `>` on the line renders as plain text.

```markdown
> outer
> > nested
> > > deepest
```

## Horizontal Rule

A horizontal rule uses three or more `-`, `*`, or `_`.

```markdown
---
***
___
```

## Code

Inline code is wrapped in a single `` ` ``. Block code is wrapped in three or
more ` ``` `.

Inline:
- `` `code` ``

If the code itself contains a backtick, use more backticks for the fence:
``` `` `inner` `` ```.

Block:
A language tag after the opening fence enables syntax highlighting. Supported
tags: `yaml`, `json`, `javascript`/`js`, `typescript`/`ts`, `python`/`py`,
`rust`/`rs`, `c`, `cpp`/`c++`, `java`, `csharp`/`cs`, `go`/`golang`,
`sh`/`bash`/`zsh`/`fish`, `sql`, `css`, `xml`, `swift`, `kotlin`, `scala`,
`dart`, `ruby`, `perl`, `r`, `toml`, `protobuf`, `diff`, `powershell`,
`dockerfile`, `cmake`, `nix`.

````markdown
```python
def hello(name):
    return f"hi, {name}"
```
````

No language tag:

````markdown
```
plain block
multiple lines kept verbatim
```
````

## Math

Inline math is wrapped in a single `$`. Block math is wrapped in `$$`.

Inline:
- `$\sum_{i=1}^n i = \tfrac{n(n+1)}{2}$`

Block:
```markdown
$$
\int_0^\infty e^{-x}\,dx = 1
$$
```

## Callout

A callout opens with `::: keyword`, optionally `::: keyword:label`, and closes
with a line of three or more colons. The `:label` shows in the title as
`(label)`. Twelve kinds: `definition`, `theorem`, `proposition`, `lemma`,
`corollary`, `example`, `proof`, `remark`, `note`, `warning`, `tip`, `info`.
The first six (`definition` through `example`) share one counter numbering them
in order of appearance. `theorem`, `proposition`, `lemma`, `corollary`, and
`proof` render their body in italic, the rest upright. `proof` ends with `∎`.

One example per behavior (the other keywords look like one of these):

```markdown
::: definition
Body of a counter callout, upright.
:::

::: theorem
Body of a counter callout, italic.
:::

::: proof
Body of a proof, italic, ending in a tombstone.
:::

::: note
Body of a plain callout (also remark, warning, tip, info).
:::
```

With a label:

```markdown
::: definition:label
Body of a definition.
:::
```

## Image

Image uses `![[filename|alt|size|alignment]]`. Alignment supports `left`,
`center`, and `right`.

Local images must live in the file's `.<name>.assets/` folder, where `<name>`
is the filename without `.md` (see the file guide).

```markdown
![[test.png|sample|120x60|center]]
```

Online image:

```markdown
![[https://placehold.co/200x100/png|placeholder|120x60|center]]
```
