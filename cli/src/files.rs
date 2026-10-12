//! Keeps the stable extension folder in step with the embedded files. Chrome
//! loads an unpacked extension from its folder on every start, so the folder
//! must outlive the binary and only change when the embedded files do.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Makes `dest` hold exactly `files`: writes files whose bytes differ and
/// removes anything else. The folder belongs to chromefile, so extras are
/// deleted. Symlinks are removed, never followed. Returns whether anything
/// changed.
pub fn sync_dir(dest: &Path, files: &[(&Path, &[u8])]) -> io::Result<bool> {
    if fs::symlink_metadata(dest).is_ok_and(|m| !m.is_dir()) {
        return Err(io::Error::other(format!(
            "{} exists and is not a folder; remove it first",
            dest.display()
        )));
    }
    fs::create_dir_all(dest)?;

    let wanted: HashSet<PathBuf> = files.iter().map(|(p, _)| p.to_path_buf()).collect();
    let wanted_dirs: HashSet<PathBuf> = files
        .iter()
        .flat_map(|(p, _)| p.ancestors().skip(1))
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .collect();

    // Prune first, so a stray symlink can't redirect the writes below.
    let mut changed = prune(dest, dest, &wanted, &wanted_dirs)?;

    for (rel, bytes) in files {
        let path = dest.join(rel);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.is_file() => {
                if fs::read(&path)? == *bytes {
                    continue;
                }
            }
            Ok(m) if m.is_dir() => fs::remove_dir_all(&path)?,
            Ok(_) => fs::remove_file(&path)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, bytes)?;
        changed = true;
    }
    Ok(changed)
}

fn prune(
    root: &Path,
    dir: &Path,
    wanted: &HashSet<PathBuf>,
    wanted_dirs: &HashSet<PathBuf>,
) -> io::Result<bool> {
    let mut changed = false;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let rel = path.strip_prefix(root).map_err(io::Error::other)?;
        // file_type() does not follow symlinks.
        let kind = entry.file_type()?;
        if kind.is_dir() {
            if wanted_dirs.contains(rel) {
                changed |= prune(root, &path, wanted, wanted_dirs)?;
            } else {
                fs::remove_dir_all(&path)?;
                changed = true;
            }
        } else if !(kind.is_file() && wanted.contains(rel)) {
            fs::remove_file(&path)?;
            changed = true;
        }
    }
    Ok(changed)
}

/// Whether `dest` already holds exactly `files`. Read-only.
pub fn matches(dest: &Path, files: &[(&Path, &[u8])]) -> bool {
    let all_match = files
        .iter()
        .all(|(rel, bytes)| fs::read(dest.join(rel)).is_ok_and(|b| b == *bytes));
    all_match && count_entries(dest).is_ok_and(|n| n == files.len())
}

fn count_entries(dir: &Path) -> io::Result<usize> {
    let mut n = 0;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            n += count_entries(&entry.path())?;
        } else {
            n += 1;
        }
    }
    Ok(n)
}

/// Deletes the stable folder. Returns whether it existed.
pub fn remove_dir(dest: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(dest) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(dest).map(|_| true),
        Ok(_) => fs::remove_file(dest).map(|_| true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("chromefile-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_changed_files_removes_extras_then_is_unchanged() {
        let dir = temp_dir("sync");
        let dest = dir.join("ext");
        fs::create_dir_all(dest.join("old")).unwrap();
        fs::write(dest.join("old/stale.js"), "x").unwrap();
        fs::write(dest.join("extra.txt"), "x").unwrap();
        fs::write(dest.join("a.js"), "old").unwrap();

        let files: Vec<(&Path, &[u8])> = vec![
            (Path::new("a.js"), b"new"),
            (Path::new("icons/i.png"), b"png"),
        ];
        assert!(sync_dir(&dest, &files).unwrap());
        assert_eq!(fs::read(dest.join("a.js")).unwrap(), b"new");
        assert_eq!(fs::read(dest.join("icons/i.png")).unwrap(), b"png");
        assert!(!dest.join("extra.txt").exists());
        assert!(!dest.join("old").exists());
        assert!(matches(&dest, &files));

        assert!(!sync_dir(&dest, &files).unwrap());

        fs::write(dest.join("icons/new.png"), "x").unwrap();
        assert!(!matches(&dest, &files));
        assert!(sync_dir(&dest, &files).unwrap());

        assert!(remove_dir(&dest).unwrap());
        assert!(!remove_dir(&dest).unwrap());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn removes_symlinks_without_following_them() {
        let dir = temp_dir("symlink");
        let dest = dir.join("ext");
        let outside = dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "keep").unwrap();
        fs::create_dir_all(&dest).unwrap();
        std::os::unix::fs::symlink(&outside, dest.join("icons")).unwrap();

        let files: Vec<(&Path, &[u8])> = vec![(Path::new("icons/i.png"), b"png")];
        assert!(sync_dir(&dest, &files).unwrap());
        assert!(fs::symlink_metadata(dest.join("icons")).unwrap().is_dir());
        assert_eq!(fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        assert!(!outside.join("i.png").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
