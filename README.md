# Pod240

**Pod240** is a small desktop app for **Windows** and **macOS** that converts videos for **iPod Classic** and **iPod Video (5th gen)** using the community **Olsro “Apple 240p30”** HandBrake preset. For background on why 240p and how it fits iPod limits, see [Olsro’s iPod encode guide](https://github.com/Olsro/reddit-ipod-guides/blob/main/guides/ipod-encode-240p-video-content.md).

**Developers** building from source: see [DEVELOPMENT.md](DEVELOPMENT.md).

## Download and install

Get the latest **Windows** or **macOS** build from the project’s **Releases** page on GitHub (`https://github.com/<owner>/<repo>/releases`). You do **not** need to install Rust, Node.js, or HandBrake by hand for a normal release install—the app bundles what it needs to encode and tag.

## First launch (unsigned builds)

Release installers are **not** code-signed. **Windows** may show **SmartScreen**; choose “More info” / “Run anyway” if you trust the download. **macOS** may block the app until you **right‑click → Open** the first time, or allow it under **System Settings → Privacy & Security**. This is typical for unsigned open-source builds.

## What you get in the box

- **Encoding:** HandBrake CLI with the bundled **Olsro 240p30** preset (see [THIRD_PARTY.md](THIRD_PARTY.md) for licenses and components).
- **Tags:** AtomicParsley is used when you add **metadata** in the app (iTunes-style tags on the finished `.mp4`).
- **FFmpeg:** Shipped **next to the app** under **`resources/ffmpeg`** (`ffmpeg` + `ffprobe`). Pod240 uses them for **music video “Frame from video”** and preview scrubbing when the built-in player cannot decode a file—they are **not** used for the main HandBrake encode. Release installs include these binaries; if you build from source and the folder is empty, copy them in as described in **`resources/ffmpeg/README.txt`**, or set **`POD240_FFMPEG`** to that folder or to `ffmpeg` directly.

## Using Pod240

1. **Add videos:** Use **Choose files** or **drag and drop** onto the window.
2. **Metadata (optional):** When prompted, you can add **Add Metadata** (movie / TV / music video tags, optional TMDB key for posters and text) or **Skip** to encode without those tags.
3. **Queue:** Jobs run **one at a time**. You can reorder **pending** jobs by dragging the handle on each row.
4. **Output folder:** By default, converted files go **next to each source file**. You can set a **default output folder** in the UI so folder drops mirror their structure under that folder; single files can still follow the default or same-folder behavior depending on how you added them.
5. **While encoding:** **Cancel** stops the current encode. **Clear queue** removes jobs that are not currently encoding. **Closing the window** (X) asks for confirmation if something is still **encoding** or **waiting** in the queue—unfinished work is lost if you confirm.

## Output files

Converted files are **`.mp4`** in **240p** (per the Olsro preset). The app picks a filename that does not overwrite your source: usually `YourVideo.mp4` in the output folder; if that name is taken or would overwrite the source, it uses `YourVideo_ipod240p.mp4`, then `YourVideo_ipod240p_2.mp4`, and so on.

## Limitations

**DRM-protected** purchases (e.g. many store-bought downloads) **cannot** be converted. Use files you own that are not copy-protected.

## Settings

Preferences (such as default output folder and optional TMDB API key) are stored in **`pod240-settings.json`** next to the application executable—handy for a **portable** install with no Windows Registry dependency.

## Credits and licenses

- Preset lineage and community context: **Olsro** / [reddit-ipod-guides](https://github.com/Olsro/reddit-ipod-guides).
- Third-party tools and attribution: **[THIRD_PARTY.md](THIRD_PARTY.md)**.
- Pod240 application license: **[LICENSE](LICENSE)**.
