---
id: epyy46tzr2rrb0am
coconote: true
title: markdown
---

# Markdown

The markdown editor supports the following basic features.

## Headings
Four levels of headings.

```markdown
# H1
## H2
### H3
#### H4
```

# H1
## H2
### H3
#### H4

## Inline Marks

Four inline marks:
- `**bold**`: **bold** (also `__bold__`: __bold__)
- `*italic*`: *italic* (also `_italic_`: _italic_)
- `~~strike~~`: ~~strike~~
- `==highlight==`: ==highlight==

Bold, italic and strike can be combined in any order:
- `***bold italic***`: ***bold italic***
- `**_bold italic_**`: **_bold italic_**
- `**~~bold strike~~**`: **~~bold strike~~**
- `__*bold italic*__`: __*bold italic*__
- `___bold italic___`: ___bold italic___
- `__~~bold strike~~__`: __~~bold strike~~__
- `*__italic bold__*`: *__italic bold__*
- `*~~italic strike~~*`: *~~italic strike~~*
- `_**italic bold**_`: _**italic bold**_
- `_~~italic strike~~_`: _~~italic strike~~_
- `~~**strike bold**~~`: ~~**strike bold**~~
* `~~__strike bold__~~`: ~~__strike bold__~~
* `~~*strike italic*~~`: ~~*strike italic*~~
* `~~_strike italic_~~`: ~~_strike italic_~~

Highlight cannot be combined with the other three inline marks.

Backslash escapes a marker so it renders literally:
- `\*not italic\*`: \*not italic\*.

## Lists

Unordered uses `-`; ordered uses `1.`. Nesting = 4 spaces. Unordered counter cycles `• ◦ ▪ ‣`; ordered counter cycles `1. a. i. A.`.

```markdown
- one
    - two
        - three
            - four

1. first
   2. second
       3. third
           4. fourth
```

- one
    - two
        - three
            - four

1. first
   1. second
       2. third
           3. fourth

## Quote Block

A quote block uses `>`. Only the first `>` on each line is rendered. Click a quote block to reveal all of its `>` markers.

```markdown
> outer
> > nested
> > > deepest
```

> outer
> > nested
> > > deepest

## Horizontal Rule

A horizontal rule uses three or more `-`, `*`, or `_`.

```markdown
---
***
___
```

---
***
___

## Code

Inline code is wrapped in a single `` ` ``; block code is wrapped in triple ` ``` `.

Inline:
- `` `code` ``: `code`

If the code itself contains a backtick, use more backticks for the fence: ``` `` `inner` `` ```: `` `inner` ``.

Block:
Code block opens with three+ backticks. The language tag enables syntax highlighting. Currently supported: `yaml`, `json`, `javascript`/`js`, `typescript`/`ts`, `python`/`py`, `rust`/`rs`, `c`, `cpp`/`c++`, `java`, `csharp`/`cs`, `go`/`golang`, `sh`/`bash`/`zsh`/`fish`, `sql`, `css`, `xml`, `swift`, `kotlin`, `scala`, `dart`, `ruby`, `perl`, `r`, `toml`, `protobuf`, `diff`, `powershell`, `dockerfile`, `cmake`, `nix`.

````markdown
```python
def hello(name):
    return f"hi, {name}"
```
````

```python
def hello(name):
    return f"hi, {name}"
```

No language tag:

````markdown
```
plain block
multiple lines kept verbatim
```
````

```
plain block
multiple lines kept verbatim
```

## Math

Inline math is wrapped in a single `$`; block math is wrapped in `$$`.

Inline:
- `$\sum_{i=1}^n i = \tfrac{n(n+1)}{2}$`: $\sum_{i=1}^n i = \tfrac{n(n+1)}{2}$

Block:
```markdown
$$
\int_0^\infty e^{-x}\,dx = 1
$$
```

$$
\int_0^\infty e^{-x}\,dx = 1
$$

## Callout

Callout begins with `::: keyword[:label]` and closes with `:::` or more than 4 colons. The `:label` after the keyword shows in the title chip as `(label)`. Twelve kinds of callouts: `definition`, `theorem`, `proposition`, `lemma`, `corollary`, `example`, `proof`, `remark`, `note`, `warning`, `tip`, `info`. `definition`, `theorem`, `proposition`, `lemma`, `corollary`, `example` share one auto-incrementing counter. `theorem`, `proposition`, `lemma`, `corollary`, `proof` render their body in italic; the rest stay upright. `proof` ends with `∎`.

Examples:

::: definition
Body of a definition.
:::

::: theorem
Body of a theorem.
:::

::: proposition
Body of a proposition.
:::

::: lemma
Body of a lemma.
:::

::: corollary
Body of a corollary.
:::

::: example
Body of an example.
:::

::: proof
Body of a proof.
:::

::: remark
Body of a remark.
:::

::: note
Body of a note.
:::

::: warning
Body of a warning.
:::

::: tip
Body of a tip.
:::

::: info
Body of an info.
:::

Callout with label:

::: definition:label
Body of a definition.
:::

## Image

Image uses `![[filename|alt|size|alignment]]`. Alignment supports `left`, `center`, and `right`.

Local images must live in the file's accompanying `.<name>.assets/` folder (basename without the `.md` extension; see [[file]]).

![[test.png|sample|120x60|center]]

Online image:

![[https://placehold.co/200x100/png|placeholder|120x60|center]]

