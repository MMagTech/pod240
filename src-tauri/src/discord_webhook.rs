//! Optional Discord incoming-webhook notifications (POST JSON embeds).

use reqwest::blocking::Client;
use reqwest::Url;
use serde::Serialize;

const UA: &str = "Pod240/0.1.0 (+https://github.com/MMagTech/pod240)";
const ERR_TRUNCATE: usize = 500;

#[derive(Serialize)]
struct DiscordEmbed {
    title: String,
    description: String,
    color: u32,
}

#[derive(Serialize)]
struct DiscordWebhookPayload {
    embeds: [DiscordEmbed; 1],
}

fn discord_hosts(host: &str) -> bool {
    matches!(
        host,
        "discord.com"
            | "discordapp.com"
            | "canary.discord.com"
            | "ptb.discord.com"
    )
}

/// `https://discord.com/api/webhooks/{id}/{token}` (or discordapp.com / canary / ptb).
pub fn validate_discord_webhook_url(raw: &str) -> Result<Url, String> {
    let u = Url::parse(raw.trim()).map_err(|e| e.to_string())?;
    if u.scheme() != "https" {
        return Err("Discord webhook URL must use https://.".into());
    }
    let Some(host) = u.host_str() else {
        return Err("Invalid URL.".into());
    };
    if !discord_hosts(host) {
        return Err(
            "Not a Discord incoming webhook host (use discord.com, discordapp.com, canary, or ptb)."
                .into(),
        );
    }
    let segs: Vec<&str> = u
        .path()
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if segs.len() != 4 || segs[0] != "api" || segs[1] != "webhooks" {
        return Err(
            "Invalid Discord webhook path (expected …/api/webhooks/{id}/{token}).".into(),
        );
    }
    Ok(u)
}

fn discord_embed_color(kind: &str) -> u32 {
    match kind {
        "failure" => 15_158_332,
        "success" => 3_066_993,
        _ => 3_447_003,
    }
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    let n = s.chars().count();
    if n <= max_chars {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

pub fn send_blocking(url: &str, title: &str, body: &str, kind: &str) -> Result<(), String> {
    validate_discord_webhook_url(url)?;
    let client = Client::builder()
        .user_agent(UA)
        .build()
        .map_err(|e| e.to_string())?;
    let payload = DiscordWebhookPayload {
        embeds: [DiscordEmbed {
            title: truncate_chars(title, 256),
            description: truncate_chars(body, 4096),
            color: discord_embed_color(kind),
        }],
    };
    let resp = client
        .post(url)
        .json(&payload)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp
            .text()
            .unwrap_or_default()
            .chars()
            .take(400)
            .collect::<String>();
        let suffix = if detail.is_empty() {
            String::new()
        } else {
            format!(" — {detail}")
        };
        return Err(format!("Discord webhook returned HTTP {status}{suffix}"));
    }
    Ok(())
}

pub fn spawn_notify(url: String, title: String, body: String, kind: &'static str) {
    std::thread::spawn(move || {
        if let Err(e) = send_blocking(&url, &title, &body, kind) {
            eprintln!("Discord notification failed: {e}");
        }
    });
}

pub fn maybe_notify_encode_failed(url: &str, source_path: &str, error: &str) {
    let mut err = error.to_string();
    if err.len() > ERR_TRUNCATE {
        err.truncate(ERR_TRUNCATE);
        err.push_str("…");
    }
    let body = format!("Encode Failed.\n\nFile: {source_path}\n\n{err}");
    let u = url.to_string();
    spawn_notify(
        u,
        "Pod240 — Encode Failed".to_string(),
        body,
        "failure",
    );
}

/// `done` / `failed` / `cancelled` counts for jobs that are no longer pending or encoding.
pub fn maybe_notify_queue_finished(url: &str, done: usize, failed: usize, cancelled: usize) {
    let (body, kind) = queue_finish_body_and_kind(done, failed, cancelled);
    let u = url.to_string();
    spawn_notify(
        u,
        "Pod240 — Queue Complete".to_string(),
        body,
        kind,
    );
}

fn queue_finish_body_and_kind(
    done: usize,
    failed: usize,
    cancelled: usize,
) -> (String, &'static str) {
    match (done, failed, cancelled) {
        (d, 0, 0) if d > 0 => {
            let body = if d == 1 {
                "One Encode Finished Successfully.".to_string()
            } else {
                format!("All {d} Encodes Finished Successfully.")
            };
            (body, "success")
        }
        (0, 0, c) if c > 0 => {
            let body = if c == 1 {
                "One Encode Cancelled.".to_string()
            } else {
                format!("All {c} Encodes Cancelled.")
            };
            (body, "info")
        }
        (0, f, 0) if f > 0 => {
            let body = if f == 1 {
                "Queue Finished: One Encode Failed.".to_string()
            } else {
                format!("Queue Finished: All {f} Encodes Failed.")
            };
            (body, "failure")
        }
        _ => {
            let mut parts: Vec<String> = Vec::new();
            if done > 0 {
                parts.push(format!("{done} Encoded"));
            }
            if failed > 0 {
                parts.push(format!("{failed} Failed"));
            }
            if cancelled > 0 {
                parts.push(format!("{cancelled} Cancelled"));
            }
            let summary = parts.join(", ");
            (format!("Queue Finished: {summary}."), "info")
        }
    }
}
