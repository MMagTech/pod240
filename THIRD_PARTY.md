# Third-party components

## HandBrake

This app invokes **HandBrakeCLI** (not linked as a library). HandBrake is licensed under **GNU General Public License v2**. Source: [https://github.com/HandBrake/HandBrake](https://github.com/HandBrake/HandBrake)

Release builds (and `npm run vendor:release`) download a pinned version listed in [`scripts/third-party.json`](scripts/third-party.json) from the official HandBrake GitHub releases.

## AtomicParsley

This app invokes the **AtomicParsley** CLI for MPEG-4 metadata (not linked as a library). Upstream: [wez/atomicparsley](https://github.com/wez/atomicparsley) (see that project for license terms). Pinned release tag is in [`scripts/third-party.json`](scripts/third-party.json).

## Olsro preset JSON

Preset files under `src-tauri/resources/presets/` are from the **reddit-ipod-guides** project (Olsro’s “Apple 240p30” Windows/macOS presets). Upstream: [https://github.com/Olsro/reddit-ipod-guides](https://github.com/Olsro/reddit-ipod-guides)

## Pod240 application code

See [LICENSE](LICENSE) for the project’s own license.
