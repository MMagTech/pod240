//! Bundled FFmpeg/ffprobe for music-video frame grabs when the WebView cannot decode the file.
//! Binaries live under `resources/ffmpeg/` (see `resources/ffmpeg/README.txt`).

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::AppHandle;

use crate::resources_root;

fn ffmpeg_exe_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn ffprobe_exe_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ffprobe.exe"
    } else {
        "ffprobe"
    }
}

/// `POD240_FFMPEG` may be a directory containing `ffmpeg` + `ffprobe`, or the full path to `ffmpeg` (parent used as prefix).
fn ffmpeg_resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("POD240_FFMPEG") {
        let pb = PathBuf::from(p.trim());
        if pb.is_file() {
            return pb
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "POD240_FFMPEG: invalid path".to_string());
        }
        if pb.is_dir() {
            return Ok(pb);
        }
    }
    let res = resources_root(app)?;
    let d = res.join("ffmpeg");
    if d.is_dir() {
        return Ok(d);
    }
    Err("Add folder Pod240/resources/ffmpeg with ffmpeg and ffprobe (see README inside).".into())
}

pub(crate) fn find_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = ffmpeg_resource_dir(app)?;
    let exe = dir.join(ffmpeg_exe_name());
    if exe.is_file() {
        return Ok(exe);
    }
    Err(format!(
        "Missing {} in {}",
        ffmpeg_exe_name(),
        dir.display()
    ))
}

pub(crate) fn find_ffprobe(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = ffmpeg_resource_dir(app)?;
    let exe = dir.join(ffprobe_exe_name());
    if exe.is_file() {
        return Ok(exe);
    }
    Err(format!(
        "Missing {} in {}",
        ffprobe_exe_name(),
        dir.display()
    ))
}

#[tauri::command]
pub fn ffmpeg_available(app: AppHandle) -> bool {
    find_ffmpeg(&app).is_ok() && find_ffprobe(&app).is_ok()
}

#[tauri::command]
pub fn ffmpeg_probe_duration(app: AppHandle, source_path: String) -> Result<f64, String> {
    let path = PathBuf::from(source_path.trim());
    if !path.is_file() {
        return Err("File not found.".into());
    }
    let ffprobe = find_ffprobe(&app)?;
    let mut cmd = Command::new(&ffprobe);
    crate::hidden_command::hide_console(&mut cmd);
    let out = cmd
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(&path)
        .output()
        .map_err(|e| format!("ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.trim();
    line.parse::<f64>()
        .map_err(|_| format!("ffprobe: invalid duration {line:?}"))
}

/// One JPEG frame at `time_sec`, scaled to max width 1280 (same cap as canvas path), base64 for AtomicParsley flow.
#[tauri::command]
pub fn ffmpeg_extract_frame_base64(
    app: AppHandle,
    source_path: String,
    time_sec: f64,
) -> Result<String, String> {
    let path = PathBuf::from(source_path.trim());
    if !path.is_file() {
        return Err("File not found.".into());
    }
    let t = if time_sec.is_finite() {
        time_sec.max(0.0)
    } else {
        0.0
    };
    let ffmpeg = find_ffmpeg(&app)?;
    // Simple scale (avoids filter-comma escaping differences across platforms).
    let mut cmd = Command::new(&ffmpeg);
    crate::hidden_command::hide_console(&mut cmd);
    let out = cmd
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-ss")
        .arg(format!("{t:.3}"))
        .arg("-i")
        .arg(&path)
        .arg("-vframes")
        .arg("1")
        .arg("-vf")
        .arg("scale=1280:-2")
        .arg("-f")
        .arg("image2pipe")
        .arg("-vcodec")
        .arg("mjpeg")
        .arg("-")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    if out.stdout.is_empty() {
        return Err("ffmpeg: empty JPEG output".into());
    }
    Ok(B64.encode(&out.stdout))
}
