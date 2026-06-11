// Markdown BODY scanning: headings and wikilink targets for the
// GET /.file listing. Frontmatter parsing and id injection live in
// frontmatter.rs, this module only reads past the frontmatter block.

/// Heading / wikilink scans look at the first 64 KB of a body.
pub const BODY_SCAN_LIMIT: usize = 64 * 1024;

/// Index of the first body line after a leading `---` frontmatter block
/// (0 when there is none). Shared by the heading / wikilink scanners.
fn frontmatter_end_line(lines: &[&str]) -> usize {
    if lines.first().map(|l| l.trim()) == Some("---") {
        if let Some(close) = lines.iter().skip(1).position(|l| l.trim() == "---") {
            return (close + 2).min(lines.len());
        }
    }
    0
}

/// H1-H4 heading texts from the first 64 KB of `doc`. Skips frontmatter
/// and code-fence ranges so `# in code` isn't reported. Used by GET
/// /.file so filter expressions can match "headings inside files"
/// (content.md).
pub fn scan_headings(doc: &[u8]) -> Vec<String> {
    let head = &doc[..doc.len().min(BODY_SCAN_LIMIT)];
    let body = match std::str::from_utf8(head) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let lines: Vec<&str> = body.lines().collect();
    let start = frontmatter_end_line(&lines);

    let mut in_fence = false;
    let mut out = Vec::new();
    for line in &lines[start..] {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let mut chars = trimmed.chars();
        let mut hashes = 0;
        while chars.next() == Some('#') {
            hashes += 1;
            if hashes > 4 {
                break;
            }
        }
        // markdown.md: only H1-H4 are in the spec. Reject #####/######
        // here too, the editor render path already drops them.
        if hashes < 1 || hashes > 4 {
            continue;
        }
        let rest = trimmed[hashes..].trim_start();
        // Need at least one space between #'s and text per ATX rules.
        if !trimmed[hashes..].starts_with(' ') {
            continue;
        }
        let text = rest.trim().to_string();
        if text.is_empty() {
            continue;
        }
        out.push(text);
    }
    out
}

/// Raw `[[wikilink]]` targets from the first 64 KB of `doc`, verbatim
/// (resolution happens client-side via `resolveWikiLink`). Used by GET
/// /.file so the Graph view can build edges without re-reading every
/// body (content.md Graph view: "driven by both the `prereq:` field in
/// frontmatter and wikilinks").
pub fn scan_wikilinks(doc: &[u8]) -> Vec<String> {
    let head = &doc[..doc.len().min(BODY_SCAN_LIMIT)];
    let body = match std::str::from_utf8(head) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    // Skip the frontmatter block so a `prereq: [foo]` line doesn't also
    // surface as a wikilink. Same skip logic as scan_headings.
    let lines: Vec<&str> = body.lines().collect();
    let start = frontmatter_end_line(&lines);

    // Skip fenced code blocks: `[[foo]]` inside code is markup, not a link.
    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut in_fence = false;
    for line in &lines[start..] {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // Scan `[[ ... ]]`. Image embeds `![[ ... ]]` are second-class
        // links per file.md (assets, not page graph edges) and are
        // excluded explicitly.
        let bytes = line.as_bytes();
        let mut i = 0;
        while i + 1 < bytes.len() {
            if bytes[i] == b'[' && bytes[i + 1] == b'[' {
                // Reject the image-embed prefix `![[...]]`: images live
                // in `.<name>.assets/` and are not part of the page DAG.
                if i > 0 && bytes[i - 1] == b'!' {
                    i += 2;
                    continue;
                }
                let start_idx = i + 2;
                let mut j = start_idx;
                while j + 1 < bytes.len() && !(bytes[j] == b']' && bytes[j + 1] == b']') {
                    j += 1;
                }
                if j + 1 < bytes.len() && bytes[j] == b']' && bytes[j + 1] == b']' {
                    let inner = &line[start_idx..j];
                    // Drop the display alias `|...`.
                    let bare = inner.split('|').next().unwrap_or(inner).trim();
                    // Reject external URLs BEFORE stripping position
                    // markers, otherwise `https://...` gets cut at the
                    // first `:` and the leftover `https` looks like a
                    // page locator.
                    if bare.starts_with("http://") || bare.starts_with("https://") {
                        i = j + 2;
                        continue;
                    }
                    // Strip the position markers `#`, `@`, `:`, `%`
                    // (wikilink.md) so resolveWikiLink sees only the
                    // page locator.
                    let cut = bare
                        .find(|c: char| c == '#' || c == '@' || c == ':' || c == '%')
                        .unwrap_or(bare.len());
                    let target = bare[..cut].trim();
                    // Skip empties (`[[#heading]]` is a current-page
                    // self-ref, no edge to draw).
                    if !target.is_empty() && seen.insert(target.to_string()) {
                        out.push(target.to_string());
                    }
                    i = j + 2;
                    continue;
                }
            }
            i += 1;
        }
    }
    out
}
