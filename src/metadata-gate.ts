/**
 * First step: add iTunes-style metadata or skip straight to encode.
 */

export type MetadataGateChoice = "cancel" | "skip" | "addMetadata";

export function promptMetadataOrSkip(): Promise<MetadataGateChoice> {
  return new Promise((resolve) => {
    const hostEl = document.getElementById("metadata-modal-host");
    if (!hostEl) {
      resolve("cancel");
      return;
    }
    const modalHost: HTMLElement = hostEl;
    const overlay = document.createElement("div");
    overlay.className = "meta-overlay";
    overlay.innerHTML = `
      <div class="meta-panel meta-gate-panel" role="dialog" aria-modal="true" aria-labelledby="meta-gate-title">
        <h2 id="meta-gate-title">Metadata</h2>
        <p class="meta-hint">Add iPod Compatible Tags or Skip and Encode Without Metadata.</p>
        <div class="meta-gate-actions">
          <button type="button" class="secondary" id="meta-gate-cancel">Cancel</button>
          <button type="button" class="secondary" id="meta-gate-skip">Skip</button>
          <button type="button" id="meta-gate-add">Add Metadata</button>
        </div>
      </div>`;

    modalHost.innerHTML = "";
    modalHost.appendChild(overlay);

    function done(v: MetadataGateChoice) {
      modalHost.innerHTML = "";
      resolve(v);
    }

    overlay.querySelector("#meta-gate-cancel")!.addEventListener("click", () => done("cancel"));
    overlay.querySelector("#meta-gate-skip")!.addEventListener("click", () => done("skip"));
    overlay.querySelector("#meta-gate-add")!.addEventListener("click", () => done("addMetadata"));
  });
}
