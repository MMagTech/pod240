/**
 * Full-window busy state while Rust / HandBrake work runs (avoids “app froze” confusion).
 */

const overlay = document.getElementById("busy-overlay");
const messageEl = document.getElementById("busy-message");
const countEl = document.getElementById("busy-count");
const progressEl = document.getElementById("busy-progress") as HTMLProgressElement | null;
const cancelAudioBtn = document.getElementById("busy-cancel-audio") as HTMLButtonElement | null;

let audioCancelHandler: (() => void) | null = null;

function clearAudioCancel() {
  if (cancelAudioBtn && audioCancelHandler) {
    cancelAudioBtn.removeEventListener("click", audioCancelHandler);
    audioCancelHandler = null;
  }
  cancelAudioBtn?.setAttribute("hidden", "");
}

function setIndeterminate() {
  if (!progressEl) return;
  progressEl.removeAttribute("value");
}

export function showBusy(text: string) {
  clearAudioCancel();
  if (messageEl) messageEl.textContent = text;
  countEl?.setAttribute("hidden", "");
  setIndeterminate();
  overlay?.removeAttribute("hidden");
  document.getElementById("app")?.setAttribute("aria-busy", "true");
}

/** Audio scan phase: title + count + determinate progress (starts at 0 / total). */
export function showCheckingAudioTracks(total: number, onCancel?: () => void) {
  clearAudioCancel();
  if (messageEl) messageEl.textContent = "Checking Audio Tracks";
  if (countEl) {
    countEl.textContent = `0 / ${total}`;
    countEl.removeAttribute("hidden");
  }
  if (progressEl && total > 0) {
    progressEl.max = total;
    progressEl.value = 0;
  }
  if (onCancel && cancelAudioBtn) {
    audioCancelHandler = () => {
      clearAudioCancel();
      onCancel();
    };
    cancelAudioBtn.addEventListener("click", audioCancelHandler);
    cancelAudioBtn.removeAttribute("hidden");
  }
  overlay?.removeAttribute("hidden");
  document.getElementById("app")?.setAttribute("aria-busy", "true");
}

export function updateBusyProgress(current: number, total: number) {
  if (messageEl) messageEl.textContent = "Checking Audio Tracks";
  if (countEl) {
    countEl.textContent = `${current} / ${total}`;
    countEl.removeAttribute("hidden");
  }
  if (progressEl && total > 0) {
    progressEl.max = total;
    progressEl.value = current;
  }
}

export function hideBusy() {
  clearAudioCancel();
  overlay?.setAttribute("hidden", "");
  countEl?.setAttribute("hidden", "");
  document.getElementById("app")?.removeAttribute("aria-busy");
  setIndeterminate();
}
