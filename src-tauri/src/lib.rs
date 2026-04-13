mod audio_probe;
mod embedded_artwork;
mod tagging;

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub use tagging::{AnalyzeResult, AnalyzedFile, EmbeddableTags, EpisodeParseInfo, SeasonGroupPreview};

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum JobStatus {
    Pending,
    Encoding,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Serialize)]
struct Job {
    id: String,
    source_path: String,
    /// Set when this job came from scanning a **folder**; used to mirror that layout under the default output dir.
    tree_root: Option<String>,
    /// iTunes metadata applied after encode via AtomicParsley. `None` = skip tagging.
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<EmbeddableTags>,
    /// HandBrake 1-based audio source track (`-a`). `None` = HandBrake default (first track).
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_track: Option<u32>,
    status: JobStatus,
    progress: Option<f32>,
    error: Option<String>,
}

#[derive(Serialize)]
struct EnqueueResult {
    added: usize,
    skipped_duplicates: usize,
}

#[derive(Serialize, serde::Deserialize, Default, Clone)]
struct Settings {
    default_output_dir: Option<String>,
    /// The Movie Database API key (optional; for poster search in the UI).
    #[serde(default)]
    tmdb_api_key: Option<String>,
}

struct AppInner {
    jobs: Vec<Job>,
    current_child: Arc<Mutex<Option<std::process::Child>>>,
    cancel_requested: bool,
}

#[derive(Clone)]
pub struct AppState(Arc<Mutex<AppInner>>);

impl Default for AppState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(AppInner {
            jobs: Vec::new(),
            current_child: Arc::new(Mutex::new(None)),
            cancel_requested: false,
        })))
    }
}

fn settings_path() -> PathBuf {
    let mut p = std::env::current_exe()
        .expect("current_exe")
        .parent()
        .expect("exe parent")
        .to_path_buf();
    p.push("pod240-settings.json");
    p
}

fn load_settings() -> Settings {
    let path = settings_path();
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(s) = serde_json::from_slice(&bytes) {
            return s;
        }
    }
    Settings::default()
}

fn save_settings(settings: &Settings) -> Result<(), String> {
    let path = settings_path();
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// `presets/` and `handbrake/` live under this folder.
/// In **debug** (`tauri dev`), prefer `src-tauri/resources` so files you drop there are found
/// immediately. `resource_dir()` points at `target/debug/resources`, which may lag or miss files
/// until a full rebuild.
pub(crate) fn resources_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        if dev.is_dir() {
            return Ok(dev);
        }
    }
    app.path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))
}

/// Looks for `HandBrakeCLI.exe` (exact) or any `*HandBrakeCLI*.exe` in the folder (Windows).
fn find_handbrake_executable(hb_dir: &Path) -> Option<PathBuf> {
    let exact = if cfg!(windows) {
        hb_dir.join("HandBrakeCLI.exe")
    } else {
        hb_dir.join("HandBrakeCLI")
    };
    if exact.exists() {
        return Some(exact);
    }
    if !cfg!(windows) {
        return None;
    }
    let entries = std::fs::read_dir(hb_dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        let name = p.file_name()?.to_str()?.to_lowercase();
        if !name.ends_with(".exe") {
            continue;
        }
        if name.contains("handbrakecli") {
            return Some(p);
        }
    }
    None
}

pub(crate) fn handbrake_cli_and_workdir(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    if let Ok(p) = std::env::var("POD240_HANDBRAKE_CLI") {
        let pb = PathBuf::from(p.trim());
        if pb.exists() {
            let workdir = pb
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."));
            return Ok((pb, workdir));
        }
    }

    let res = resources_root(app)?;
    let hb_dir = res.join("handbrake");
    if !hb_dir.is_dir() {
        return Err(format!(
            "Create folder and add HandBrakeCLI: {}",
            hb_dir.display()
        ));
    }

    if let Some(hb) = find_handbrake_executable(&hb_dir) {
        let workdir = hb.parent().unwrap_or(&hb_dir).to_path_buf();
        return Ok((hb, workdir));
    }

    let listing = std::fs::read_dir(&hb_dir)
        .ok()
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|s| !s.is_empty())
        .map(|s| format!(" (currently in that folder: {s})"))
        .unwrap_or_default();

    Err(format!(
        "No HandBrakeCLI.exe in {}{}. Copy HandBrakeCLI.exe and hb.dll from your HandBrake install into this folder, or set POD240_HANDBRAKE_CLI to the full path of HandBrakeCLI.exe.",
        hb_dir.display(),
        listing
    ))
}

fn preset_paths(app: &AppHandle) -> Result<(PathBuf, String), String> {
    let res = resources_root(app)?;
    let (file_name, preset_z) = if cfg!(windows) {
        (
            "Apple 240p30 (Olsro) (Windows).json",
            "Apple 240p30 (Olsro) (Windows)",
        )
    } else {
        (
            "Apple 240p30 (Olsro) (MacOS).json",
            "Apple 240p30 (Olsro) (MacOS)",
        )
    };
    let path = res.join("presets").join(file_name);
    if !path.exists() {
        return Err(format!("Preset missing: {}", path.display()));
    }
    Ok((path, preset_z.to_string()))
}

/// Prefer `{stem}.mp4`. Use `{stem}_ipod240p.mp4`, then `{stem}_ipod240p_2.mp4`, … only when the plain name
/// would be the same path as the source (unsafe for encode) or another file already exists there.
fn resolve_mp4_output_path(source: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".into());

    for attempt in 0u32..1000 {
        let filename = match attempt {
            0 => format!("{stem}.mp4"),
            1 => format!("{stem}_ipod240p.mp4"),
            n => format!("{stem}_ipod240p_{n}.mp4"),
        };
        let candidate = dest_dir.join(&filename);
        if output_name_is_available(source, &candidate)? {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Could not find a free .mp4 name in {}",
        dest_dir.display()
    ))
}

fn resolved_path_for_compare(p: &Path) -> Option<PathBuf> {
    if p.exists() {
        return p.canonicalize().ok();
    }
    let parent = p.parent()?;
    let name = p.file_name()?;
    let pdir = parent.canonicalize().ok()?;
    Some(pdir.join(name))
}

fn paths_same_output_target(a: &Path, b: &Path) -> bool {
    match (resolved_path_for_compare(a), resolved_path_for_compare(b)) {
        (Some(x), Some(y)) => paths_equal_os(x.as_path(), y.as_path()),
        _ => a == b,
    }
}

#[cfg(windows)]
fn paths_equal_os(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
fn paths_equal_os(a: &Path, b: &Path) -> bool {
    a == b
}

/// True if `candidate` is safe to create as HandBrake output (not same file as source; name not taken).
fn output_name_is_available(source: &Path, candidate: &Path) -> Result<bool, String> {
    if paths_same_output_target(source, candidate) {
        return Ok(false);
    }
    if candidate.exists() {
        return Ok(false);
    }
    Ok(true)
}

/// Single-file jobs (`tree_root` None): output next to the source, or flat under `default_out` if set.
/// Folder jobs (`tree_root` Some): under `default_out`, mirror the dropped folder’s name plus paths inside it
/// (e.g. `Out/MyShow/Season 1/…`); if no default output, files stay next to each source on disk.
fn output_path_for_job(
    source: &Path,
    tree_root: Option<&Path>,
    default_out: Option<&Path>,
) -> Result<PathBuf, String> {
    let dest_dir = match (tree_root, default_out) {
        (None, None) => source
            .parent()
            .ok_or_else(|| format!("No parent directory: {}", source.display()))?
            .to_path_buf(),
        (None, Some(d)) => d.to_path_buf(),
        (Some(_root), None) => source
            .parent()
            .ok_or_else(|| format!("No parent directory: {}", source.display()))?
            .to_path_buf(),
        (Some(root), Some(d)) => {
            let source_canon = source.canonicalize().map_err(|e| {
                format!("Could not resolve source path {}: {e}", source.display())
            })?;
            let root_canon = root.canonicalize().map_err(|e| {
                format!("Could not resolve folder root {}: {e}", root.display())
            })?;
            let root_label = root_canon
                .file_name()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("show"));
            let rel = source_canon.strip_prefix(&root_canon).map_err(|_| {
                format!(
                    "Source {} is not under folder {}",
                    source.display(),
                    root.display()
                )
            })?;
            let subdir = rel
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new(""));
            d.join(root_label).join(subdir)
        }
    };
    resolve_mp4_output_path(source, &dest_dir)
}

fn canonical_key(path: &str) -> String {
    Path::new(path)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_lowercase())
        .unwrap_or_else(|_| path.to_lowercase())
}

fn audio_track_lookup(map: &HashMap<String, u32>, source_path: &str) -> Option<u32> {
    map.get(source_path)
        .copied()
        .or_else(|| {
            let want = canonical_key(source_path);
            map.iter()
                .find(|(k, _)| canonical_key(k) == want)
                .map(|(_, &v)| v)
        })
}

fn video_extensions() -> &'static [&'static str] {
    &[
        "mkv", "mp4", "m4v", "avi", "mov", "webm", "mpeg", "mpg", "wmv", "flv", "m2ts", "ts",
    ]
}

fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_lowercase();
            video_extensions().iter().any(|&ext| ext == e)
        })
        .unwrap_or(false)
}

/// Recursively collect video files under `dir` (e.g. TV show / Season N / *.mkv).
fn collect_videos_recursive(dir: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let mut out = Vec::new();
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), std::io::Error> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out)?;
            } else if path.is_file() && is_video_file(&path) {
                out.push(path);
            }
        }
        Ok(())
    }
    walk(dir, &mut out)?;
    out.sort();
    Ok(out)
}

struct EnqueuedVideo {
    source_path: String,
    /// `Some` when the user added a **folder** (drag or dialog); encodes preserve paths under the default output directory.
    tree_root: Option<String>,
}

/// Turn dropped paths into video jobs (directories are scanned recursively; each file remembers its folder root).
fn expand_input_paths(paths: Vec<String>) -> Result<Vec<EnqueuedVideo>, String> {
    let mut flat: Vec<EnqueuedVideo> = Vec::new();
    for p in paths {
        let pb = PathBuf::from(p.trim());
        if !pb.exists() {
            continue;
        }
        if pb.is_dir() {
            let root_str = pb
                .canonicalize()
                .map_err(|e| format!("Could not read folder {}: {e}", pb.display()))?
                .to_string_lossy()
                .to_string();
            let files = collect_videos_recursive(&pb)
                .map_err(|e| format!("Could not read folder {}: {e}", pb.display()))?;
            for f in files {
                flat.push(EnqueuedVideo {
                    source_path: f.to_string_lossy().to_string(),
                    tree_root: Some(root_str.clone()),
                });
            }
        } else if pb.is_file() && is_video_file(&pb) {
            flat.push(EnqueuedVideo {
                source_path: pb.to_string_lossy().to_string(),
                tree_root: None,
            });
        }
    }
    Ok(flat)
}

fn emit_queue(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let jobs: Vec<Job> = state.0.lock().map_err(|e| e.to_string())?.jobs.clone();
    app.emit("queue-changed", jobs).map_err(|e| e.to_string())
}

#[tauri::command]
fn probe_handbrake(app: AppHandle) -> Result<serde_json::Value, String> {
    match handbrake_cli_and_workdir(&app) {
        Ok((pb, _)) => Ok(serde_json::json!({
            "ok": true,
            "message": format!("Using {}", pb.display())
        })),
        Err(e) => Ok(serde_json::json!({
            "ok": false,
            "message": e
        })),
    }
}

#[tauri::command]
fn get_queue(state: State<'_, AppState>) -> Result<Vec<Job>, String> {
    let g = state.0.lock().map_err(|e| e.to_string())?;
    Ok(g.jobs.clone())
}

#[tauri::command]
fn get_settings() -> Result<Settings, String> {
    Ok(load_settings())
}

#[tauri::command]
fn set_default_output_dir(path: Option<String>) -> Result<(), String> {
    let mut s = load_settings();
    s.default_output_dir = path;
    save_settings(&s)
}

#[tauri::command]
fn set_tmdb_api_key(key: Option<String>) -> Result<(), String> {
    let mut s = load_settings();
    s.tmdb_api_key = key;
    save_settings(&s)
}

#[tauri::command]
fn analyze_inputs(paths: Vec<String>) -> Result<AnalyzeResult, String> {
    let expanded = expand_input_paths(paths)?;
    let files: Vec<AnalyzedFile> = expanded
        .into_iter()
        .map(|ev| {
            let pb = Path::new(&ev.source_path);
            let stem = pb
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let parse = tagging::parse_episode_from_stem(stem);
            AnalyzedFile {
                source_path: ev.source_path,
                tree_root: ev.tree_root,
                parse,
            }
        })
        .collect();
    let suggest_batch_tv = tagging::analyze_majority_tv(&files);
    let season_groups = tagging::build_season_groups(&files);
    let unparsed_file_indices = tagging::unparsed_indices(&files);
    Ok(AnalyzeResult {
        files,
        suggest_batch_tv,
        season_groups,
        unparsed_file_indices,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueTaggedItem {
    source_path: String,
    tree_root: Option<String>,
    tags: EmbeddableTags,
    #[serde(default)]
    audio_track: Option<u32>,
}

#[tauri::command]
fn enqueue_with_tags(
    app: AppHandle,
    state: State<'_, AppState>,
    items: Vec<EnqueueTaggedItem>,
) -> Result<EnqueueResult, String> {
    let settings = load_settings();
    let default_out = settings
        .default_output_dir
        .as_ref()
        .map(PathBuf::from);

    let mut added = 0usize;
    let mut skipped = 0usize;

    {
        let mut g = state.0.lock().map_err(|e| e.to_string())?;
        let mut seen: HashSet<String> = g
            .jobs
            .iter()
            .map(|j| canonical_key(&j.source_path))
            .collect();

        for item in items {
            let key = canonical_key(&item.source_path);
            if seen.contains(&key) {
                skipped += 1;
                continue;
            }
            seen.insert(key.clone());
            if !Path::new(&item.source_path).exists() {
                continue;
            }
            if !is_video_file(Path::new(&item.source_path)) {
                continue;
            }
            let tags = match &item.tags {
                EmbeddableTags::Skip => None,
                t => Some(t.clone()),
            };
            g.jobs.push(Job {
                id: uuid::Uuid::new_v4().to_string(),
                source_path: item.source_path,
                tree_root: item.tree_root,
                tags,
                audio_track: item.audio_track,
                status: JobStatus::Pending,
                progress: None,
                error: None,
            });
            added += 1;
        }
    }

    emit_queue(&app, state.deref())?;
    try_start_next_job(app, state.deref().clone(), default_out)?;
    Ok(EnqueueResult {
        added,
        skipped_duplicates: skipped,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueRequest {
    paths: Vec<String>,
    #[serde(default)]
    audio_tracks: Option<HashMap<String, u32>>,
}

#[tauri::command]
fn probe_source_audio(app: AppHandle, path: String) -> Result<Vec<audio_probe::AudioTrack>, String> {
    let pb = PathBuf::from(path.trim());
    if !pb.is_file() {
        return Err("Not a file or path missing".into());
    }
    let (hb, wd) = handbrake_cli_and_workdir(&app)?;
    audio_probe::probe_source_audio(&hb, &wd, &pb)
}

#[tauri::command]
fn probe_atomicparsley(app: AppHandle) -> Result<serde_json::Value, String> {
    match tagging::find_atomicparsley_executable(&app) {
        Ok(pb) => Ok(serde_json::json!({
            "ok": true,
            "message": format!("Using {}", pb.display())
        })),
        Err(e) => Ok(serde_json::json!({
            "ok": false,
            "message": e
        })),
    }
}

#[tauri::command]
fn probe_embedded_artwork(source_path: String) -> Result<embedded_artwork::EmbeddedArtworkProbe, String> {
    let p = PathBuf::from(source_path.trim());
    if !p.is_file() {
        return Err("Not a file.".into());
    }
    Ok(embedded_artwork::probe(&p))
}

/// Strips all `covr` atoms in place (requires AtomicParsley).
#[tauri::command]
fn strip_embedded_artwork_from_file(app: AppHandle, source_path: String) -> Result<(), String> {
    let p = PathBuf::from(source_path.trim());
    if !p.is_file() {
        return Err("Not a file.".into());
    }
    let exe = tagging::find_atomicparsley_executable(&app)?;
    tagging::strip_embedded_artwork_atoms(&exe, &p)
}

/// Removes every job except one that is **encoding** (the active encode is left running).
/// Pending, done, failed, and cancelled rows are removed — so a lone cancelled job after “Cancel Current” can be cleared.
#[tauri::command]
fn clear_pending_jobs(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let removed = {
        let mut g = state.0.lock().map_err(|e| e.to_string())?;
        let before = g.jobs.len();
        g.jobs.retain(|j| matches!(j.status, JobStatus::Encoding));
        before - g.jobs.len()
    };
    emit_queue(&app, state.deref())?;
    Ok(removed)
}

#[tauri::command]
fn remove_job(app: AppHandle, state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    {
        let mut g = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(j) = g.jobs.iter().find(|j| j.id == job_id) {
            if !matches!(j.status, JobStatus::Pending) {
                return Err("Only pending jobs can be removed".into());
            }
        } else {
            return Err("Job not found".into());
        }
        g.jobs
            .retain(|j| !(j.id == job_id && matches!(j.status, JobStatus::Pending)));
    }
    emit_queue(&app, state.deref())
}

/// Replaces the queue order with `job_ids` (must be a permutation of current job ids).
#[tauri::command]
fn reorder_queue(
    app: AppHandle,
    state: State<'_, AppState>,
    job_ids: Vec<String>,
) -> Result<(), String> {
    let mut g = state.0.lock().map_err(|e| e.to_string())?;
    if job_ids.len() != g.jobs.len() {
        return Err("Reorder list length does not match queue.".into());
    }
    let mut by_id: HashMap<String, Job> = g
        .jobs
        .iter()
        .cloned()
        .map(|j| (j.id.clone(), j))
        .collect();
    if by_id.len() != g.jobs.len() {
        return Err("Duplicate job ids in queue.".into());
    }
    let mut next = Vec::with_capacity(job_ids.len());
    for id in job_ids {
        let job = by_id
            .remove(&id)
            .ok_or_else(|| format!("Unknown job id in reorder: {id}"))?;
        next.push(job);
    }
    if !by_id.is_empty() {
        return Err("Reorder list did not include all jobs.".into());
    }
    g.jobs = next;
    drop(g);
    emit_queue(&app, &state)?;
    Ok(())
}

#[tauri::command]
fn cancel_current(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let child_slot = {
        let mut g = state.0.lock().map_err(|e| e.to_string())?;
        g.cancel_requested = true;
        g.current_child.clone()
    };
    if let Ok(mut slot) = child_slot.lock() {
        if let Some(ref mut c) = *slot {
            let _ = c.kill();
        }
    }
    emit_queue(&app, state.deref())?;
    Ok(())
}

#[tauri::command]
fn enqueue(app: AppHandle, state: State<'_, AppState>, req: EnqueueRequest) -> Result<EnqueueResult, String> {
    let settings = load_settings();
    let default_out = settings
        .default_output_dir
        .as_ref()
        .map(PathBuf::from);

    let flat_paths = expand_input_paths(req.paths)?;
    let audio = req.audio_tracks.as_ref();

    let mut added = 0usize;
    let mut skipped = 0usize;

    {
        let mut g = state.0.lock().map_err(|e| e.to_string())?;
        let mut seen: HashSet<String> = g
            .jobs
            .iter()
            .map(|j| canonical_key(&j.source_path))
            .collect();

        for item in flat_paths {
            let key = canonical_key(&item.source_path);
            if seen.contains(&key) {
                skipped += 1;
                continue;
            }
            seen.insert(key.clone());
            if !Path::new(&item.source_path).exists() {
                continue;
            }
            let audio_track = audio.and_then(|m| audio_track_lookup(m, &item.source_path));
            g.jobs.push(Job {
                id: uuid::Uuid::new_v4().to_string(),
                source_path: item.source_path,
                tree_root: item.tree_root,
                tags: None,
                audio_track,
                status: JobStatus::Pending,
                progress: None,
                error: None,
            });
            added += 1;
        }
    }

    emit_queue(&app, state.deref())?;
    try_start_next_job(app, state.deref().clone(), default_out)?;
    Ok(EnqueueResult {
        added,
        skipped_duplicates: skipped,
    })
}

fn try_start_next_job(
    app: AppHandle,
    state: AppState,
    default_out: Option<PathBuf>,
) -> Result<(), String> {
    let job_opt: Option<Job> = {
        let mut g = state.0.lock().map_err(|e| e.to_string())?;
        if g
            .jobs
            .iter()
            .any(|j| matches!(j.status, JobStatus::Encoding))
        {
            return Ok(());
        }
        let idx = g
            .jobs
            .iter()
            .position(|j| matches!(j.status, JobStatus::Pending));
        let Some(i) = idx else {
            return Ok(());
        };
        g.jobs[i].status = JobStatus::Encoding;
        g.jobs[i].progress = Some(0.0);
        g.cancel_requested = false;
        Some(g.jobs[i].clone())
    };

    let Some(job) = job_opt else {
        return Ok(());
    };

    emit_queue(&app, &state)?;

    let app2 = app.clone();
    let state2 = state.clone();
    thread::spawn(move || {
        run_one_job(app2, state2, job, default_out);
    });

    Ok(())
}

fn update_job(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    update: impl FnOnce(&mut Job),
) -> Result<(), String> {
    let mut g = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(j) = g.jobs.iter_mut().find(|j| j.id == job_id) {
        update(j);
    }
    drop(g);
    emit_queue(app, state)
}


fn finish_encoding_attempt(
    app: AppHandle,
    state: AppState,
    job_id: String,
    default_out_next: Option<PathBuf>,
    result: Result<(), String>,
) {
    let cancelled = state
        .0
        .lock()
        .map(|g| g.cancel_requested)
        .unwrap_or(false);

    let _ = {
        let mut g = match state.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        g.cancel_requested = false;
        if let Ok(mut slot) = g.current_child.lock() {
            *slot = None;
        }
        if let Some(j) = g.jobs.iter_mut().find(|j| j.id == job_id) {
            if cancelled {
                j.status = JobStatus::Cancelled;
                j.progress = None;
                j.error = None;
            } else {
                match result {
                    Ok(()) => {
                        j.status = JobStatus::Done;
                        j.progress = None;
                        j.error = None;
                    }
                    Err(e) => {
                        if e == "cancelled" {
                            j.status = JobStatus::Cancelled;
                            j.progress = None;
                            j.error = None;
                        } else {
                            j.status = JobStatus::Failed;
                            j.progress = None;
                            j.error = Some(e);
                        }
                    }
                }
            }
        }
    };

    let _ = emit_queue(&app, &state);
    let _ = try_start_next_job(app.clone(), state.clone(), default_out_next);
}

/// HandBrakeCLI prints encoding progress on **stdout**, using `\r` to redraw one line (not
/// newline-terminated). Reading stderr line-by-line misses it entirely.
fn pump_handbrake_stdout_progress<R: Read>(
    mut reader: R,
    re: &Regex,
    mut on_pct: impl FnMut(f32),
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<(), std::io::Error> {
    let mut chunk = [0u8; 8192];
    let mut carry = String::new();
    loop {
        if is_cancelled() {
            break;
        }
        let n = reader.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        carry.push_str(&String::from_utf8_lossy(&chunk[..n]));
        loop {
            let at = carry.find(|c: char| c == '\r' || c == '\n');
            if let Some(pos) = at {
                let segment = carry[..pos].to_string();
                carry = carry[pos + 1..].to_string();
                if let Some(caps) = re.captures(&segment) {
                    if let Ok(pct) = caps[1].parse::<f32>() {
                        on_pct(pct.min(100.0));
                    }
                }
            } else {
                break;
            }
        }
        if carry.len() > 64 * 1024 {
            let tail: String = carry.chars().rev().take(4096).collect::<String>().chars().rev().collect();
            carry = tail;
        }
    }
    if !carry.is_empty() {
        if let Some(caps) = re.captures(&carry) {
            if let Ok(pct) = caps[1].parse::<f32>() {
                on_pct(pct.min(100.0));
            }
        }
    }
    Ok(())
}

fn run_one_job(app: AppHandle, state: AppState, job: Job, default_out: Option<PathBuf>) {
    // Match e.g. "12.34 %" or "12 %" inside the Encoding status line
    let re = Regex::new(r"(?i)(\d+(?:\.\d+)?)\s*%").unwrap();
    let job_id = job.id.clone();

    let work = (|| -> Result<(), String> {
        let (hb_exe, workdir) = handbrake_cli_and_workdir(&app)?;
        let (preset_file, preset_z) = preset_paths(&app)?;
        let source = PathBuf::from(&job.source_path);
        let tree = job.tree_root.as_ref().map(PathBuf::from);
        let out = output_path_for_job(
            &source,
            tree.as_ref().map(|p| p.as_path()),
            default_out.as_ref().map(|p| p.as_path()),
        )?;

        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        // Match standalone HandBrake: preset JSON carries container (`FileFormat`), encoders, and all tunables.
        let mut cmd = Command::new(&hb_exe);
        cmd.current_dir(&workdir)
            .arg("--preset-import-file")
            .arg(&preset_file)
            .arg("-Z")
            .arg(&preset_z)
            .arg("-i")
            .arg(&source);
        if let Some(a) = job.audio_track {
            if a >= 1 {
                cmd.arg("-a").arg(format!("{a}"));
            }
        }
        // Preset asks for stereo, but 5.1 sources can still encode as multichannel AAC; iPod won't play that.
        // Explicit mixdown matches Olsro intent and avoids silent playback on device.
        cmd.arg("--mixdown").arg("stereo");
        cmd.arg("-o")
            .arg(&out)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("spawn HandBrakeCLI: {e}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "HandBrakeCLI stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "HandBrakeCLI stderr".to_string())?;

        let slot = {
            let g = state.0.lock().map_err(|e| e.to_string())?;
            g.current_child.clone()
        };
        {
            let mut s = slot.lock().map_err(|_| "child lock".to_string())?;
            *s = Some(child);
        }

        let _drain_stderr = thread::spawn(move || {
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
        });

        let last_emit = Cell::new(-1f32);
        let app_progress = app.clone();
        let state_progress = state.clone();
        let jid_progress = job_id.clone();

        let state_cancel = state_progress.clone();
        pump_handbrake_stdout_progress(
            stdout,
            &re,
            |pct| {
                let prev = last_emit.get();
                if (pct - prev).abs() < 0.15 && pct < 99.5 {
                    return;
                }
                last_emit.set(pct);
                let app2 = app_progress.clone();
                let st2 = state_progress.clone();
                let id = jid_progress.clone();
                let _ = update_job(&app2, &st2, &id, |j| {
                    j.progress = Some(pct);
                });
            },
            || {
                state_cancel
                    .0
                    .lock()
                    .map(|g| g.cancel_requested)
                    .unwrap_or(false)
            },
        )
        .map_err(|e| e.to_string())?;

        let _ = _drain_stderr.join();

        let status = {
            let mut s = slot.lock().map_err(|_| "child lock".to_string())?;
            s.take()
                .ok_or_else(|| "lost child".to_string())?
                .wait()
                .map_err(|e| e.to_string())?
        };

        if !status.success() {
            return Err(format!(
                "HandBrake exited with code {:?}",
                status.code()
            ));
        }

        if let Some(ref tags) = job.tags {
            let exe = tagging::find_atomicparsley_executable(&app)?;
            let art_temp: Option<tempfile::NamedTempFile> =
                if let Some(b64) = tagging::artwork_base64_from_tags(tags) {
                    let f = tempfile::Builder::new()
                        .suffix(".jpg")
                        .tempfile()
                        .map_err(|e| e.to_string())?;
                    tagging::artwork_base64_to_temp_jpeg(b64, f.path())?;
                    Some(f)
                } else {
                    None
                };
            let art = art_temp.as_ref().map(|f| f.path());
            tagging::run_atomicparsley(&exe, &out, tags, art)?;
        }

        Ok(())
    })();

    let next_default = load_settings().default_output_dir.map(PathBuf::from);
    finish_encoding_attempt(app, state, job_id, next_default, work);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            probe_handbrake,
            probe_atomicparsley,
            probe_embedded_artwork,
            strip_embedded_artwork_from_file,
            get_queue,
            get_settings,
            set_default_output_dir,
            set_tmdb_api_key,
            analyze_inputs,
            probe_source_audio,
            enqueue,
            enqueue_with_tags,
            remove_job,
            reorder_queue,
            clear_pending_jobs,
            cancel_current,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>().deref().clone();
            if let Err(e) = emit_queue(&handle, &state) {
                eprintln!("emit initial queue: {e}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Pod240");
}
