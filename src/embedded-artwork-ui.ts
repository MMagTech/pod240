/**
 * Embedded cover art in source files (Lofty probe + AtomicParsley strip).
 */

import { invoke } from "@tauri-apps/api/core";

export type EmbeddedArtworkProbeResult = {
  present: boolean;
  dataBase64: string | null;
  mimeType: string | null;
};

/** Insert before the optional “Artwork” section in metadata dialogs. */
export const EMBEDDED_ARTWORK_SECTION_HTML = `
        <div id="meta-embedded-art" class="meta-section meta-embedded-art" hidden>
          <p class="meta-section-label">Covers Already in File</p>
          <p id="meta-embedded-art-note" class="meta-tiny" hidden></p>
          <div class="meta-embedded-art-row">
            <div id="meta-embedded-art-thumb" class="meta-embedded-art-thumb" aria-hidden="true"></div>
            <div class="meta-embedded-art-actions">
              <button type="button" class="secondary" id="meta-embedded-art-remove">Remove…</button>
              <p class="meta-tiny">Strips embedded cover art. Other tags are unchanged.</p>
            </div>
          </div>
        </div>`;

export async function probeEmbeddedArtwork(sourcePath: string): Promise<EmbeddedArtworkProbeResult> {
  return invoke<EmbeddedArtworkProbeResult>("probe_embedded_artwork", { sourcePath });
}

export async function stripEmbeddedArtworkFromFile(sourcePath: string): Promise<void> {
  await invoke("strip_embedded_artwork_from_file", { sourcePath });
}

/** Themed confirm above the metadata overlay (native dialogs don’t match app CSS). */
function openRemoveEmbeddedArtConfirm(parentOverlay: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    const layer = document.createElement("div");
    layer.className = "meta-confirm-overlay";
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");
    layer.setAttribute("aria-labelledby", "meta-embed-confirm-title");
    layer.innerHTML = `
      <div class="meta-panel meta-panel--confirm">
        <h3 id="meta-embed-confirm-title" class="meta-confirm-title">Remove Embedded Artwork</h3>
        <p class="meta-hint meta-confirm-msg">
          Remove all embedded cover art? The video file on disk will be modified.
        </p>
        <div class="meta-actions">
          <button type="button" class="secondary meta-embed-confirm-cancel">Cancel</button>
          <div class="meta-actions-filler" aria-hidden="true"></div>
          <button type="button" class="meta-embed-confirm-remove">Remove</button>
        </div>
      </div>`;
    parentOverlay.appendChild(layer);

    const cancelBtn = layer.querySelector(".meta-embed-confirm-cancel") as HTMLButtonElement;
    const removeBtn = layer.querySelector(".meta-embed-confirm-remove") as HTMLButtonElement;

    const finish = (v: boolean) => {
      document.removeEventListener("keydown", onKey);
      layer.remove();
      resolve(v);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };

    cancelBtn.addEventListener("click", () => finish(false));
    removeBtn.addEventListener("click", () => finish(true));
    layer.addEventListener("click", (e) => {
      if (e.target === layer) finish(false);
    });
    document.addEventListener("keydown", onKey, true);
    cancelBtn.focus();
  });
}

/**
 * One-time setup per modal: loads embedded art for `sourcePath` and wires remove.
 * For TV batch/orphans, pass `note` (e.g. first-file-only hint).
 */
export function initEmbeddedArtworkBlock(
  overlay: HTMLElement,
  appendLog: (s: string) => void
): {
  load: (sourcePath: string, note?: string) => Promise<void>;
} {
  const panel = overlay.querySelector("#meta-embedded-art") as HTMLElement | null;
  const noteEl = overlay.querySelector("#meta-embedded-art-note") as HTMLElement | null;
  const thumb = overlay.querySelector("#meta-embedded-art-thumb") as HTMLElement | null;
  const btn = overlay.querySelector("#meta-embedded-art-remove") as HTMLButtonElement | null;
  if (!panel || !thumb || !btn) {
    return { load: async () => {} };
  }

  const artPanel = panel;
  const artThumb = thumb;
  const artBtn = btn;

  let activePath = "";

  artBtn.addEventListener("click", async () => {
    if (!activePath) return;
    const ok = await openRemoveEmbeddedArtConfirm(overlay);
    if (!ok) return;
    try {
      await stripEmbeddedArtworkFromFile(activePath);
      appendLog("Removed embedded artwork from source file.");
      await load(activePath);
    } catch (e) {
      appendLog(String(e));
    }
  });

  async function load(sourcePath: string, note?: string): Promise<void> {
    activePath = sourcePath;
    if (noteEl) {
      if (note) {
        noteEl.hidden = false;
        noteEl.textContent = note;
      } else {
        noteEl.hidden = true;
        noteEl.textContent = "";
      }
    }
    try {
      const r = await probeEmbeddedArtwork(sourcePath);
      if (!r.present || !r.dataBase64) {
        artPanel.hidden = true;
        artThumb.replaceChildren();
        return;
      }
      artPanel.hidden = false;
      const mime = r.mimeType || "image/jpeg";
      artThumb.innerHTML = `<img src="data:${mime};base64,${r.dataBase64}" alt="" />`;
    } catch (e) {
      artPanel.hidden = true;
      artThumb.replaceChildren();
      appendLog(String(e));
    }
  }

  return { load };
}
