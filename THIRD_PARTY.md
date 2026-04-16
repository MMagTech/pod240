# Third-party components

## HandBrake

This app invokes **HandBrakeCLI** (not linked as a library). HandBrake is licensed under **GNU General Public License v2**. Upstream source: [HandBrake/HandBrake](https://github.com/HandBrake/HandBrake).

For **self-contained** installs, [`scripts/vendor-release-assets.mjs`](scripts/vendor-release-assets.mjs) (used by `npm run vendor:release` and release CI) downloads a **pinned** HandBrake version declared in [`scripts/third-party.json`](scripts/third-party.json):

- **macOS:** the official HandBrake GitHub **release `.dmg`** containing `HandBrakeCLI` (see script).
- **Windows:** URLs in `third-party.json` may point at the official HandBrake release zip **or** at alternate archives (for example split **CLI** + **libhb** packages from community builds). Whatever you vendor must still provide a working `HandBrakeCLI` (+ `hb.dll` on Windows when required).

## AtomicParsley

This app invokes the **AtomicParsley** CLI for MPEG-4 metadata (not linked as a library). Upstream: [wez/atomicparsley](https://github.com/wez/atomicparsley) (see that project for license terms). Pinned release tag and download names are in [`scripts/third-party.json`](scripts/third-party.json).

## FFmpeg / ffprobe

Optional **bundled** binaries under `resources/ffmpeg/` are used for **music-video frame preview** and related helpers—not for the main HandBrake encode. If you ship them, follow **FFmpeg**’s license terms for binary redistribution (see [FFmpeg License and Legal Questions](https://ffmpeg.org/legal.html)).

## Olsro preset JSON

Preset files under `src-tauri/resources/presets/` are from the **reddit-ipod-guides** project (Olsro’s “Apple 240p30” Windows/macOS presets). Upstream: [Olsro/reddit-ipod-guides](https://github.com/Olsro/reddit-ipod-guides).

## Online services (not bundled)

If you use metadata features, the app may call **The Movie Database (TMDB)**, **MusicBrainz**, and the **Cover Art Archive** over HTTPS. Those services have their own terms; Pod240 does not redistribute their data or trademarks beyond what your usage triggers at runtime.

## Pod240 application code

See [LICENSE](LICENSE) for the project’s own license.
