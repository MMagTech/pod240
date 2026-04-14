//! Best-effort detection of a SubRip file next to a video for burned-in subtitles.

use std::path::{Path, PathBuf};

/// If `video.mkv` exists, prefer `video.srt` in the same directory.
/// Otherwise, if exactly one `video.*.srt` exists (e.g. `video.en.srt`), use it.
/// If multiple candidates exist and `video.srt` is missing, returns `None`.
pub fn detect_sidecar_srt(video: &Path) -> Option<PathBuf> {
    let dir = video.parent()?;
    let stem = video.file_stem()?.to_str()?;
    let primary = dir.join(format!("{stem}.srt"));
    if primary.is_file() {
        return Some(primary);
    }

    let prefix = format!("{stem}.");
    let mut alt: Vec<PathBuf> = Vec::new();
    let rd = std::fs::read_dir(dir).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        if !is_srt_extension(p.extension().and_then(|x| x.to_str())) {
            continue;
        }
        let name = match p.file_stem().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with(&prefix) && name.len() > prefix.len() {
            alt.push(p);
        }
    }
    alt.sort();
    if alt.len() == 1 {
        return Some(alt.pop()?);
    }
    None
}

fn is_srt_extension(ext: Option<&str>) -> bool {
    match ext {
        Some(e) => e.eq_ignore_ascii_case("srt"),
        None => false,
    }
}

pub fn is_srt_file(path: &Path) -> bool {
    path.is_file() && is_srt_extension(path.extension().and_then(|x| x.to_str()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn detect_prefers_same_stem_srt() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("Show.S01E01.mkv");
        let srt = dir.path().join("Show.S01E01.srt");
        fs::write(&video, b"x").unwrap();
        fs::write(&srt, b"1\n").unwrap();
        assert_eq!(detect_sidecar_srt(&video), Some(srt));
    }

    #[test]
    fn detect_single_language_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("Movie.mkv");
        let srt = dir.path().join("Movie.en.srt");
        fs::write(&video, b"x").unwrap();
        fs::write(&srt, b"1\n").unwrap();
        assert_eq!(detect_sidecar_srt(&video), Some(srt));
    }

    #[test]
    fn detect_none_when_two_alternatives_without_primary() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("Movie.mkv");
        fs::write(&video, b"x").unwrap();
        fs::write(dir.path().join("Movie.en.srt"), b"a").unwrap();
        fs::write(dir.path().join("Movie.fr.srt"), b"b").unwrap();
        assert_eq!(detect_sidecar_srt(&video), None);
    }
}
