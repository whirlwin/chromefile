//! The Claude Browser Bridge extension, embedded at build time from
//! `extensions/claude-browser-bridge` (see `scripts/vendor-extension.sh`).

use anyhow::{Context, Result, anyhow};
use base64::Engine;
use include_dir::{Dir, DirEntry, include_dir};
use sha2::{Digest, Sha256};
use std::path::Path;

static EXTENSION: Dir<'static> =
    include_dir!("$CARGO_MANIFEST_DIR/extensions/claude-browser-bridge");

/// The name used in output lines and as the folder name under the stable dir.
pub const NAME: &str = "claude-browser-bridge";

/// Every embedded file as (path relative to the extension root, bytes).
pub fn files() -> Vec<(&'static Path, &'static [u8])> {
    fn walk(dir: &'static Dir<'static>, out: &mut Vec<(&'static Path, &'static [u8])>) {
        for entry in dir.entries() {
            match entry {
                DirEntry::Dir(d) => walk(d, out),
                DirEntry::File(f) => out.push((f.path(), f.contents())),
            }
        }
    }
    let mut out = Vec::new();
    walk(&EXTENSION, &mut out);
    out
}

pub struct Manifest {
    pub version: String,
    pub id: String,
}

pub fn manifest() -> Result<Manifest> {
    let raw = EXTENSION
        .get_file("manifest.json")
        .ok_or_else(|| anyhow!("embedded extension has no manifest.json"))?
        .contents();
    let json: serde_json::Value =
        serde_json::from_slice(raw).context("embedded manifest.json is not valid JSON")?;
    let version = json["version"]
        .as_str()
        .ok_or_else(|| anyhow!("embedded manifest.json has no version"))?
        .to_string();
    let key = json["key"]
        .as_str()
        .ok_or_else(|| anyhow!("embedded manifest.json has no key"))?;
    Ok(Manifest {
        version,
        id: extension_id(key)?,
    })
}

/// Chrome's extension ID for a manifest `key`: the first 128 bits of the
/// SHA-256 of the DER public key, written with the letters a to p instead of
/// the hex digits 0 to f.
pub fn extension_id(key_base64: &str) -> Result<String> {
    let der = base64::engine::general_purpose::STANDARD
        .decode(key_base64)
        .context("manifest key is not valid base64")?;
    let digest = Sha256::digest(&der);
    Ok(digest[..16]
        .iter()
        .flat_map(|b| [b >> 4, b & 0xf])
        .map(|n| (b'a' + n) as char)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_from_embedded_key_is_the_bridge_id() {
        assert_eq!(manifest().unwrap().id, "cbapdndkoijjfggigdfalnjgjopdebid");
    }

    #[test]
    fn embeds_the_whole_extension() {
        let names: Vec<String> = files()
            .iter()
            .map(|(p, _)| p.to_string_lossy().into_owned())
            .collect();
        for want in ["manifest.json", "background.js", "icons/icon128.png"] {
            assert!(names.iter().any(|n| n == want), "missing {want}");
        }
    }
}
