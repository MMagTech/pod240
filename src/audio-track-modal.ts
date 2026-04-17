/**
 * HandBrake audio track scan + optional picker when multiple tracks exist.
 */

import { invoke } from "@tauri-apps/api/core";
import { hideBusy } from "./busy-overlay";
import { attachConfirmedBackdropDismiss } from "./modal-backdrop";

export interface AudioTrack {
  index: number;
  label: string;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * Probes each source file and, if any has more than one audio track, shows a modal to choose.
 * Returns a map of source path → 1-based HandBrake track index, or `null` if the user cancels the modal or `signal` aborts.
 * Files with a single track are included without UI; probe failures omit that path (HandBrake default).
 */
export async function pickAudioTracksForSources(
  sourcePaths: string[],
  appendLog: (s: string) => void,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal
): Promise<Map<string, number> | null> {
  const total = sourcePaths.length;
  const results: { path: string; tracks: AudioTrack[] }[] = [];
  for (let i = 0; i < sourcePaths.length; i++) {
    if (signal?.aborted) {
      return null;
    }
    const path = sourcePaths[i]!;
    onProgress?.(i + 1, total);
    try {
      const tracks = await invoke<AudioTrack[]>("probe_source_audio", { path });
      results.push({ path, tracks });
    } catch (e) {
      appendLog(`Audio scan (${basename(path)}): ${String(e)}`);
      results.push({ path, tracks: [] });
    }
    if (signal?.aborted) {
      return null;
    }
  }

  const map = new Map<string, number>();
  const needChoice: { path: string; tracks: AudioTrack[] }[] = [];

  for (const r of results) {
    if (r.tracks.length === 1) {
      map.set(r.path, r.tracks[0]!.index);
    } else if (r.tracks.length > 1) {
      needChoice.push(r);
    }
  }

  if (needChoice.length === 0) {
    return map;
  }

  hideBusy();

  return new Promise((resolve) => {
    const hostEl = document.getElementById("metadata-modal-host");
    if (!hostEl) {
      resolve(null);
      return;
    }
    const modalHost: HTMLElement = hostEl;
    const overlay = document.createElement("div");
    overlay.className = "meta-overlay";
    const rows = needChoice
      .map((r, i) => {
        const opts = r.tracks
          .map(
            (t) =>
              `<option value="${t.index}">${escapeHtml(t.label)} (${t.index})</option>`
          )
          .join("");
        return `<label class="audio-pick-row"><span class="audio-pick-name" title="${escapeAttr(
          r.path
        )}">${escapeHtml(basename(r.path))}</span>
          <select id="audio-sel-${i}" class="meta-input">${opts}</select></label>`;
      })
      .join("");

    overlay.innerHTML = `
      <div class="meta-panel audio-pick-panel" role="dialog" aria-modal="true" aria-labelledby="audio-pick-title">
        <h2 id="audio-pick-title">Audio Track</h2>
        <p class="meta-hint">These files have multiple audio tracks. Choose which one to encode.</p>
        <div class="audio-pick-list">${rows}</div>
        <div class="meta-actions">
          <button type="button" class="secondary" id="audio-pick-cancel">Cancel</button>
          <button type="button" id="audio-pick-ok">Continue</button>
        </div>
      </div>`;

    modalHost.innerHTML = "";
    modalHost.appendChild(overlay);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        done(null);
      }
    };
    document.addEventListener("keydown", onKey);

    let removeBackdrop: () => void = () => {};

    function done(v: Map<string, number> | null) {
      document.removeEventListener("keydown", onKey);
      removeBackdrop();
      modalHost.innerHTML = "";
      resolve(v);
    }

    overlay.querySelector("#audio-pick-cancel")!.addEventListener("click", () => done(null));
    removeBackdrop = attachConfirmedBackdropDismiss(overlay, () => done(null), "audio-track-modal");
    overlay.querySelector("#audio-pick-ok")!.addEventListener("click", () => {
      const m = new Map(map);
      needChoice.forEach((r, i) => {
        const sel = overlay.querySelector(`#audio-sel-${i}`) as HTMLSelectElement;
        const v = Number(sel.value);
        if (!Number.isNaN(v) && v >= 1) m.set(r.path, v);
      });
      done(m);
    });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
