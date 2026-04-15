/**
 * Embedded cover art in source files (read-only probe for the metadata UI).
 * Optional: omit that cover on the **encoded output** only (never modifies the source file).
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
              <label class="meta-check-label meta-embedded-art-omit-label">
                <input type="checkbox" id="meta-embedded-art-omit-output" />
                Don't embed current cover on output
              </label>
              <p class="meta-tiny">Nondestructive to source file if chosen. Action applied to encoded file.</p>
            </div>
          </div>
        </div>`;

export async function probeEmbeddedArtwork(sourcePath: string): Promise<EmbeddedArtworkProbeResult> {
  return invoke<EmbeddedArtworkProbeResult>("probe_embedded_artwork", { sourcePath });
}

/**
 * One-time setup per modal: loads embedded art for `sourcePath` and wires omit-on-output checkbox.
 * For TV batch/orphans, pass `note` (e.g. first-file-only hint).
 * `prefillOmitOnOutput`: restore checkbox when stepping back through the wizard.
 */
export function initEmbeddedArtworkBlock(
  overlay: HTMLElement,
  _appendLog: (s: string) => void
): {
  load: (sourcePath: string, note?: string, prefillOmitOnOutput?: boolean) => Promise<void>;
  getOmitEmbeddedCoverOnOutput: () => boolean;
} {
  const panel = overlay.querySelector("#meta-embedded-art") as HTMLElement | null;
  const noteEl = overlay.querySelector("#meta-embedded-art-note") as HTMLElement | null;
  const thumb = overlay.querySelector("#meta-embedded-art-thumb") as HTMLElement | null;
  const omitCb = overlay.querySelector("#meta-embedded-art-omit-output") as HTMLInputElement | null;
  if (!panel || !thumb || !omitCb) {
    return {
      load: async () => {},
      getOmitEmbeddedCoverOnOutput: () => false,
    };
  }

  const artPanel = panel;
  const artThumb = thumb;
  const omitCheckbox = omitCb;

  async function load(
    sourcePath: string,
    note?: string,
    prefillOmitOnOutput?: boolean
  ): Promise<void> {
    omitCheckbox.checked = !!prefillOmitOnOutput;
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
    } catch {
      artPanel.hidden = true;
      artThumb.replaceChildren();
    }
  }

  function getOmitEmbeddedCoverOnOutput(): boolean {
    return omitCheckbox.checked;
  }

  return { load, getOmitEmbeddedCoverOnOutput };
}
