use crate::error::{Error, Result};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// File-id alphabet: 16-char `[a-z0-9]` random strings (design.md frontmatter
/// `id`). The id is a file's identity for addressing, refs, sync and collab.
const ID_ALPHABET: &[u8; 36] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// Length of a frontmatter `id`.
pub const ID_LEN: usize = 16;

/// Per-process counter folded into id entropy so two ids minted in the same
/// nanosecond still differ.
static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// True when `s` is a syntactically valid file id: exactly 16 chars, each in
/// `[a-z0-9]`. Used to decide whether a file already carries a usable id.
pub fn is_valid_id(s: &str) -> bool {
    s.len() == ID_LEN && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Fill `buf` from the OS CSPRNG (`/dev/urandom`). Returns false if it could
/// not be read, so the caller folds in clock / pid / counter entropy instead.
fn os_random(buf: &mut [u8]) -> bool {
    use std::io::Read;
    match std::fs::File::open("/dev/urandom") {
        Ok(mut f) => f.read_exact(buf).is_ok(),
        Err(_) => false,
    }
}

/// Nanoseconds since the Unix epoch (0 if the clock is before it). Extra id
/// entropy, not a timestamp of record.
fn now_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Mint a fresh 16-char `[a-z0-9]` file id. Entropy is OS randomness mixed
/// with clock / pid / counter through BLAKE3's XOF, so it is unique without a
/// new crate. The `% 36` fold is negligibly biased for a uniqueness token.
pub fn gen_id() -> String {
    let mut rnd = [0u8; 32];
    let _ = os_random(&mut rnd);
    let mut hasher = blake3::Hasher::new();
    hasher.update(&rnd);
    hasher.update(&now_ns().to_le_bytes());
    hasher.update(&(std::process::id() as u64).to_le_bytes());
    hasher.update(&ID_COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    let stack_probe = 0u8;
    hasher.update(&(&stack_probe as *const u8 as usize as u64).to_le_bytes());
    let mut reader = hasher.finalize_xof();
    let mut bytes = [0u8; ID_LEN];
    reader.fill(&mut bytes);
    bytes.iter().map(|b| ID_ALPHABET[*b as usize % 36] as char).collect()
}

/// Whether any component is a `..` traversal. The traversal guard
/// (disk::safe_path) rejects these outright, so a `..` request that slips
/// past the boundary is still refused before it touches the filesystem.
pub fn contains_parent_dir(p: &Path) -> bool {
    p.components().any(|c| matches!(c, Component::ParentDir))
}

/// Strips a leading `/` and percent-decodes. ONLY for raw URI paths (the
/// ssr fallback): axum `Path` captures are already decoded, and decoding
/// twice corrupts names containing a literal `%HH`.
pub fn decode_path(p: &str) -> String {
    let trimmed = p.trim_start_matches('/');
    percent_encoding::percent_decode_str(trimmed)
        .decode_utf8()
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| trimmed.to_string())
}

/// Lowercase hex BLAKE3: the wire `X-Content-Hash` / history blob-key format.
pub fn blake3_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Wall-clock ms since the Unix epoch, 0 if the clock is before it.
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

/// Case-insensitive `.md` strip (else as-is), used by md asset-prefix
/// derivation.
pub fn strip_md_extension(base: &str) -> &str {
    if base.len() >= 3 && base[base.len() - 3..].eq_ignore_ascii_case(".md") {
        &base[..base.len() - 3]
    } else {
        base
    }
}

/// MIME from extension, None when unknown. Shared by the `/.file` GET
/// handler and the embedded-bundle SSR fallback so the two don't drift.
/// Not authoritative: clients mostly ignore it.
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

/// Per-page assets prefix for a page path. Both md and pdf pages keep their
/// companions in `<dir>/.<stem>.assets/`, where `<stem>` is the basename with
/// its `.md` or `.pdf` extension removed (matches the client `assetsPrefix`).
/// Returned WITH a trailing slash so callers append asset names directly.
pub fn assets_prefix_for(page_path: &str) -> String {
    let (dir, base) = match page_path.rfind('/') {
        Some(i) => (&page_path[..i + 1], &page_path[i + 1..]),
        None => ("", page_path),
    };
    let stem = if base.len() >= 4 && base[base.len() - 4..].eq_ignore_ascii_case(".pdf") {
        &base[..base.len() - 4]
    } else {
        strip_md_extension(base)
    };
    format!("{dir}.{stem}.assets/")
}

/// PDF annotations sidecar path for a `.pdf` path: `<dir>.<stem>.assets/<stem>.json`,
/// `<stem>` = pdf basename without `.pdf`. Must stay byte-identical to the
/// client `pdfSidecarPath` (path_url.ts) so both ends address one file.
pub fn pdf_sidecar_for(pdf_path: &str) -> String {
    // The sidecar lives at `<assets_prefix><stem>.json`; reuse
    // assets_prefix_for for the `<dir>.<stem>.assets/` part and the basename
    // helper for the `<stem>.json` part.
    format!("{}{}", assets_prefix_for(pdf_path), pdf_sidecar_asset(pdf_path))
}

/// The sidecar's `?asset=` basename for a pdf (`<stem>.json`): pdf_sidecar_for
/// minus its assets-dir prefix. Lets the server resolve "the sidecar" from the
/// pdf's id alone (the @sidecar sentinel) so the client needs no path.
pub fn pdf_sidecar_asset(pdf_path: &str) -> String {
    let base = pdf_path.rsplit('/').next().unwrap_or(pdf_path);
    let stem = if base.len() >= 4 && base[base.len() - 4..].eq_ignore_ascii_case(".pdf") {
        &base[..base.len() - 4]
    } else {
        base
    };
    format!("{stem}.json")
}

/// The history manifest key under which a pdf's sidecar json is versioned: its
/// path relative to the pdf's own directory (`.<stem>.assets/<stem>.json`).
/// The pdf's `.history/` lives in that same `.<stem>.assets/`, so the key is
/// the sidecar path with the pdf's directory prefix stripped. This is what
/// `Manifest::main_file()` returns for a pdf snapshot, and what restore writes
/// back relative to the pdf's directory.
pub fn pdf_sidecar_rel_key(pdf_path: &str) -> String {
    let sidecar = pdf_sidecar_for(pdf_path);
    let dir = match pdf_path.rfind('/') {
        Some(i) => &pdf_path[..i + 1],
        None => "",
    };
    sidecar.strip_prefix(dir).unwrap_or(&sidecar).to_string()
}

/// Crash-safe write: tmp + fsync + rename in the target's directory so a
/// reader never sees a torn file, then fsync the directory so the rename
/// itself survives a crash. Creates parent dirs as needed. The one atomic
/// writer all on-disk writes route through (file bodies, yaml/snippet
/// config, history versions.json and blobs).
pub fn write_atomic(full: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = full.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(Error::Io)?;
    }
    let parent = full
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::Builder::new()
        .prefix(".coconote.write.")
        .tempfile_in(parent)
        .map_err(Error::Io)?;
    use std::io::Write as _;
    tmp.write_all(bytes).map_err(Error::Io)?;
    tmp.flush().map_err(Error::Io)?;
    tmp.as_file().sync_all().map_err(Error::Io)?;
    tmp.persist(full).map_err(|e| Error::Io(e.error))?;
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assets_prefix_and_pdf_sidecar_paths() {
        assert_eq!(assets_prefix_for("notes/foo.md"), "notes/.foo.assets/");
        assert_eq!(assets_prefix_for("foo.md"), ".foo.assets/");
        assert_eq!(assets_prefix_for("papers/foo.pdf"), "papers/.foo.assets/");
        assert_eq!(assets_prefix_for("foo.pdf"), ".foo.assets/");
        // Byte-identical to the client pdfSidecarPath contract.
        assert_eq!(pdf_sidecar_for("papers/foo.pdf"), "papers/.foo.assets/foo.json");
        assert_eq!(pdf_sidecar_for("foo.pdf"), ".foo.assets/foo.json");
        assert_eq!(pdf_sidecar_for("a/b/REPORT.PDF"), "a/b/.REPORT.assets/REPORT.json");
        // The relative manifest key is the sidecar minus the pdf's directory.
        assert_eq!(pdf_sidecar_rel_key("papers/foo.pdf"), ".foo.assets/foo.json");
        assert_eq!(pdf_sidecar_rel_key("foo.pdf"), ".foo.assets/foo.json");
        assert_eq!(pdf_sidecar_rel_key("a/b/REPORT.PDF"), ".REPORT.assets/REPORT.json");
    }

    #[test]
    fn gen_id_is_valid_and_unique() {
        let a = gen_id();
        assert!(is_valid_id(&a), "minted id must be valid: {a}");
        assert_eq!(a.len(), ID_LEN);
        // 1000 ids, no collision (uniqueness token).
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            assert!(seen.insert(gen_id()), "ids must be unique");
        }
    }

    #[test]
    fn is_valid_id_rejects_bad_shapes() {
        assert!(is_valid_id("abcd1234efgh5678"));
        assert!(!is_valid_id("short"));
        assert!(!is_valid_id("ABCD1234EFGH5678"), "uppercase not allowed");
        assert!(!is_valid_id("abcd1234efgh567"), "15 chars too short");
        assert!(!is_valid_id("abcd1234efgh5678x"), "17 chars too long");
        assert!(!is_valid_id("abcd-234_efgh5678"), "punctuation not allowed");
    }

    #[test]
    fn parent_dir_detection_flags_traversal() {
        // contains_parent_dir flags exactly the paths with a `..` component
        // (what disk::safe_path rejects) and nothing else.
        for p in ["/a/../b.md", "../escape.md", "/a/b/../../c.md"] {
            assert!(contains_parent_dir(Path::new(p)), "{p} has traversal");
        }
        for p in ["/a/b.md", "/a/./b.md", "a/b.md"] {
            assert!(!contains_parent_dir(Path::new(p)), "{p} has no traversal");
        }
    }
}
