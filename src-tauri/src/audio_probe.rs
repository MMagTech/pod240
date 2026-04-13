//! HandBrake `--scan --json` parsing for per-file audio track selection.

use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    /// 1-based track index for HandBrake `-a`.
    pub index: u32,
    pub label: String,
}

/// HandBrake may prefix logs or write JSON to stderr; scan output may start mid-stream at `{`.
fn extract_first_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let rest = &s[start..];
    let mut depth = 0i32;
    for (i, b) in rest.as_bytes().iter().enumerate() {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return rest.get(..=i);
                }
            }
            _ => {}
        }
    }
    None
}

pub fn parse_scan_json(json: &str) -> Result<Vec<AudioTrack>, String> {
    let v: Value =
        serde_json::from_str(json.trim()).map_err(|e| format!("Invalid HandBrake JSON: {e}"))?;
    parse_title_audio(&v)
}

/// HandBrake 1.11+ prints a **stream** of JSON objects (`Version:`, `Progress:`, …) before the
/// scan result. The first `{…}` is often `Version`, not `TitleList` — we must walk all objects.
fn try_parse_scan_variants(raw: &str) -> Result<Vec<AudioTrack>, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("empty scan output".into());
    }
    // Classic single-blob scan JSON
    if let Ok(tracks) = parse_scan_json(t) {
        return Ok(tracks);
    }
    let mut rest = t;
    let mut last_err = "no JSON object with TitleList".to_string();
    while let Some(rel) = rest.find('{') {
        rest = &rest[rel..];
        match extract_first_json_object(rest) {
            Some(obj_str) => {
                match serde_json::from_str::<Value>(obj_str.trim()) {
                    Ok(v) => match parse_title_audio(&v) {
                        Ok(tracks) => return Ok(tracks),
                        Err(e) => last_err = e,
                    },
                    Err(e) => last_err = format!("Invalid HandBrake JSON: {e}"),
                }
                rest = &rest[obj_str.len()..];
            }
            None => break,
        }
    }
    Err(last_err)
}

fn parse_title_audio(v: &Value) -> Result<Vec<AudioTrack>, String> {
    let titles = v
        .get("TitleList")
        .and_then(|t| t.as_array())
        .ok_or_else(|| "HandBrake scan: missing TitleList".to_string())?;
    let title0 = titles
        .first()
        .ok_or_else(|| "HandBrake scan: empty TitleList".to_string())?;
    let arr = title0
        .get("AudioList")
        .and_then(|a| a.as_array())
        .ok_or_else(|| "HandBrake scan: missing AudioList".to_string())?;
    let mut out = Vec::new();
    for (i, a) in arr.iter().enumerate() {
        let idx = a
            .get("TrackNumber")
            .and_then(|x| x.as_u64())
            .map(|n| n as u32)
            .or_else(|| {
                a.get("Index")
                    .and_then(|x| x.as_u64())
                    .map(|n| n as u32)
            })
            .unwrap_or((i + 1) as u32);
        let lang = a
            .get("Language")
            .and_then(|x| x.as_str())
            .unwrap_or("Audio");
        let codec = a.get("CodecName").and_then(|x| x.as_str()).unwrap_or("");
        let ch = a
            .get("ChannelLayoutName")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| a.get("ChannelLayout").and_then(|x| x.as_str()))
            .unwrap_or("");
        // HandBrake often includes a distinct stream title (TrueHD vs DD compatibility, commentary, etc.).
        let name = a.get("Name").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty());
        let label = if let Some(n) = name {
            n.to_string()
        } else {
            let mut s = lang.to_string();
            if !codec.is_empty() {
                s.push_str(" (");
                s.push_str(codec);
                s.push(')');
            }
            if !ch.is_empty() {
                s.push_str(" ");
                s.push_str(ch);
            }
            s
        };
        out.push(AudioTrack { index: idx, label });
    }
    if out.is_empty() {
        return Err("HandBrake scan: no audio tracks".into());
    }
    Ok(out)
}

pub fn probe_source_audio(
    hb_exe: &Path,
    workdir: &Path,
    source: &Path,
) -> Result<Vec<AudioTrack>, String> {
    let out = Command::new(hb_exe)
        .current_dir(workdir)
        .arg("-i")
        .arg(source)
        .arg("--scan")
        .arg("--json")
        .output()
        .map_err(|e| format!("HandBrake scan spawn: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let combined = format!("{stdout}\n{stderr}");

    let attempts: &[&str] = &[
        stdout.as_ref(),
        stderr.as_ref(),
        combined.as_str(),
    ];

    let mut last_err = String::new();
    for raw in attempts {
        match try_parse_scan_variants(raw) {
            Ok(tracks) => return Ok(tracks),
            Err(e) => last_err = e,
        }
    }

    if !out.status.success() {
        return Err(format!(
            "HandBrake --scan failed (exit {}): {}\n--- stdout (first 800 chars) ---\n{}\n--- stderr (first 800 chars) ---\n{}",
            out.status,
            last_err,
            trim_snippet(&stdout, 800),
            trim_snippet(&stderr, 800),
        ));
    }

    Err(format!(
        "HandBrake --scan produced no parseable JSON ({}). Try updating HandBrakeCLI or set POD240_HANDBRAKE_CLI.\n--- stdout (first 800 chars) ---\n{}\n--- stderr (first 800 chars) ---\n{}",
        last_err,
        trim_snippet(&stdout, 800),
        trim_snippet(&stderr, 800),
    ))
}

fn trim_snippet(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.len() <= max {
        return t.to_string();
    }
    let mut end = max;
    while end > 0 && !t.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &t[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_scan() {
        let j = r#"{"TitleList":[{"AudioList":[
          {"TrackNumber":1,"Language":"English","CodecName":"aac","ChannelLayoutName":"stereo"},
          {"TrackNumber":2,"Language":"Japanese","CodecName":"ac3","ChannelLayoutName":"5.1"}
        ]}]}"#;
        let t = parse_scan_json(j).unwrap();
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].index, 1);
        assert_eq!(t[1].index, 2);
    }

    #[test]
    fn prefers_handbrake_name_when_present() {
        let j = r#"{"TitleList":[{"AudioList":[
          {"TrackNumber":1,"Language":"English","CodecName":"aac","ChannelLayout":"5.1","Name":"Dolby TrueHD / 5.1"},
          {"TrackNumber":2,"Language":"English","CodecName":"aac","ChannelLayout":"5.1","Name":"Compatibility DD 5.1"}
        ]}]}"#;
        let t = parse_scan_json(j).unwrap();
        assert_eq!(t[0].label, "Dolby TrueHD / 5.1");
        assert_eq!(t[1].label, "Compatibility DD 5.1");
    }

    #[test]
    fn channel_layout_fallback_without_channel_layout_name() {
        let j = r#"{"TitleList":[{"AudioList":[
          {"TrackNumber":1,"Language":"English","CodecName":"aac","ChannelLayout":"stereo"}
        ]}]}"#;
        let t = parse_scan_json(j).unwrap();
        assert_eq!(t[0].label, "English (aac) stereo");
    }

    #[test]
    fn parses_scan_after_log_preamble() {
        let noisy = "[00:00:00] libhb: init\n{\"TitleList\":[{\"AudioList\":[{\"TrackNumber\":1,\"Language\":\"English\",\"CodecName\":\"aac\",\"ChannelLayoutName\":\"stereo\"}]}]}";
        let t = try_parse_scan_variants(noisy).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].index, 1);
    }

    #[test]
    fn parses_handbrake_111_version_progress_then_titlelist() {
        let stream = concat!(
            "Version: {\"Arch\":\"x86_64\",\"Name\":\"HandBrake\",\"VersionString\":\"1.11.1\"}\n",
            "Progress: {\"Scanning\":{\"Progress\":0.5,\"TitleCount\":1}}\n",
            "{\"TitleList\":[{\"AudioList\":[{\"TrackNumber\":1,\"Language\":\"English\",\"CodecName\":\"aac\",\"ChannelLayoutName\":\"stereo\"}]}]}"
        );
        let t = try_parse_scan_variants(stream).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].index, 1);
    }
}
