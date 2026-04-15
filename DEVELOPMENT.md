# Development

Pod240 is a **Tauri 2** desktop app. This document is for **building from source** and **publishing releases**. End-user information is in [README.md](README.md).

## Requirements

1. **Rust** (e.g. [rustup](https://rustup.rs/)) and **Node.js 18+**.
2. **HandBrake CLI** and **AtomicParsley** for a working encode + tagging pipeline.

   **Easiest (recommended):** download third-party CLIs into `src-tauri/resources/` automatically:

   ```bash
   npm run vendor:release
   ```

   Versions are pinned in [`scripts/third-party.json`](scripts/third-party.json). This matches what **GitHub Actions** runs before release builds.

   **Or** copy `HandBrakeCLI` and required libraries into `src-tauri/resources/handbrake/` and the AtomicParsley binary into `src-tauri/resources/atomicparsley/` (see the `README.txt` files there), **or** set `POD240_HANDBRAKE_CLI` / `POD240_ATOMICPARSLEY` to full paths.

   HandBrake is **GPLv2** — see [THIRD_PARTY.md](THIRD_PARTY.md).

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

Official **Windows** and **macOS** installers are built in [GitHub Actions](.github/workflows/release.yml) when you push a **version tag**. Each build vendors **HandBrake CLI** and **AtomicParsley** into the app so end users do **not** install those tools separately.

### Publish a version

1. Bump the version consistently in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` (same semver as the tag, without the `v` prefix).
2. Commit and push to `main` (or your default branch) as usual.
3. Tag and push:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

   Use your real version instead of `0.1.0`.

The workflow runs on that tag, builds **Windows (x64)** and **macOS (Apple Silicon + Intel)** artifacts, creates or updates a **GitHub Release** for that tag, and attaches the bundles.

### Where to download

After the workflow finishes, open the repository’s **Releases** page on GitHub (`https://github.com/<owner>/<repo>/releases`) and download the `.msi` / `.exe` / `.dmg` (or other bundles Tauri produced) for your platform.

### Unsigned builds

These release artifacts are **not** code-signed or notarized. Windows may show **SmartScreen**; on macOS you may need to **right‑click → Open** the first time. This is normal for hobby/open-source builds until you add signing.

### Repo settings

If the workflow fails to create the release with a permissions error, set **Settings → Actions → General → Workflow permissions** to **Read and write** so `GITHUB_TOKEN` can publish releases. No extra secrets are required for unsigned builds.
