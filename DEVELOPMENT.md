# Development

Pod240 is a **Tauri 2** desktop app. This document is for **building from source** and **publishing releases**. End-user information is in [README.md](README.md).

## Requirements

1. **Rust** (e.g. [rustup](https://rustup.rs/)) and **Node.js** (use a current **LTS** release; **18+** is fine).
2. **HandBrake CLI** and **AtomicParsley** for a working encode + tagging pipeline.

   **Easiest (recommended):** download third-party CLIs into `src-tauri/resources/` automatically:

   ```bash
   npm run vendor:release
   ```

   Versions are pinned in [`scripts/third-party.json`](scripts/third-party.json). This matches what **GitHub Actions** runs before release builds.

   **Or** copy `HandBrakeCLI` and required libraries into `src-tauri/resources/handbrake/` and the AtomicParsley binary into `src-tauri/resources/atomicparsley/` (see the `README.txt` files there), **or** set `POD240_HANDBRAKE_CLI` / `POD240_ATOMICPARSLEY` to full paths.

   HandBrake is **GPLv2** — see [THIRD_PARTY.md](THIRD_PARTY.md).

3. **FFmpeg** and **ffprobe** for music-video frame preview: keep them in **`src-tauri/resources/ffmpeg/`** (same layout as shipped **`resources/ffmpeg`**). They are **bundled with release builds** when present and **committed for Windows** in this repo; `npm run vendor:release` does **not** download them—copy from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) / [evermeet.cx](https://evermeet.cx/ffmpeg/) per [`resources/ffmpeg/README.txt`](src-tauri/resources/ffmpeg/README.txt) if your checkout is missing them (e.g. macOS CI). Override at runtime with **`POD240_FFMPEG`** if needed. License: see [THIRD_PARTY.md](THIRD_PARTY.md).

## Settings file (development)

End-user preferences live in **`pod240-settings.json`** next to the built executable (same as in [README.md](README.md)). The JSON may include:

| Field | Meaning |
| --- | --- |
| `default_output_dir` | Optional default folder for converted files. |
| `tmdb_api_key` | Optional TMDB key for artwork/metadata search. |
| `apprise_notify_url` | Optional Discord **incoming webhook** URL (`https://discord.com/api/webhooks/…`). |
| `apprise_notify_on_queue_done` | When `true`, send a Discord message when the queue becomes empty after work. |
| `apprise_notify_on_encode_failed` | When `true`, send a Discord message when an encode fails. |

Configure Discord webhooks in the app via **Menu → Notification** (no separate Apprise server; the field name is historical).

## Run in development

```bash
npm install
npm run tauri:dev
```

Use **`npm run tauri:dev`** (not `npm run tauri dev`) on Windows if you see `cargo metadata` / `program not found`: it prepends `%USERPROFILE%\.cargo\bin` to `PATH` for that run.

**Do not open `http://localhost:1420/` in Chrome/Edge as the app.** That URL is only for the **desktop window’s** embedded browser. A normal browser cannot run Tauri APIs (`invoke`, native dialogs, etc.), so the page may look blank or broken. Wait until **`cargo run` finishes** and a **Pod240** window opens—that is the app.

To fix permanently: add `C:\Users\<you>\.cargo\bin` to your **user** `Path` (Settings → System → About → Advanced system settings → Environment Variables), then **restart** the terminal.

If Rust isn’t installed: [https://rustup.rs/](https://rustup.rs/) or `winget install Rustlang.Rustup`.

## Build

```bash
npm run tauri build
```

DRM-protected store purchases cannot be converted.

## GitHub releases (CI)

Official **Windows** and **macOS** installers are built in [GitHub Actions](.github/workflows/release.yml) when you push a **version tag**. Each build vendors **HandBrake CLI** and **AtomicParsley** into the app, and bundles **FFmpeg/ffprobe** from `resources/ffmpeg` when present, so end users do **not** install those tools separately.

### Publish a version

1. Bump the version consistently in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (same semver as the tag, without the `v` prefix).
2. Commit and push to `main` (or your default branch) as usual.
3. Tag and push (use the same version as in `package.json` / `Cargo.toml` / `tauri.conf.json`, with a `v` prefix on the tag):

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

   Replace `0.1.1` with your release version.

The workflow runs on that tag, builds **Windows (x64)** and **macOS (Apple Silicon + Intel)** artifacts, creates or updates a **GitHub Release** for that tag, and attaches the bundles.

### Where to download

After the workflow finishes, open the repository’s **Releases** page on GitHub (`https://github.com/<owner>/<repo>/releases`) and download the `.msi` / `.exe` / `.dmg` (or other bundles Tauri produced) for your platform.

### Unsigned builds

These release artifacts are **not** Apple **notarized** or signed with a paid **Developer ID** certificate. Windows may show **SmartScreen**. On **macOS**, Gatekeeper may block the app or show messages that sound like the download is “damaged”; **right‑click → Open** on the app (or allow under **System Settings → Privacy & Security**) is the usual workaround for unsigned open-source builds. Ad-hoc or self-signed setups do not replace notarization for broad “download and double‑click” trust.

### Repo settings

If the workflow fails to create the release with a permissions error, set **Settings → Actions → General → Workflow permissions** to **Read and write** so `GITHUB_TOKEN` can publish releases. No extra secrets are required for unsigned builds.
