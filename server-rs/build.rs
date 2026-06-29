// Copies the built client bundle into server-rs/embed/client so the
// include_dir! macro in src/space/embed.rs picks it up. If the bundle
// doesn't exist (developer hasn't run `npm run build` yet), we leave
// the placeholder so the macro doesn't fail.
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // build/build_client.ts writes to <repo>/embed/client/. We mirror
    // that whole tree into server-rs/embed/client/ so paths like
    // `.client/index.html` continue to resolve verbatim.
    let client_src = manifest_dir.join("..").join("embed").join("client");
    let embed_dst = manifest_dir.join("embed").join("client");

    println!("cargo:rerun-if-changed=build.rs");
    // Emit for the top dir AND every entry under it: cargo only stats
    // the listed paths, so the top dir alone misses edits inside files
    // (incremental builds would keep embedding a stale client).
    println!("cargo:rerun-if-changed={}", client_src.display());
    emit_rerun_recursive(&client_src);

    // Always clear embed_dst first — stops a previous full bundle from
    // outliving an `rm -rf embed/client` in the parent tree. include_dir!
    // bakes whatever's in the dir at compile time, so a stale leftover
    // would silently ship the old UI.
    let _ = std::fs::remove_dir_all(&embed_dst);
    std::fs::create_dir_all(&embed_dst).expect("create embed dst");
    if client_src.exists() && client_src != embed_dst {
        copy_dir(&client_src, &embed_dst).expect("copy client bundle");
    } else {
        let _ = std::fs::write(embed_dst.join(".placeholder"), "placeholder\n");
    }
}

/// Walk `dir` and emit cargo:rerun-if-changed for every file and
/// subdirectory (dirs catch additions/removals, files catch edits).
fn emit_rerun_recursive(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        println!("cargo:rerun-if-changed={}", p.display());
        if p.is_dir() {
            emit_rerun_recursive(&p);
        }
    }
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            std::fs::create_dir_all(&to)?;
            copy_dir(&entry.path(), &to)?;
        } else if ft.is_file() {
            std::fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}
