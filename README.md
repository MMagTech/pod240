# Pod240

[![Latest release](https://img.shields.io/github/v/release/MMagTech/pod240?label=release&logo=github)](https://github.com/MMagTech/pod240/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](#requirements--compatibility)
[![Tauri](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri)](https://tauri.app/)

Pod240 is a drag-and-drop **desktop app** (**Windows** / **macOS**) that converts modern video files into the **240p MP4** format that **iPod Classic** and **iPod Video (5th gen)** can play. It drives **HandBrake CLI** with the community **“Apple 240p30”** preset ([Olsro](https://github.com/Olsro/reddit-ipod-guides)) and can apply **iTunes-style metadata** after each encode.

**Why it exists:** getting video onto an iPod Classic in 2026 is awkward. Pod240 makes it mostly **drop, queue, encode**.

![Pod240 — main window](assets/Screenshot%202026-04-17%20065712.png)

![Pod240 — queue and controls](assets/Screenshot%202026-04-17%20065749.png)

![Pod240 — metadata / workflow](assets/Screenshot%202026-04-17%20065856.png)

## Features

- **Queue** — Drag-and-drop or file picker; **reorder** pending jobs; one encode **at a time** for predictable behavior.
- **Metadata (optional)** — Movie, TV, and music-video flows with **TMDB** (posters, tags) and related helpers; skip entirely if you only want video.
- **Tags** — iTunes-style tags on the finished `.mp4` via **AtomicParsley** when you use metadata.
- **Discord** — Optional **incoming webhook** notifications (queue finished / encode failed) under **Menu → Notification**.
- **Updates** — **Menu → Check for Updates** compares your build to the **latest GitHub release** (manual only; no background polling).
- **Portable settings** — Preferences live in **`pod240-settings.json`** next to the executable (no Windows Registry).
- **Music video covers** — **Frame from video** and scrubbing use bundled **FFmpeg/ffprobe** when the built-in preview cannot decode a file (see [Bundled Tools](#bundled-tools)).
- **Safe queue UX** — Closing the app while work is pending warns you; cancel and clear behave as labeled in the UI.

**Developers:** [DEVELOPMENT.md](DEVELOPMENT.md) · **Third-party licenses:** [THIRD_PARTY.md](THIRD_PARTY.md)

## Requirements & Compatibility

| | |
| --- | --- |
| **OS** | **Windows** 10 or later (x64). **macOS** recent releases — install **Apple Silicon** or **Intel** builds from [Releases](https://github.com/MMagTech/pod240/releases/latest) (artifacts are built per architecture). |
| **Output** | Typically **H.264** video and **AAC** audio in an **`.mp4`** container at **240p** / **~30 fps** per the Olsro **240p30** preset (details and limits: [Olsro’s encode guide](https://github.com/Olsro/reddit-ipod-guides/blob/main/guides/ipod-encode-240p-video-content.md)). |
| **Source files** | Unencrypted video files you can decode locally; see [Limitations](#limitations). |

## Download & Install

**Latest installers:** [github.com/MMagTech/pod240/releases/latest](https://github.com/MMagTech/pod240/releases/latest)

You do **not** need to install Rust, Node.js, or HandBrake for a normal release — the app bundles what it needs to encode and tag.

> **Version note:** GitHub **Releases** show published installer versions. The **source tree** may bump a patch ahead of the next tagged release while development continues; trust **Releases** for “what build do I download?”

## First Launch (Unsigned Builds)

Release builds are **not** signed with a paid **Apple Developer ID** and are **not** **notarized**. Treat the steps below as normal for small open-source projects.

### Windows

If **Microsoft Defender SmartScreen** appears: choose **More info** → **Run anyway** (wording may vary slightly by Windows version) if you trust this repository.

### macOS

**Gatekeeper** may block the app or show messages like the app “can’t be opened” or is “damaged” (often quarantine + unsigned code, not a corrupt download). Typical workarounds:

1. **Right-click** the app (or the app inside the `.dmg`) → **Open** → confirm once, **or**
2. **System Settings → Privacy & Security** → allow the app when macOS lists it there.

## Quick Start

1. **Add files** — **Choose files** or drag videos (or folders) onto the window.
2. **Metadata** — Choose **Add Metadata** or **Skip** when prompted (optional TMDB key under **Menu → TMDB API**).
3. **Queue** — Jobs run **one at a time**; drag the handle on a row to **reorder** pending work.
4. **Output** — By default, outputs go **next to each source**; you can set a **default output folder** in the UI for batch layouts.

More detail: **Menu → Help** and **Menu → Tips**.

## Output Files

Converted files are **`.mp4`** in **240p** (per the preset). The app avoids overwriting sources: usually `YourVideo.mp4` in the output folder; if needed, `YourVideo_ipod240p.mp4`, then `YourVideo_ipod240p_2.mp4`, and so on.

## Bundled Tools

- **HandBrake CLI** — Encode with the **Olsro 240p30** preset ([THIRD_PARTY.md](THIRD_PARTY.md)).
- **AtomicParsley** — MPEG-4 metadata when you use the metadata flow.
- **FFmpeg / ffprobe** — Shipped **with release builds** next to the app under **`resources/ffmpeg`** for music-video frame capture and scrubbing helpers; **not** used for the main HandBrake encode. Advanced layout and **`POD240_FFMPEG`**: [DEVELOPMENT.md](DEVELOPMENT.md).

## Settings

Stored in **`pod240-settings.json`** next to the executable:

- Default **output folder** (optional).
- Optional **TMDB API key** (posters / tags in metadata).
- Optional **Discord webhook** URL and toggles (**Menu → Notification**).

Discord stores only the webhook URL and your toggle choices; messages send only when you enable them and the event occurs.

## Limitations

> **Note — DRM:** **DRM-protected** purchases (many store-bought downloads) **cannot** be converted. Use files you own that are **not** copy-protected. If something “won’t convert,” check whether the file is encrypted for a store ecosystem first.

## Troubleshooting & FAQ

| Question | Short answer |
| --- | --- |
| **macOS says the app is “damaged”?** | Usually **Gatekeeper**, not a bad file. Try **right-click → Open**, or **Privacy & Security** as in [First Launch (macOS)](#macos). |
| **Windows SmartScreen blocks the app?** | Use **More info** / **Run anyway** if you trust the [Releases](https://github.com/MMagTech/pod240/releases/latest) download. |
| **Encode failed?** | Open the in-app **Log**; check HandBrake errors. Missing tools show a banner — install from a **release** build or see [DEVELOPMENT.md](DEVELOPMENT.md). |
| **Do I need a TMDB key?** | **No** for plain encodes. **Yes** if you want TMDB-driven posters/fetch in the metadata dialogs (**Menu → TMDB API**). |
| **How do I check for a newer release?** | **Menu → Check for Updates** (contacts GitHub only when you use it). |

## Credits & Licenses

- Preset lineage and community context: **Olsro** / [reddit-ipod-guides](https://github.com/Olsro/reddit-ipod-guides).
- Third-party components: **[THIRD_PARTY.md](THIRD_PARTY.md)**.
- Pod240 application license: **[LICENSE](LICENSE)**.

## Contributing & Issues

Bug reports and feature ideas: **[GitHub Issues](https://github.com/MMagTech/pod240/issues)**.  
To build from source or cut a release: **[DEVELOPMENT.md](DEVELOPMENT.md)**.
