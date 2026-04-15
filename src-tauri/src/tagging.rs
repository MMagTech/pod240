//! Episode filename hints, artwork → JPEG for `covr`, and AtomicParsley invocation.

use std::io::Cursor;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::imageops::FilterType;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::resources_root;

/// AtomicParsley’s default `--overWrite` temp lives beside the source; network/special folders may deny that.
/// `--output` writes to an arbitrary path (voids `--overWrite`); we use the OS temp dir, then copy over the original.
fn atomicparsley_scratch_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "pod240-ap-{}.mp4",
        uuid::Uuid::new_v4()
    ))
}

/// Helps SMB / network volumes show updated bytes to the next reader (e.g. Lofty probe).
pub(crate) fn sync_file_data_best_effort(path: &std::path::Path) {
    use std::fs::OpenOptions;
    let open = OpenOptions::new().read(true).write(true).open(path);
    let open = open.or_else(|_| std::fs::File::open(path));
    if let Ok(f) = open {
        let _ = f.sync_all();
    }
}

/// Copy `scratch` onto `destination`, replacing it. Some SMB shares deny `CopyFile` overwrite but allow
/// delete + create; we retry transient locks, then use backup/remove/copy with restore on failure.
pub(crate) fn replace_file_from_local_scratch(
    scratch: &Path,
    destination: &Path,
    err_ctx: &str,
) -> Result<(), String> {
    for attempt in 0u32..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(150));
        }
        match std::fs::copy(scratch, destination) {
            Ok(_) => {
                let _ = std::fs::remove_file(scratch);
                sync_file_data_best_effort(destination);
                return Ok(());
            }
            Err(e) if e.kind() == ErrorKind::PermissionDenied => continue,
            Err(e) => {
                let _ = std::fs::remove_file(scratch);
                return Err(format!("{err_ctx}: {e}"));
            }
        }
    }

    let backup = std::env::temp_dir().join(format!(
        "pod240-repl-bak-{}.mp4",
        uuid::Uuid::new_v4()
    ));
    if let Err(e) = std::fs::copy(destination, &backup) {
        let _ = std::fs::remove_file(scratch);
        return Err(format!("{err_ctx} (backup original): {e}"));
    }
    if let Err(e) = std::fs::remove_file(destination) {
        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::remove_file(scratch);
        return Err(format!(
            "{err_ctx}: close other apps using the file, then try again: {e}"
        ));
    }
    match std::fs::copy(scratch, destination) {
        Ok(_) => {
            let _ = std::fs::remove_file(scratch);
            let _ = std::fs::remove_file(backup);
            sync_file_data_best_effort(destination);
            Ok(())
        }
        Err(e2) => match std::fs::copy(&backup, destination) {
            Ok(_) => {
                let _ = std::fs::remove_file(backup);
                let _ = std::fs::remove_file(scratch);
                Err(format!("{err_ctx}: {e2}"))
            }
            Err(e3) => {
                let _ = std::fs::remove_file(scratch);
                Err(format!(
                    "{err_ctx}: {e2}; could not restore original ({e3}). Backup: {}",
                    backup.display()
                ))
            }
        },
    }
}

fn atomicparsley_apply_output(scratch: &Path, destination: &Path) -> Result<(), String> {
    replace_file_from_local_scratch(scratch, destination, "could not replace file after tagging")
}

/// Optional iTunes atoms shared by movie / TV / music video (see UI “Common” section).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommonItunesTags {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub long_description: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    /// Release year or date string; 4-digit years map to `--year` when not skipped.
    #[serde(default)]
    pub release_date: Option<String>,
    /// Sort title (`sonm`) via `--sortOrder name`.
    #[serde(default)]
    pub sort_title: Option<String>,
    #[serde(default)]
    pub hd_video: Option<bool>,
    #[serde(default)]
    pub content_rating: Option<String>,
    /// Shown as encoding tool (`©too`).
    #[serde(default)]
    pub encoder: Option<String>,
    #[serde(default)]
    pub copyright: Option<String>,
}

/// Tags applied after HandBrake encode (AtomicParsley). `Skip` is not stored on [`crate::Job`]; it becomes `None`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EmbeddableTags {
    #[serde(rename = "skip")]
    Skip,
    #[serde(rename = "movie")]
    Movie {
        title: String,
        #[serde(default)]
        year: Option<u32>,
        #[serde(default, rename = "artworkBase64")]
        artwork_base64: Option<String>,
        #[serde(flatten, default)]
        common: CommonItunesTags,
    },
    #[serde(rename = "tv")]
    Tv {
        /// JSON from the frontend uses `showName` (camelCase). Explicit rename avoids serde
        /// missing-field errors when the enum-level `rename_all` does not apply as expected for IPC.
        #[serde(rename = "showName")]
        show_name: String,
        season: u32,
        episode: u32,
        #[serde(default, rename = "episodeTitle")]
        episode_title: Option<String>,
        #[serde(default, rename = "artworkBase64")]
        artwork_base64: Option<String>,
        /// Production / episode id (`tven`).
        #[serde(default, rename = "episodeId")]
        episode_id: Option<String>,
        #[serde(default, rename = "tvNetwork")]
        tv_network: Option<String>,
        /// Sort show (`sosn`) via `--sortOrder show`.
        #[serde(default, rename = "sortShow")]
        sort_show: Option<String>,
        #[serde(flatten, default)]
        common: CommonItunesTags,
    },
    #[serde(rename = "musicVideo")]
    MusicVideo {
        title: String,
        artist: String,
        #[serde(default, rename = "artworkBase64")]
        artwork_base64: Option<String>,
        #[serde(default, rename = "albumArtist")]
        album_artist: Option<String>,
        #[serde(default)]
        album: Option<String>,
        #[serde(default)]
        composer: Option<String>,
        #[serde(default)]
        compilation: Option<bool>,
        #[serde(flatten, default)]
        common: CommonItunesTags,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeParseInfo {
    pub ok: bool,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    /// Best-effort show name from filename (e.g. text before `S01E02`).
    pub inferred_show: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzedFile {
    pub source_path: String,
    pub tree_root: Option<String>,
    pub parse: EpisodeParseInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonGroupPreview {
    pub season: u32,
    pub file_indices: Vec<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeResult {
    pub files: Vec<AnalyzedFile>,
    /// True when at least half of files got a confident TV-style episode parse.
    pub suggest_batch_tv: bool,
    pub season_groups: Vec<SeasonGroupPreview>,
    /// Indices into `files` where `parse.ok` is false (cannot join a season group).
    pub unparsed_file_indices: Vec<usize>,
}

pub fn parse_episode_from_stem(stem: &str) -> EpisodeParseInfo {
    let re_sxe = Regex::new(r"(?i)(?:^|[._\s-]+)S(\d{1,2})[._\s-]*E(\d{1,3})(?:[._\s-]|$)").unwrap();
    if let Some(c) = re_sxe.captures(stem) {
        let s = c.get(1).and_then(|m| m.as_str().parse().ok());
        let e = c.get(2).and_then(|m| m.as_str().parse().ok());
        let inferred = infer_show_from_stem_sxe(stem, &c);
        return EpisodeParseInfo {
            ok: s.is_some() && e.is_some(),
            season: s,
            episode: e,
            inferred_show: inferred,
        };
    }

    let re_x = Regex::new(r"(?i)(?:^|[._\s-])(\d{1,2})x(\d{1,3})(?:[._\s-]|$)").unwrap();
    if let Some(c) = re_x.captures(stem) {
        let s = c.get(1).and_then(|m| m.as_str().parse().ok());
        let e = c.get(2).and_then(|m| m.as_str().parse().ok());
        return EpisodeParseInfo {
            ok: s.is_some() && e.is_some(),
            season: s,
            episode: e,
            inferred_show: infer_show_before_pattern(stem, c.get(0).map(|m| m.start()).unwrap_or(0)),
        };
    }

    // 3-digit: 101 → S01E01, 213 → S02E13 (single-digit season)
    let re3 = Regex::new(r"(?:^|[._\s-])(\d)(\d{2})(?:[._\s-]|$)").unwrap();
    if let Some(c) = re3.captures(stem) {
        let sd = c.get(1).and_then(|m| m.as_str().parse::<u32>().ok());
        let ep = c.get(2).and_then(|m| m.as_str().parse::<u32>().ok());
        if let (Some(season), Some(episode)) = (sd, ep) {
            if season <= 9 && episode <= 999 {
                return EpisodeParseInfo {
                    ok: true,
                    season: Some(season),
                    episode: Some(episode),
                    inferred_show: infer_show_before_pattern(stem, c.get(0).map(|m| m.start()).unwrap_or(0)),
                };
            }
        }
    }

    EpisodeParseInfo {
        ok: false,
        season: None,
        episode: None,
        inferred_show: None,
    }
}

fn infer_show_from_stem_sxe(stem: &str, cap: &regex::Captures) -> Option<String> {
    let m = cap.get(0)?;
    let before = stem[..m.start()].trim_matches(|c: char| c == '.' || c == '_' || c == '-' || c == ' ');
    if before.is_empty() {
        return None;
    }
    Some(trim_show_tail(before))
}

fn infer_show_before_pattern(stem: &str, pat_start: usize) -> Option<String> {
    let before = stem[..pat_start].trim_matches(|c: char| c == '.' || c == '_' || c == '-' || c == ' ');
    if before.is_empty() {
        return None;
    }
    Some(trim_show_tail(before))
}

fn trim_show_tail(s: &str) -> String {
    let re = Regex::new(r"(?i)[._\s-]+(720p|1080p|2160p|webrip|bluray|x264|x265|h\.?264|h\.?265).*$")
        .unwrap();
    let t = re.replace(s, "").trim_matches(|c: char| c == '.' || c == '_' || c == '-').to_string();
    if t.is_empty() {
        s.to_string()
    } else {
        t
    }
}

pub fn build_season_groups(files: &[AnalyzedFile]) -> Vec<SeasonGroupPreview> {
    use std::collections::BTreeMap;
    let mut m: BTreeMap<u32, Vec<usize>> = BTreeMap::new();
    for (i, f) in files.iter().enumerate() {
        if let Some(s) = f.parse.season {
            m.entry(s).or_default().push(i);
        }
    }
    m.into_iter()
        .map(|(season, file_indices)| SeasonGroupPreview { season, file_indices })
        .collect()
}

pub fn analyze_majority_tv(files: &[AnalyzedFile]) -> bool {
    if files.is_empty() {
        return false;
    }
    let ok = files.iter().filter(|f| f.parse.ok).count();
    ok * 2 >= files.len()
}

/// Indices of files where the filename did not parse as a TV episode pattern.
pub fn unparsed_indices(files: &[AnalyzedFile]) -> Vec<usize> {
    files
        .iter()
        .enumerate()
        .filter(|(_, f)| !f.parse.ok)
        .map(|(i, _)| i)
        .collect()
}

/// Decode base64, resize to max 500×500, encode JPEG ≤ ~100KB when possible.
pub fn artwork_base64_to_temp_jpeg(b64: &str, temp: &Path) -> Result<(), String> {
    let bytes = B64
        .decode(b64.trim().as_bytes())
        .map_err(|e| format!("Invalid artwork base64: {e}"))?;
    artwork_bytes_to_temp_jpeg(&bytes, temp)
}

pub fn artwork_bytes_to_temp_jpeg(bytes: &[u8], temp: &Path) -> Result<(), String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("Unsupported image: {e}"))?;
    let mut rgb = img.to_rgb8();
    let (mut w, mut h) = (rgb.width(), rgb.height());
    let max_dim = 500u32;
    if w > max_dim || h > max_dim {
        let scale = (max_dim as f64 / (w.max(h) as f64)).min(1.0);
        let nw = ((w as f64) * scale).round().max(1.0) as u32;
        let nh = ((h as f64) * scale).round().max(1.0) as u32;
        rgb = image::imageops::resize(&rgb, nw, nh, FilterType::Triangle);
        w = nw;
        h = nh;
    }

    let mut quality: u8 = 85;
    loop {
        let mut buf = Vec::new();
        let mut cursor = Cursor::new(&mut buf);
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
        enc.encode(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("JPEG encode: {e}"))?;
        drop(enc);
        let size = buf.len();
        if size <= 100 * 1024 || quality <= 35 {
            std::fs::write(temp, buf).map_err(|e| e.to_string())?;
            return Ok(());
        }
        quality = quality.saturating_sub(10);
    }
}

pub fn find_atomicparsley_executable(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("POD240_ATOMICPARSLEY") {
        let pb = PathBuf::from(p.trim());
        if pb.exists() {
            return Ok(pb);
        }
    }

    let res = resources_root(app)?;
    let dir = res.join("atomicparsley");
    if !dir.is_dir() {
        return Err(format!(
            "Add AtomicParsley to {} or set POD240_ATOMICPARSLEY",
            dir.display()
        ));
    }

    let exact = if cfg!(windows) {
        dir.join("AtomicParsley.exe")
    } else {
        dir.join("AtomicParsley")
    };
    if exact.exists() {
        return Ok(exact);
    }

    if cfg!(windows) {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let p = e.path();
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
                if name.ends_with(".exe") && name.contains("atomicparsley") {
                    return Ok(p);
                }
            }
        }
    }

    Err(format!(
        "No AtomicParsley executable in {}. See resources/atomicparsley/README.txt",
        dir.display()
    ))
}

pub fn artwork_base64_from_tags(tags: &EmbeddableTags) -> Option<&String> {
    match tags {
        EmbeddableTags::Skip => None,
        EmbeddableTags::Movie { artwork_base64, .. }
        | EmbeddableTags::Tv { artwork_base64, .. }
        | EmbeddableTags::MusicVideo { artwork_base64, .. } => artwork_base64.as_ref(),
    }
}

/// Optional atoms: desc, ldes, genre, year from `release_date`, sort title, hd, rating, encoder, copyright.
fn append_common_itunes_tags(cmd: &mut Command, c: &CommonItunesTags, skip_release_date_year: bool) {
    if !skip_release_date_year {
        if let Some(ref s) = c.release_date {
            let t = s.trim();
            if t.len() == 4 {
                if let Ok(y) = t.parse::<u32>() {
                    if (1800..=2200).contains(&y) {
                        cmd.arg("--year").arg(format!("{y}"));
                    }
                }
            }
        }
    }

    if let Some(ref s) = c.description {
        if !s.is_empty() {
            cmd.arg("--description").arg(s);
        }
    }
    if let Some(ref s) = c.long_description {
        if !s.is_empty() {
            cmd.arg("--longdesc").arg(s);
        }
    }
    if let Some(ref s) = c.genre {
        if !s.is_empty() {
            cmd.arg("--genre").arg(s);
        }
    }
    if let Some(ref s) = c.sort_title {
        if !s.is_empty() {
            cmd.arg("--sortOrder").arg("name").arg(s);
        }
    }
    if let Some(b) = c.hd_video {
        cmd.arg("--hdvideo").arg(if b { "true" } else { "false" });
    }
    if let Some(ref s) = c.content_rating {
        if !s.is_empty() {
            cmd.arg("--contentRating").arg(s);
        }
    }
    if let Some(ref s) = c.encoder {
        if !s.is_empty() {
            cmd.arg("--encodingTool").arg(s);
        }
    }
    if let Some(ref s) = c.copyright {
        if !s.is_empty() {
            cmd.arg("--copyright").arg(s);
        }
    }
}

/// Apply iTunes-style atoms. Writes via `--output` to the OS temp dir, then replaces `video` (works when the
/// source folder cannot create AtomicParsley’s default sibling temp file, e.g. some network shares).
///
/// `omit_embedded_cover_on_output`: strip any inherited cover on `video` before applying tags (user chose not to
/// carry source-embedded art onto the encode output). Ignored when new artwork is supplied (we already REMOVE_ALL).
pub fn run_atomicparsley(
    exe: &Path,
    video: &Path,
    tags: &EmbeddableTags,
    artwork_jpeg: Option<&Path>,
    omit_embedded_cover_on_output: bool,
) -> Result<(), String> {
    let scratch = atomicparsley_scratch_path();
    let mut cmd = Command::new(exe);
    cmd.arg(video);

    match tags {
        EmbeddableTags::Skip => return Ok(()),
        EmbeddableTags::Movie {
            title,
            year,
            artwork_base64: _,
            common,
        } => {
            // Bare "9" is not a known stik name; AtomicParsley leaves stik at 0 → iTunes "Home Video".
            // `value=9` sets the numeric Movie kind (see wez/atomicparsley Meta_stik / --stik value=(num)).
            cmd.arg("--stik").arg("value=9");
            cmd.arg("--title").arg(title);
            let skip_rd = year.is_some();
            if let Some(y) = year {
                cmd.arg("--year").arg(format!("{y}"));
            }
            append_common_itunes_tags(&mut cmd, common, skip_rd);
        }
        EmbeddableTags::Tv {
            show_name,
            season,
            episode,
            episode_title,
            artwork_base64: _,
            episode_id,
            tv_network,
            sort_show,
            common,
        } => {
            cmd.arg("--stik").arg("value=10");
            cmd.arg("--TVShowName").arg(show_name);
            cmd.arg("--TVSeasonNum").arg(format!("{season}"));
            cmd.arg("--TVEpisodeNum").arg(format!("{episode}"));
            let ep_title = episode_title.clone().unwrap_or_else(|| format!("Episode {episode}"));
            cmd.arg("--title").arg(&ep_title);
            if let Some(ref s) = episode_id {
                if !s.is_empty() {
                    cmd.arg("--TVEpisode").arg(s);
                }
            }
            if let Some(ref s) = tv_network {
                if !s.is_empty() {
                    cmd.arg("--TVNetwork").arg(s);
                }
            }
            if let Some(ref s) = sort_show {
                if !s.is_empty() {
                    cmd.arg("--sortOrder").arg("show").arg(s);
                }
            }
            append_common_itunes_tags(&mut cmd, common, false);
        }
        EmbeddableTags::MusicVideo {
            title,
            artist,
            artwork_base64: _,
            album_artist,
            album,
            composer,
            compilation,
            common,
        } => {
            cmd.arg("--stik").arg("value=6");
            cmd.arg("--title").arg(title);
            cmd.arg("--artist").arg(artist);
            if let Some(ref s) = album_artist {
                if !s.is_empty() {
                    cmd.arg("--albumArtist").arg(s);
                }
            }
            if let Some(ref s) = album {
                if !s.is_empty() {
                    cmd.arg("--album").arg(s);
                }
            }
            if let Some(ref s) = composer {
                if !s.is_empty() {
                    cmd.arg("--composer").arg(s);
                }
            }
            if let Some(c) = compilation {
                cmd.arg("--compilation").arg(if *c { "true" } else { "false" });
            }
            append_common_itunes_tags(&mut cmd, common, false);
        }
    }

    if let Some(j) = artwork_jpeg {
        // Replace covr entirely: `--artwork` adds a new image; without this, existing
        // artwork can remain and iTunes often displays the first embedded image, not the new one.
        cmd.arg("--artwork").arg("REMOVE_ALL");
        cmd.arg("--artwork").arg(j);
    } else if omit_embedded_cover_on_output {
        cmd.arg("--artwork").arg("REMOVE_ALL");
    }

    cmd.arg("--output").arg(&scratch);

    let out = cmd.output().map_err(|e| format!("AtomicParsley: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&scratch);
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(format!(
            "AtomicParsley failed ({}): {}\n{}",
            out.status,
            stderr.trim(),
            stdout.trim()
        ));
    }
    atomicparsley_apply_output(&scratch, video)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_tv_from_frontend_camel_case() {
        let j = r#"{"kind":"tv","showName":"Malcolm","season":1,"episode":14,"episodeTitle":null,"artworkBase64":null}"#;
        let t: EmbeddableTags = serde_json::from_str(j).unwrap();
        assert!(matches!(
            t,
            EmbeddableTags::Tv {
                show_name,
                season: 1,
                episode: 14,
                ..
            } if show_name == "Malcolm"
        ));
    }

    #[test]
    fn serde_movie_roundtrip() {
        let j = r#"{"kind":"movie","title":"Test","year":2020,"artworkBase64":null}"#;
        let t: EmbeddableTags = serde_json::from_str(j).unwrap();
        assert!(matches!(
            t,
            EmbeddableTags::Movie {
                title,
                year: Some(2020),
                ..
            } if title == "Test"
        ));
    }

    #[test]
    fn parse_sxe() {
        let p = parse_episode_from_stem("Show.Name.S01E04.1080p");
        assert!(p.ok);
        assert_eq!(p.season, Some(1));
        assert_eq!(p.episode, Some(4));
    }

    #[test]
    fn parse_1x04() {
        let p = parse_episode_from_stem("Something - 1x04 - Title");
        assert!(p.ok);
        assert_eq!(p.season, Some(1));
        assert_eq!(p.episode, Some(4));
    }

    #[test]
    fn parse_101() {
        let p = parse_episode_from_stem("Show.101.mkv");
        assert!(p.ok);
        assert_eq!(p.season, Some(1));
        assert_eq!(p.episode, Some(1));
    }

    fn file_from_stem(stem: &str) -> AnalyzedFile {
        AnalyzedFile {
            source_path: format!("{}.mkv", stem),
            tree_root: None,
            parse: parse_episode_from_stem(stem),
        }
    }

    #[test]
    fn unparsed_indices_mixed() {
        let files = vec![
            file_from_stem("Show.S01E01"),
            file_from_stem("not_an_episode"),
            file_from_stem("Show.S01E02"),
        ];
        let u = unparsed_indices(&files);
        assert_eq!(u, vec![1]);
    }

    #[test]
    fn unparsed_indices_all_ok() {
        let files = vec![file_from_stem("A.S01E01"), file_from_stem("B.S01E02")];
        assert!(unparsed_indices(&files).is_empty());
    }
}
