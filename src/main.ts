import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { setupAppMenu } from "./app-menu";
import { hideBusy, showBusy, showCheckingAudioTracks, updateBusyProgress } from "./busy-overlay";
import { pickAudioTracksForSources } from "./audio-track-modal";
import { runMetadataWizard } from "./metadata-flow";
import type { AnalyzeResult } from "./metadata-modal";

type JobStatus =
  | "pending"
  | "encoding"
  | "done"
  | "failed"
  | "cancelled";

interface Job {
  id: string;
  source_path: string;
  tree_root: string | null;
  audio_track?: number | null;
  /** Absolute path to .srt burned into the encode; omitted when none. */
  subtitle_burn_path?: string | null;
  status: JobStatus;
  progress: number | null;
  error: string | null;
}

const queueSection = document.getElementById("queue-section")!;
const queueList = document.getElementById("queue-list")!;
const queueMeta = document.getElementById("queue-meta")!;
const dropzone = document.getElementById("dropzone")!;
const btnFiles = document.getElementById("btn-files")!;
const btnOutput = document.getElementById("btn-output")!;
const btnOutputClear = document.getElementById("btn-output-clear")!;
const outputLabel = document.getElementById("output-label")!;
const btnClearQueue = document.getElementById("btn-clear-queue") as HTMLButtonElement;
const btnCancel = document.getElementById("btn-cancel") as HTMLButtonElement;
const logPre = document.getElementById("log")!;
const logDetails = document.getElementById("log-details") as HTMLDetailsElement;
const hbWarning = document.getElementById("hb-warning")!;
const apWarning = document.getElementById("ap-warning")!;

let jobs: Job[] = [];

/**
 * WebView2 often fails to deliver pointer moves after setPointerCapture.
 * Use window-level mousemove/mouseup (same pattern as reliable HTML5-DnD shims).
 */
function beginQueueReorder(fromIndex: number, startEvent: MouseEvent) {
  if (startEvent.button !== 0) return;
  startEvent.preventDefault();
  startEvent.stopPropagation();

  let lastOver: number | null = null;
  document.body.classList.add("queue-reordering");
  queueList.classList.add("queue-list--dragging");

  const clearHighlights = () => {
    queueList.querySelectorAll(".queue-item--drop-target").forEach((el) => {
      el.classList.remove("queue-item--drop-target");
    });
  };

  const onMove = (ev: MouseEvent) => {
    ev.preventDefault();
    clearHighlights();
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const targetLi = el?.closest?.("li.queue-item") ?? null;
    if (!targetLi) {
      lastOver = null;
      return;
    }
    const raw = targetLi.getAttribute("data-queue-index");
    const qi = raw == null ? NaN : parseInt(raw, 10);
    if (Number.isNaN(qi) || qi === fromIndex) {
      lastOver = null;
      return;
    }
    if (jobs[qi]?.status !== "pending") {
      lastOver = null;
      return;
    }
    lastOver = qi;
    targetLi.classList.add("queue-item--drop-target");
  };

  const finish = (ev: MouseEvent) => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", finish, true);
    document.body.classList.remove("queue-reordering");
    queueList.classList.remove("queue-list--dragging");
    clearHighlights();

    let to = lastOver;
    if (to == null) {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetLi = el?.closest?.("li.queue-item") ?? null;
      if (targetLi) {
        const raw = targetLi.getAttribute("data-queue-index");
        const qi = raw == null ? NaN : parseInt(raw, 10);
        if (!Number.isNaN(qi) && qi !== fromIndex && jobs[qi]?.status === "pending") {
          to = qi;
        }
      }
    }
    if (to == null || to === fromIndex) return;
    const dragged = jobs[fromIndex];
    const target = jobs[to];
    if (!dragged || !target || dragged.status !== "pending" || target.status !== "pending") return;
    const next = arrayMoveJobOrder(jobs, fromIndex, to);
    void invoke("reorder_queue", { jobIds: next.map((j) => j.id) }).catch((err) =>
      appendLog(String(err))
    );
  };

  window.addEventListener("mousemove", onMove, { capture: true, passive: false });
  window.addEventListener("mouseup", finish, { capture: true });
}

function appendLog(line: string) {
  logPre.textContent += line + "\n";
  logDetails.open = true;
}

function subtitleBasename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

function queueItemLabel(job: Job): string {
  if (job.tree_root) {
    const root = job.tree_root.replace(/[/\\]+$/, "").replace(/\\/g, "/");
    const src = job.source_path.replace(/\\/g, "/");
    const prefix = root.toLowerCase() + "/";
    if (src.length > prefix.length && src.toLowerCase().startsWith(prefix)) {
      return src.slice(root.length + 1);
    }
  }
  return job.source_path.split(/[/\\]/).pop() ?? job.source_path;
}

/** Move item from `from` to index `to` (indices in the array before the move). */
function arrayMoveJobOrder(a: Job[], from: number, to: number): Job[] {
  if (from === to) return a;
  const next = [...a];
  const [item] = next.splice(from, 1);
  let insert = to;
  if (from < to) insert = to - 1;
  next.splice(insert, 0, item);
  return next;
}

function renderQueue() {
  queueList.innerHTML = "";
  jobs.forEach((job, index) => {
    const li = document.createElement("li");
    li.className = "queue-item";
    li.dataset.queueIndex = String(index);

    const drag = document.createElement("span");
    drag.className = "queue-drag";
    drag.setAttribute("aria-hidden", "true");
    drag.title =
      job.status === "pending"
        ? "Drag to reorder (pending jobs only)"
        : "Only pending jobs can be reordered";
    drag.textContent = "⠿";
    if (job.status === "pending") {
      drag.title = "Drag to reorder (use this handle)";
      drag.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        beginQueueReorder(index, e);
      });
    } else {
      drag.classList.add("queue-drag--inactive");
    }

    const main = document.createElement("div");
    main.className = "queue-item-main";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = queueItemLabel(job);
    name.title = job.source_path;
    if (job.audio_track != null && job.audio_track >= 1) {
      name.title += `\nAudio track: ${job.audio_track}`;
    }
    if (job.subtitle_burn_path) {
      name.title += `\nBurn-in subtitles: ${job.subtitle_burn_path}`;
    }

    main.appendChild(name);

    if (job.status === "pending") {
      const sub = document.createElement("div");
      sub.className = "queue-sub";
      const meta = document.createElement("span");
      meta.className = "queue-sub-meta";
      if (job.subtitle_burn_path) {
        meta.textContent = `Burn-in: ${subtitleBasename(job.subtitle_burn_path)}`;
      } else {
        meta.textContent = "No .srt selected (optional)";
      }
      const btnRow = document.createElement("span");
      btnRow.className = "queue-sub-actions";
      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "queue-sub-btn secondary";
      pick.textContent = "SRT…";
      pick.title = "Choose a SubRip file to burn into the video";
      pick.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void (async () => {
          const selected = await open({
            multiple: false,
            filters: [{ name: "Subtitles", extensions: ["srt"] }],
          });
          if (typeof selected !== "string" || !selected) return;
          try {
            await invoke("set_job_subtitle_burn_path", {
              jobId: job.id,
              path: selected,
            });
          } catch (e) {
            appendLog(String(e));
          }
        })();
      });
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "queue-sub-btn secondary";
      clear.textContent = "Clear";
      clear.disabled = !job.subtitle_burn_path;
      clear.title = "Remove burned-in subtitle for this job";
      clear.addEventListener("click", (ev) => {
        ev.stopPropagation();
        invoke("set_job_subtitle_burn_path", { jobId: job.id, path: null }).catch((e) =>
          appendLog(String(e))
        );
      });
      btnRow.appendChild(pick);
      btnRow.appendChild(clear);
      sub.appendChild(meta);
      sub.appendChild(btnRow);
      main.appendChild(sub);
    }


    const status = document.createElement("span");
    status.className = `status ${job.status}`;
    if (job.status === "encoding" && job.progress != null) {
      status.textContent = `${job.status} ${job.progress.toFixed(1)}%`;
    } else {
      status.textContent = job.status;
    }

    li.appendChild(drag);
    li.appendChild(main);
    li.appendChild(status);

    if (job.status === "pending") {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "remove-btn secondary";
      rm.textContent = "Remove";
      rm.onclick = (ev) => {
        ev.stopPropagation();
        invoke("remove_job", { jobId: job.id }).catch((e) => appendLog(String(e)));
      };
      li.appendChild(rm);
    }

    if (job.status === "failed" && job.error) {
      name.title = job.error;
    }

    queueList.appendChild(li);
  });

  const n = jobs.length;
  queueSection.classList.toggle("queue-section--empty", n === 0);
  if (n === 0) {
    queueMeta.hidden = true;
    queueMeta.textContent = "";
  } else {
    queueMeta.hidden = false;
    queueMeta.textContent = `${n} ${n === 1 ? "file" : "files"} queued`;
  }

  const encoding = jobs.find((j) => j.status === "encoding");
  btnCancel.disabled = !encoding;
  // Clear everything except the job currently encoding (pending / done / failed / cancelled are all removable).
  btnClearQueue.disabled = !jobs.some((j) => j.status !== "encoding");
}

async function refreshQueue() {
  try {
    jobs = await invoke<Job[]>("get_queue");
    renderQueue();
  } catch (e) {
    appendLog(String(e));
  }
}

async function enqueuePathsWithMetadata(paths: string[]) {
  if (paths.length === 0) return;
  try {
    showBusy("Scanning folder for video files…");
    const analysis = await invoke<AnalyzeResult>("analyze_inputs", { paths });
    hideBusy();
    if (analysis.files.length === 0) {
      appendLog("No video files found.");
      return;
    }
    const wizard = await runMetadataWizard(analysis, appendLog);
    if (wizard.outcome === "cancel") return;

    const sources = analysis.files.map((f) => f.sourcePath);
    const audioScanAbort = new AbortController();
    showCheckingAudioTracks(sources.length, () => audioScanAbort.abort());
    const audioMap = await pickAudioTracksForSources(
      sources,
      appendLog,
      (current, total) => {
        updateBusyProgress(current, total);
      },
      audioScanAbort.signal
    );
    if (audioMap === null) return;

    const audioTracks = Object.fromEntries(audioMap) as Record<string, number>;

    if (wizard.outcome === "skip") {
      const res = await invoke<{ added: number; skipped_duplicates: number }>("enqueue", {
        req: { paths, audioTracks },
      });
      if (res.skipped_duplicates > 0) {
        appendLog(`Skipped ${res.skipped_duplicates} duplicate path(s).`);
      }
    } else {
      const items = wizard.items.map((item) => {
        const audioTrack = audioMap.get(item.sourcePath);
        return audioTrack !== undefined ? { ...item, audioTrack } : item;
      });
      const res = await invoke<{ added: number; skipped_duplicates: number }>("enqueue_with_tags", {
        items,
      });
      if (res.skipped_duplicates > 0) {
        appendLog(`Skipped ${res.skipped_duplicates} duplicate path(s).`);
      }
    }
    await refreshQueue();
  } catch (e) {
    appendLog(String(e));
  } finally {
    hideBusy();
  }
}

function setupDropzone() {
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  });

  void getCurrentWindow()
    .onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        dropzone.classList.add("dragover");
      } else if (event.payload.type === "leave") {
        dropzone.classList.remove("dragover");
      } else if (event.payload.type === "drop") {
        dropzone.classList.remove("dragover");
        const paths = event.payload.paths.filter((p) => p.length > 0);
        void enqueuePathsWithMetadata(paths);
      }
    })
    .catch(() => {
      appendLog("Drag-and-drop API unavailable; use Choose files.");
    });
}

btnFiles.addEventListener("click", () => {
  void pickFilesViaDialog();
});

async function pickFilesViaDialog() {
  const selected = await open({
    multiple: true,
    filters: [
      {
        name: "Video",
        extensions: ["mkv", "mp4", "m4v", "avi", "mov", "webm", "mpeg", "mpg", "wmv", "flv"],
      },
    ],
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  await enqueuePathsWithMetadata(paths);
}

btnOutput.addEventListener("click", async () => {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir !== "string" || !dir) return;
  try {
    await invoke("set_default_output_dir", { path: dir });
    outputLabel.textContent = dir;
  } catch (e) {
    appendLog(String(e));
  }
});

btnOutputClear.addEventListener("click", async () => {
  try {
    await invoke("set_default_output_dir", { path: null });
    outputLabel.textContent = "Same as Source File";
  } catch (e) {
    appendLog(String(e));
  }
});

btnClearQueue.addEventListener("click", () => {
  invoke<number>("clear_pending_jobs")
    .then((n) => {
      if (n > 0) appendLog(`Removed ${n} job(s) from the queue.`);
    })
    .catch((e) => appendLog(String(e)));
});

btnCancel.addEventListener("click", () => {
  invoke("cancel_current").catch((e) => appendLog(String(e)));
});

void (async () => {
  setupDropzone();
  setupAppMenu(appendLog);

  listen<Job[]>("queue-changed", (e) => {
    jobs = e.payload;
    renderQueue();
  }).catch(() => {});

  try {
    const settings = await invoke<{ default_output_dir: string | null }>("get_settings");
    outputLabel.textContent =
      settings.default_output_dir ?? "Same as Source File";
  } catch {
    outputLabel.textContent = "Same as Source File";
  }

  try {
    const probe = await invoke<{ ok: boolean; message: string }>("probe_handbrake");
    if (!probe.ok) {
      hbWarning.hidden = false;
      hbWarning.textContent = probe.message;
    }
  } catch (e) {
    hbWarning.hidden = false;
    hbWarning.textContent = String(e);
  }

  try {
    const ap = await invoke<{ ok: boolean; message: string }>("probe_atomicparsley");
    if (!ap.ok) {
      apWarning.hidden = false;
      apWarning.textContent = `AtomicParsley: ${ap.message} Tagging after encode will fail until this is fixed.`;
    }
  } catch (e) {
    apWarning.hidden = false;
    apWarning.textContent = String(e);
  }

  await refreshQueue();
})();
