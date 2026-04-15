FFmpeg — music video “Frame from video” when the in-app player cannot decode your file
======================================================================================

**Release / packaged builds:** `ffmpeg` and `ffprobe` are bundled under the app’s **`resources/ffmpeg/`** folder (see `tauri.conf.json`). End users normally do nothing.

**Development:** For `tauri dev`, put the same binaries in this repo folder: `src-tauri/resources/ffmpeg/`
(packaged builds resolve the same path under bundled `resources/ffmpeg/`).

Place the platform binaries in this folder next to each other:

  Windows (64-bit)
    ffmpeg.exe
    ffprobe.exe

  macOS (Intel or Apple Silicon — match your build)
    ffmpeg
    ffprobe   (chmod +x both after copying)

Typical sources:
  • Windows: https://www.gyan.dev/ffmpeg/builds/  → “ffmpeg-release-essentials.zip” (extract the two exes)
  • macOS:   https://evermeet.cx/ffmpeg/          → static ffmpeg + ffprobe builds

Optional: set environment variable POD240_FFMPEG to this folder path, or to the full path of ffmpeg.

Licensing: FFmpeg is under LGPL/GPL depending on the build; comply with the license for your chosen binaries.
