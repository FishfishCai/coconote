use std::time::{SystemTime, UNIX_EPOCH};

/// Strips a leading `/` and percent-decodes. ONLY for raw URI paths
/// (the ssr fallback); values captured by axum's `Path` extractor are
/// already decoded, and decoding twice corrupts names containing a
/// literal `%HH`.
pub fn decode_path(p: &str) -> String {
    let trimmed = p.trim_start_matches('/');
    percent_encoding::percent_decode_str(trimmed)
        .decode_utf8()
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| trimmed.to_string())
}

/// Lowercase hex BLAKE3 of `bytes` — the wire `X-Content-Hash` /
/// history blob-key format.
pub fn blake3_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Wall-clock milliseconds since the Unix epoch. Returns 0 if the
/// system clock is before the epoch (should not happen in practice).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Same as [`now_ms`] for an arbitrary `SystemTime`.
pub fn system_time_ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `Foo.MD` → `Foo`; `bar.md` → `bar`; otherwise return as-is.
/// Case-insensitive `.md` strip used by md asset-prefix derivation.
pub fn strip_md_extension(base: &str) -> &str {
    if base.len() >= 3 && base[base.len() - 3..].eq_ignore_ascii_case(".md") {
        &base[..base.len() - 3]
    } else {
        base
    }
}

/// MIME type from a file extension, or None when unknown. Shared by the
/// `/.file` GET handler and the embedded-bundle SSR fallback so the two
/// don't drift. Not authoritative — clients mostly ignore it.
pub fn content_type(path: &str) -> Option<&'static str> {
    let p = path.to_ascii_lowercase();
    let ct = if p.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if p.ends_with(".md") {
        "text/markdown; charset=utf-8"
    } else if p.ends_with(".js") || p.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else if p.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if p.ends_with(".json") {
        "application/json"
    } else if p.ends_with(".pdf") {
        "application/pdf"
    } else if p.ends_with(".svg") {
        "image/svg+xml"
    } else if p.ends_with(".png") {
        "image/png"
    } else if p.ends_with(".jpg") || p.ends_with(".jpeg") {
        "image/jpeg"
    } else if p.ends_with(".webp") {
        "image/webp"
    } else if p.ends_with(".woff2") {
        "font/woff2"
    } else if p.ends_with(".woff") {
        "font/woff"
    } else {
        return None;
    };
    Some(ct)
}

/// Per-page assets directory prefix for an md path. file.md spec:
/// images live in `<dir>/.<stem>.assets/` where `<stem>` is the md
/// basename without its `.md` extension. Returns the prefix WITH a
/// trailing slash so callers can append asset names directly.
pub fn assets_prefix_for(md_path: &str) -> String {
    let (dir, base) = match md_path.rfind('/') {
        Some(i) => (&md_path[..i + 1], &md_path[i + 1..]),
        None => ("", md_path),
    };
    let stem = strip_md_extension(base);
    format!("{dir}.{stem}.assets/")
}
