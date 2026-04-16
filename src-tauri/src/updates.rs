//! Manual “Check for Updates” against GitHub Releases (invoked from the UI only; no background polling).

use reqwest::Url;
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;

/// `owner/repo` for `GET /repos/{owner}/{repo}/releases/latest`.
const GITHUB_REPO: &str = "MMagTech/pod240";

const USER_AGENT: &str = concat!("Pod240/", env!("CARGO_PKG_VERSION"), " (manual update check)");

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateComparison {
    UpToDate,
    UpdateAvailable,
    NewerThanPublished,
}

#[derive(Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub release_page_url: String,
    pub comparison: UpdateComparison,
}

#[tauri::command]
pub async fn check_for_updates_manual() -> Result<UpdateCheckResult, String> {
    let current_ver = env!("CARGO_PKG_VERSION");

    let api = Url::parse(&format!(
        "https://api.github.com/repos/{}/releases/latest",
        GITHUB_REPO
    ))
    .map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(api)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(
            "No published releases found for this repository (or the repo is private without auth)."
                .into(),
        );
    }
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub API returned HTTP {}. Try again later (rate limits apply to unauthenticated requests).",
            resp.status()
        ));
    }

    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let tag = v["tag_name"]
        .as_str()
        .ok_or_else(|| "Release response missing tag_name.".to_string())?;
    let html_url = v["html_url"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let latest_clean = tag.trim().trim_start_matches('v');

    let cur = semver::Version::parse(current_ver)
        .map_err(|e| format!("Invalid app version in build: {e}"))?;
    let lat = semver::Version::parse(latest_clean)
        .map_err(|e| format!("Could not parse release tag as semver: {e}"))?;

    let comparison = match cur.cmp(&lat) {
        Ordering::Less => UpdateComparison::UpdateAvailable,
        Ordering::Equal => UpdateComparison::UpToDate,
        Ordering::Greater => UpdateComparison::NewerThanPublished,
    };

    Ok(UpdateCheckResult {
        current_version: current_ver.to_string(),
        latest_version: latest_clean.to_string(),
        release_page_url: html_url,
        comparison,
    })
}
