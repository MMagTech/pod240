/**
 * In-app menu (styled to match UI) and dialogs (TMDB key, Tag Reference, Help, About).
 */

import { invoke } from "@tauri-apps/api/core";

const HOST_ID = "app-menu-modal-host";

/** e.g. `HandBrake 1.11.1` → `1.11.1` */
function shortenHandBrakeVersionLabel(line: string): string {
  const m = line.trim().match(/HandBrake\s+([\d.]+)/i);
  return m?.[1] ?? line.trim();
}

/** Release tag only (e.g. `20240608.083822.0`), drops git hash / `(utf16)` noise. */
function shortenAtomicParsleyVersionLabel(line: string): string {
  const t = line.trim();
  const labeled = t.match(/AtomicParsley\s+version:\s*(\S+)/i);
  if (labeled) return labeled[1]!;
  const token = t.match(/(\d{8}\.\d+(?:\.\d+)?)/);
  if (token) return token[1]!;
  return t.length <= 40 ? t : `${t.slice(0, 37)}…`;
}

/** e.g. `ffmpeg version 8.1-essentials_build-www.gyan.dev` → `8.1` */
function shortenFfmpegVersionLabel(line: string): string {
  const t = line.trim();
  const m = t.match(/ffmpeg\s+version\s+(\d+\.\d+(?:\.\d+)?)/i);
  if (m) return m[1]!;
  const loose = t.match(/(\d+\.\d+(?:\.\d+)?)/);
  if (loose) return loose[1]!;
  return t.length <= 28 ? t : `${t.slice(0, 25)}…`;
}

const TOOL_LINKS = {
  handbrake: "https://handbrake.fr/",
  atomicParsley: "https://github.com/wez/atomicparsley",
  ffmpeg: "https://ffmpeg.org/",
} as const;

function renderAboutBundledVersions(
  el: HTMLElement,
  hb: string,
  ap: string,
  ff: string
): void {
  el.textContent = "";
  el.className = "app-about-bundled-tools";

  const rows: Array<{ name: string; href: string; version: string }> = [
    { name: "HandBrake CLI", href: TOOL_LINKS.handbrake, version: hb },
    { name: "AtomicParsley", href: TOOL_LINKS.atomicParsley, version: ap },
    { name: "FFmpeg", href: TOOL_LINKS.ffmpeg, version: ff },
  ];

  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "app-about-tool-ver-line";

    const a = document.createElement("a");
    a.className = "app-menu-external-link";
    a.href = row.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = row.name;

    line.appendChild(a);
    line.appendChild(document.createTextNode(` — ${row.version}`));
    el.appendChild(line);
  }
}

function getHost(): HTMLElement | null {
  return document.getElementById(HOST_ID);
}

/** Menu dialogs (TMDB, Tag Reference, Help, About): close only via the dialog’s Close button, not backdrop or Escape. */
function mountOverlay(overlay: HTMLElement): () => void {
  const host = getHost();
  if (!host) return () => {};
  host.innerHTML = "";
  host.appendChild(overlay);

  const close = () => {
    host.innerHTML = "";
  };

  return close;
}

export function showTmdbKeyDialog(appendLog: (s: string) => void): void {
  const host = getHost();
  if (!host) return;

  const overlay = document.createElement("div");
  overlay.className = "meta-overlay";

  overlay.innerHTML = `
    <div class="meta-panel app-menu-dialog" role="dialog" aria-modal="true" aria-labelledby="tmdb-dialog-title">
      <h2 id="tmdb-dialog-title">TMDB API Key</h2>
      <p class="meta-hint">Stored only on this PC. Used for <strong>Fetch Poster</strong> and <strong>Fetch Tags from TMDB</strong> in the metadata dialogs.</p>
      <p class="meta-tiny app-menu-tmdb-docs">
        <a class="app-menu-external-link" href="https://developer.themoviedb.org/docs/getting-started" target="_blank" rel="noopener noreferrer">TMDB: Getting Started</a>
        — how to register and obtain an API key.
      </p>
      <label class="app-menu-label">API Key
        <input type="text" id="app-tmdb-input" class="meta-input" placeholder="Paste Key" autocomplete="off" spellcheck="false" />
      </label>
      <p class="meta-tiny">This product uses the TMDB API but is not endorsed by TMDB.</p>
      <div class="meta-actions">
        <button type="button" class="secondary" id="app-tmdb-cancel">Cancel</button>
        <button type="button" class="secondary" id="app-tmdb-clear">Clear</button>
        <button type="button" id="app-tmdb-save">Save</button>
      </div>
    </div>`;

  const close = mountOverlay(overlay);
  const input = overlay.querySelector("#app-tmdb-input") as HTMLInputElement;

  void invoke<{ tmdb_api_key?: string | null }>("get_settings").then((s) => {
    const k = s.tmdb_api_key;
    if (k) input.value = k;
  });

  overlay.querySelector("#app-tmdb-cancel")!.addEventListener("click", close);
  overlay.querySelector("#app-tmdb-clear")!.addEventListener("click", async () => {
    try {
      await invoke("set_tmdb_api_key", { key: null });
      input.value = "";
      appendLog("TMDB API key cleared.");
    } catch (e) {
      appendLog(String(e));
    }
    close();
  });
  overlay.querySelector("#app-tmdb-save")!.addEventListener("click", async () => {
    const key = input.value.trim();
    try {
      await invoke("set_tmdb_api_key", { key: key || null });
      appendLog(key ? "TMDB API key saved." : "TMDB API key cleared.");
    } catch (e) {
      appendLog(String(e));
    }
    close();
  });
}

/** iTunes / MPEG-4 atom names used when writing tags (AtomicParsley). */
export function showTagReferenceDialog(): void {
  const host = getHost();
  if (!host) return;

  const overlay = document.createElement("div");
  overlay.className = "meta-overlay";

  overlay.innerHTML = `
    <div class="meta-panel app-menu-dialog app-menu-tag-ref-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-ref-title">
      <h2 id="tag-ref-title">Tag Reference</h2>
      <p class="meta-hint">Field labels in metadata map to these atoms when Pod240 tags your file. © indicates a classic iTunes four-character code.</p>
      <div class="app-menu-tag-ref-body">
        <h3 class="app-menu-tag-ref-h3">Media Kind</h3>
        <dl class="app-menu-tag-dl">
          <dt>stik 9</dt><dd>Movie</dd>
          <dt>stik 10</dt><dd>TV Show</dd>
          <dt>stik 6</dt><dd>Music Video</dd>
        </dl>
        <h3 class="app-menu-tag-ref-h3">Movie &amp; TV (Main Fields)</h3>
        <dl class="app-menu-tag-dl">
          <dt>©nam</dt><dd>Title (Movie), Episode Title (TV), or Song Name (Music Video)</dd>
          <dt>©gen</dt><dd>Genre</dd>
          <dt>tvsh</dt><dd>TV Show Name</dd>
          <dt>tvsn</dt><dd>Season Number</dd>
          <dt>tves</dt><dd>Episode Number</dd>
          <dt>tven</dt><dd>Episode ID</dd>
          <dt>tvnn</dt><dd>TV Network</dd>
          <dt>sosn</dt><dd>Sort Show (List Order)</dd>
        </dl>
        <h3 class="app-menu-tag-ref-h3">Music Video</h3>
        <dl class="app-menu-tag-dl">
          <dt>©ART</dt><dd>Artist</dd>
          <dt>aART</dt><dd>Album Artist</dd>
          <dt>©alb</dt><dd>Album</dd>
          <dt>©wrt</dt><dd>Composer (Optional Tags)</dd>
          <dt>cpil</dt><dd>Compilation</dd>
        </dl>
        <h3 class="app-menu-tag-ref-h3">Optional Tags</h3>
        <dl class="app-menu-tag-dl">
          <dt>desc</dt><dd>Short Description</dd>
          <dt>ldes</dt><dd>Full Description</dd>
          <dt>©day</dt><dd>Release Date</dd>
          <dt>sonm</dt><dd>Sort Title</dd>
          <dt>hdvd</dt><dd>HD Video Flag</dd>
          <dt>rtng</dt><dd>Content Rating</dd>
          <dt>©too</dt><dd>Encoder (Tool Name)</dd>
          <dt>cprt</dt><dd>Copyright</dd>
        </dl>
      </div>
      <p class="meta-tiny">Tags are written with <a class="app-menu-external-link" href="https://github.com/wez/atomicparsley" target="_blank" rel="noopener noreferrer">AtomicParsley</a>. See its documentation for valid rating and date formats.</p>
      <div class="meta-actions">
        <button type="button" id="app-tag-ref-close">Close</button>
      </div>
    </div>`;

  const close = mountOverlay(overlay);
  overlay.querySelector("#app-tag-ref-close")!.addEventListener("click", close);
}

export function showHelpDialog(): void {
  const host = getHost();
  if (!host) return;

  const overlay = document.createElement("div");
  overlay.className = "meta-overlay";

  overlay.innerHTML = `
    <div class="meta-panel app-menu-dialog app-help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-dialog-title">
      <h2 id="help-dialog-title">How Pod240 works</h2>
      <div class="app-help-body">
        <ol>
          <li><strong>Add Videos</strong> — Drop files or folders on the drop zone, or use <strong>Select…</strong>. Outputs usually go next to each source file unless you set a default output folder (see below). Folders can mirror their layout under that folder. If a file has <strong>multiple audio tracks</strong>, you may be asked which track to use before the queue is filled. <strong>DRM-protected</strong> store purchases cannot be converted.</li>
          <li><strong>Output Folder</strong> — Leave as <strong>Same as Source File</strong> or use <strong>Select…</strong> (and <strong>Clear</strong> to reset) so batch jobs go under one root (e.g. Show Name / Season …). Single-file drops still follow the usual naming rules next to the source or under the chosen folder.</li>
          <li><strong>Metadata Dialog</strong> — First choose <strong>Add Metadata</strong> or <strong>Skip</strong>. Folders with several movies open one dialog per file (the button explains when another file follows). Use <strong>Back</strong> to return to the previous file or season. TV folders may use a step per season, then unparsed filenames if needed. Optional TMDB: <strong>Menu → Add TMDB API Key</strong> to paste or clear a key; in metadata, use <strong>Fetch Poster</strong> (cover) or <strong>Fetch Tags from TMDB</strong>. Atom names (©nam, stik, …) are summarized under <strong>Menu → Tag Reference</strong>. Choose <strong>Movie</strong> or <strong>TV Show</strong> so imports sort into Movies or TV Shows in iTunes; <strong>Skip</strong> (or Skip Tagging) often lands under <strong>Home Videos</strong>. <strong>Embedded cover:</strong> Pod240 can show a cover already in the file; you can choose not to carry it to the <strong>converted</strong> file only—<strong>original files are never modified</strong>.</li>
          <li><strong>Music Video &amp; Covers</strong> — For <strong>Music Video</strong>, you can use <strong>Frame From Video</strong> to grab a still as cover art. If the in-app preview cannot decode your file, optional <strong>FFmpeg</strong> next to the app (see <strong>About</strong>) enables scrubbing and capture.</li>
          <li><strong>Queue Order</strong> — Jobs run <strong>one at a time</strong>. <strong>Drag</strong> the handle on pending rows to change order. <strong>Remove</strong> drops a pending job. <strong>Clear Queue</strong> removes finished, failed, cancelled, and pending rows but <strong>keeps the job currently encoding</strong>. <strong>Cancel Current</strong> stops the active encode. <strong>Burned-in subtitles:</strong> pick <code class="app-about-code">.srt</code> in metadata (sidecar files can be suggested automatically) or use <strong>SRT…</strong> on a pending row if you skipped metadata. Closing the app while something is encoding or waiting prompts you to confirm—progress and the queue are lost if you quit.</li>
          <li><strong>Encode &amp; Log</strong> — Pod240 uses the Olsro <strong>240p30</strong> HandBrake preset for iPod Classic / Video. Tags from metadata are written after the encode (AtomicParsley). Warnings at the bottom of the window appear if HandBrake or AtomicParsley is missing; the collapsible <strong>Log</strong> shows status and errors.</li>
        </ol>
      </div>
      <div class="meta-actions">
        <button type="button" id="app-help-close">Close</button>
      </div>
    </div>`;

  const close = mountOverlay(overlay);
  overlay.querySelector("#app-help-close")!.addEventListener("click", close);
}

export function showAboutDialog(): void {
  const host = getHost();
  if (!host) return;

  const overlay = document.createElement("div");
  overlay.className = "meta-overlay";

  overlay.innerHTML = `
    <div class="meta-panel app-menu-dialog app-about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-dialog-title">
      <h2 id="about-dialog-title">About</h2>
      <div class="app-about-body">
        <p class="meta-hint">Pod240 Uses These Projects And Resources:</p>
        <ul class="app-about-links">
          <li>
            <a class="app-menu-external-link" href="https://handbrake.fr/" target="_blank" rel="noopener noreferrer">HandBrake</a>
            — Open-source video transcoder (CLI used for encoding).
          </li>
          <li>
            <a class="app-menu-external-link" href="https://github.com/wez/atomicparsley" target="_blank" rel="noopener noreferrer">AtomicParsley</a>
            — MPEG-4 metadata for iTunes-style tags on your exports.
          </li>
          <li>
            <a class="app-menu-external-link" href="https://github.com/Olsro/reddit-ipod-guides" target="_blank" rel="noopener noreferrer">Olsro&rsquo;s iPod Guides</a>
            — Community guides (including 240p / iPod Classic &amp; Video encoding).
          </li>
        </ul>
        <p class="app-about-bundled-tools" id="app-about-tool-versions" aria-live="polite">
          Loading bundled tool versions…
        </p>
        <p class="app-about-thanks"><strong>Thanks</strong> to <strong><a class="app-menu-external-link" href="https://github.com/Olsro" target="_blank" rel="noopener noreferrer">Olsro</a></strong> for their outstanding work documenting and supporting the iPod community.</p>
        <p class="app-about-thanks"><strong>Thanks</strong> to <strong><a class="app-menu-external-link" href="https://github.com/FT129/Handbrake-and-FFmpeg-with-fdk-aac/" target="_blank" rel="noopener noreferrer">FT129</a></strong> for the Windows <code class="app-about-code">HandBrakeCLI.exe</code> and <code class="app-about-code">hb.dll</code> builds that include FDK‑AAC.</p>
      </div>
      <div class="meta-actions">
        <button type="button" id="app-about-close">Close</button>
      </div>
    </div>`;

  const close = mountOverlay(overlay);
  overlay.querySelector("#app-about-close")!.addEventListener("click", close);

  const verEl = overlay.querySelector("#app-about-tool-versions") as HTMLElement | null;
  void invoke<{
    handbrakeCli: string | null;
    atomicParsley: string | null;
    ffmpeg: string | null;
  }>("get_tool_versions")
    .then((v) => {
      if (!verEl) return;
      const hbLine = v.handbrakeCli?.trim() || "";
      const apLine =
        v.atomicParsley?.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() || "";
      const ffLine = v.ffmpeg?.split(/\r?\n/).find((l) => l.trim().startsWith("ffmpeg version"))?.trim() || "";
      const hb = hbLine ? shortenHandBrakeVersionLabel(hbLine) : "Not available";
      const ap = apLine ? shortenAtomicParsleyVersionLabel(apLine) : "Not available";
      const ff = ffLine ? shortenFfmpegVersionLabel(ffLine) : "Not available (optional — music video frame grab)";
      renderAboutBundledVersions(verEl, hb, ap, ff);
    })
    .catch(() => {
      if (verEl) verEl.textContent = "Could not read bundled tool versions.";
    });
}

function wireInAppMenu(appendLog: (s: string) => void): void {
  const wrap = document.getElementById("app-menu-wrap");
  const trigger = document.getElementById("btn-app-menu");
  const dropdown = document.getElementById("app-menu-dropdown");
  if (!wrap || !trigger || !dropdown) return;

  const close = () => {
    dropdown.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };

  const open = () => {
    dropdown.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dropdown.hidden) open();
    else close();
  });

  document.addEventListener("click", (e) => {
    if (dropdown.hidden) return;
    if (!wrap.contains(e.target as Node)) close();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dropdown.hidden) close();
  });

  const bind = (id: string, fn: () => void) => {
    document.getElementById(id)?.addEventListener("click", () => {
      close();
      fn();
    });
  };

  bind("menu-item-tmdb", () => showTmdbKeyDialog(appendLog));
  bind("menu-item-tag-ref", () => showTagReferenceDialog());
  bind("menu-item-help", () => showHelpDialog());
  bind("menu-item-about", () => showAboutDialog());
}

export function setupAppMenu(appendLog: (s: string) => void): void {
  wireInAppMenu(appendLog);
}
