/**
 * Music video only: scrub the source file for a still frame (iTunes artwork).
 * If bundled ffmpeg+ffprobe exist, uses them for preview (reliable scrub). Otherwise <video> + canvas,
 * then ffmpeg fallback when the WebView cannot decode.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const MAX_ART_WIDTH = 1280;
const FFMPEG_PREVIEW_DEBOUNCE_MS = 180;

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

export interface MusicVideoFramePickerElements {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  slider: HTMLInputElement;
  timeCurrent: HTMLElement;
  timeDuration: HTMLElement;
  useBtn: HTMLButtonElement;
}

type PlaybackMode = "idle" | "web" | "ffmpeg";

export function wireMusicVideoFramePicker(
  els: MusicVideoFramePickerElements,
  onApplied: (jpegBase64: string) => void,
  appendLog: (msg: string) => void
): { load: (sourcePath: string) => void; unload: () => void } {
  const { video, canvas, slider, timeCurrent, timeDuration, useBtn } = els;

  let activePath: string | null = null;
  let mode: PlaybackMode = "idle";
  let durationSec = 0;
  let lastFfmpegB64: string | null = null;
  let previewDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic id so stale ffmpeg preview responses are ignored during fast scrub. */
  let ffmpegPreviewGen = 0;

  function clearDebounce(): void {
    if (previewDebounce != null) {
      clearTimeout(previewDebounce);
      previewDebounce = null;
    }
  }

  function drawImageToCanvas(img: HTMLImageElement): void {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let dw = w;
    let dh = h;
    if (dw > MAX_ART_WIDTH) {
      dh = Math.round((h * MAX_ART_WIDTH) / w);
      dw = MAX_ART_WIDTH;
    }
    canvas.width = dw;
    canvas.height = dh;
    ctx.drawImage(img, 0, 0, w, h, 0, 0, dw, dh);
  }

  function drawPreviewFromVideo(): void {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let dw = w;
    let dh = h;
    if (dw > MAX_ART_WIDTH) {
      dh = Math.round((h * MAX_ART_WIDTH) / w);
      dw = MAX_ART_WIDTH;
    }
    canvas.width = dw;
    canvas.height = dh;
    ctx.drawImage(video, 0, 0, w, h, 0, 0, dw, dh);
  }

  function onSeeked(): void {
    if (mode !== "web") return;
    drawPreviewFromVideo();
    timeCurrent.textContent = formatTime(video.currentTime);
  }

  /** Also refresh preview while seeking (WebView sometimes omits seeked during rapid scrubs). */
  function onTimeUpdate(): void {
    if (mode !== "web") return;
    if (video.seeking) return;
    drawPreviewFromVideo();
    timeCurrent.textContent = formatTime(video.currentTime);
  }

  async function startFfmpegPipeline(logLine: boolean): Promise<boolean> {
    const path = activePath;
    if (!path) return false;

    const ok = await invoke<boolean>("ffmpeg_available").catch(() => false);
    if (!ok) {
      return false;
    }

    try {
      const dur = await invoke<number>("ffmpeg_probe_duration", { sourcePath: path });
      if (!Number.isFinite(dur) || dur <= 0) {
        appendLog("Frame from video: ffprobe could not read duration.");
        return false;
      }

      video.pause();
      video.removeAttribute("src");
      video.load();

      mode = "ffmpeg";
      durationSec = dur;
      timeDuration.textContent = formatTime(dur);
      slider.min = "0";
      slider.max = "1000";
      slider.value = "100";
      slider.disabled = false;
      useBtn.disabled = false;

      const t = Math.min(dur * 0.1, Math.max(0, dur - 0.05));
      await fetchFfmpegFrame(path, t);
      if (logLine) {
        appendLog("Frame from video: using bundled FFmpeg for preview (scrub with the slider).");
      }
      return true;
    } catch (e) {
      appendLog(`Frame from video: ${String(e)}`);
      slider.disabled = true;
      useBtn.disabled = true;
      return false;
    }
  }

  async function tryFfmpegFallback(reason: string): Promise<void> {
    if (!activePath || mode === "ffmpeg") return;
    const ok = await invoke<boolean>("ffmpeg_available").catch(() => false);
    if (!ok) {
      appendLog(
        `Frame from video: ${reason} Full installs bundle FFmpeg under resources/ffmpeg; if missing, add ffmpeg and ffprobe there (dev: src-tauri/resources/ffmpeg/) or set POD240_FFMPEG. See resources/ffmpeg/README.txt.`
      );
      slider.disabled = true;
      useBtn.disabled = true;
      return;
    }
    await startFfmpegPipeline(true);
  }

  async function fetchFfmpegFrame(path: string, timeSec: number): Promise<void> {
    const gen = ++ffmpegPreviewGen;
    const d = durationSec;
    const t = Math.min(Math.max(0, timeSec), Math.max(0, d - 0.02));
    try {
      const b64 = await invoke<string>("ffmpeg_extract_frame_base64", {
        sourcePath: path,
        timeSec: t,
      });
      if (gen !== ffmpegPreviewGen) return;
      lastFfmpegB64 = b64;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("JPEG decode"));
        img.src = `data:image/jpeg;base64,${b64}`;
      });
      if (gen !== ffmpegPreviewGen) return;
      drawImageToCanvas(img);
      timeCurrent.textContent = formatTime(t);
    } catch (e) {
      if (gen === ffmpegPreviewGen) {
        appendLog(`Frame from video preview: ${String(e)}`);
      }
    }
  }

  function scheduleFfmpegPreview(path: string): void {
    clearDebounce();
    previewDebounce = window.setTimeout(() => {
      previewDebounce = null;
      const d = durationSec;
      if (!Number.isFinite(d) || d <= 0) return;
      const t = (Number(slider.value) / 1000) * d;
      void fetchFfmpegFrame(path, t);
    }, FFMPEG_PREVIEW_DEBOUNCE_MS);
  }

  function onLoadedMetadata(): void {
    const d = video.duration;
    if (!Number.isFinite(d) || d <= 0) {
      void tryFfmpegFallback("could not read duration in the preview player.");
      return;
    }
    mode = "web";
    durationSec = d;
    slider.min = "0";
    slider.max = "1000";
    slider.value = "100";
    slider.disabled = false;
    useBtn.disabled = false;
    timeDuration.textContent = formatTime(d);
    const t = Math.min(d * 0.1, Math.max(0, d - 0.05));
    video.currentTime = t;
  }

  function onSliderInput(): void {
    if (mode === "web") {
      const d = video.duration;
      if (!Number.isFinite(d) || d <= 0) return;
      const t = (Number(slider.value) / 1000) * d;
      video.currentTime = Math.min(Math.max(t, 0), Math.max(0, d - 0.001));
      return;
    }
    if (mode === "ffmpeg" && activePath) {
      scheduleFfmpegPreview(activePath);
    }
  }

  function onVideoError(): void {
    const code = video.error?.code;
    const detail =
      code === 4
        ? "format not supported in the preview player."
        : video.error?.message ?? "decode error";
    void tryFfmpegFallback(detail);
  }

  video.addEventListener("loadedmetadata", onLoadedMetadata);
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("error", onVideoError);
  slider.addEventListener("input", onSliderInput);

  useBtn.addEventListener("click", () => {
    if (mode === "web") {
      drawPreviewFromVideo();
      if (canvas.width < 2 || canvas.height < 2) {
        appendLog("Frame from video: nothing to capture yet.");
        return;
      }
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      const i = dataUrl.indexOf("base64,");
      if (i < 0) return;
      onApplied(dataUrl.slice(i + 7));
      return;
    }
    if (mode === "ffmpeg" && lastFfmpegB64) {
      onApplied(lastFfmpegB64);
      return;
    }
    appendLog("Frame from video: nothing to capture yet.");
  });

  function resetPlayer(): void {
    clearDebounce();
    ffmpegPreviewGen++;
    mode = "idle";
    durationSec = 0;
    lastFfmpegB64 = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    slider.value = "0";
    slider.disabled = true;
    useBtn.disabled = true;
    timeCurrent.textContent = "0:00";
    timeDuration.textContent = "0:00";
    const ctx = canvas.getContext("2d");
    if (ctx && canvas.width > 0 && canvas.height > 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    canvas.width = 1;
    canvas.height = 1;
    activePath = null;
  }

  return {
    load(sourcePath: string) {
      if (activePath === sourcePath && (video.src || mode === "ffmpeg")) return;
      resetPlayer();
      activePath = sourcePath;

      void (async () => {
        const preferFf = await invoke<boolean>("ffmpeg_available").catch(() => false);
        if (preferFf) {
          const ok = await startFfmpegPipeline(true);
          if (ok) return;
        }
        try {
          video.src = convertFileSrc(sourcePath);
          video.load();
        } catch (e) {
          appendLog(`Frame from video: ${String(e)}`);
          void tryFfmpegFallback("could not open file URL.");
        }
      })();
    },
    unload: resetPlayer,
  };
}
