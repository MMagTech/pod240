//! Proxy HTTP for MusicBrainz + Cover Art Archive (no CORS in browser; rate limit enforced by caller).

use reqwest::Url;
use serde::Serialize;

const UA: &str = "Pod240/0.1.0 (+https://github.com/MMagTech/pod240)";

fn validate_mb_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("only https".to_string());
    }
    match url.host_str() {
        Some("musicbrainz.org") => {
            if url.path().starts_with("/ws/2/") {
                Ok(())
            } else {
                Err("invalid MusicBrainz path".to_string())
            }
        }
        Some("coverartarchive.org") => {
            if url.path().starts_with("/release/") {
                Ok(())
            } else {
                Err("invalid Cover Art Archive path".to_string())
            }
        }
        _ => Err("host not allowed".to_string()),
    }
}

#[derive(Serialize)]
pub struct BinaryHttpResponse {
    pub data: Vec<u8>,
    pub content_type: Option<String>,
}

#[tauri::command]
pub async fn musicbrainz_http_get(url: String) -> Result<String, String> {
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    validate_mb_url(&parsed)?;

    let client = reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(parsed)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn musicbrainz_fetch_binary(url: String) -> Result<BinaryHttpResponse, String> {
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    validate_mb_url(&parsed)?;

    let client = reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_string());

    let data = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();

    Ok(BinaryHttpResponse {
        data,
        content_type,
    })
}
