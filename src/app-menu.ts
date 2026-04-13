/**
 * Native app menu and dialogs (TMDB key, Tag Reference, Help, About).
 */

import { invoke } from "@tauri-apps/api/core";
import { Menu, MenuItem, Submenu } from "@tauri-apps/api/menu";
import { attachConfirmedBackdropDismiss } from "./modal-backdrop";

const HOST_ID = "app-menu-modal-host";

function getHost(): HTMLElement | null {
  return document.getElementById(HOST_ID);
}

function mountOverlay(overlay: HTMLElement): () => void {
  const host = getHost();
  if (!host) return () => {};
  host.innerHTML = "";
  host.appendChild(overlay);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  let removeBackdrop: () => void = () => {};

  const close = () => {
    document.removeEventListener("keydown", onKey);
    removeBackdrop();
    host.innerHTML = "";
  };

  removeBackdrop = attachConfirmedBackdropDismiss(overlay, close, "app-menu");

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
          <dt>ldes</dt><dd>Long Description</dd>
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
          <li><strong>Add videos</strong> — Drop files or folders on the drop zone, or use <strong>Select…</strong>. One file encodes next to that file; a folder can keep its layout under an optional default output folder.</li>
          <li><strong>Output folder</strong> — Leave as <strong>Same as Source File</strong> or <strong>Select…</strong> to send everything under one root (e.g. Show Name / Season …).</li>
          <li><strong>Metadata</strong> — First choose <strong>Add Metadata</strong> or <strong>Skip</strong>. Folders with several movies open one dialog per file (the button explains when another file follows). Use <strong>Back</strong> to return to the previous file or season if you advanced by mistake. TV folders may use a step per season, then unparsed filenames if needed. Optional TMDB: open <strong>Menu → Add TMDB API Key</strong> to paste a key or choose <strong>Clear</strong> there to remove it; then use <strong>Fetch Poster</strong> (artwork) or <strong>Fetch Tags from TMDB</strong> (text fields) in metadata. <strong>iTunes atom names</strong> (©nam, stik, …) are listed under <strong>Menu → Tag Reference</strong>. <strong>iTunes:</strong> use <strong>Movie</strong> or <strong>TV Show</strong> so files land under Movies or TV Shows; <strong>Skip</strong> (or per-file Skip Tagging) encodes without iTunes media kind, so imports often appear under <strong>Home Videos</strong>.</li>
          <li><strong>Queue</strong> — Jobs run <strong>one at a time</strong>. Remove pending jobs or cancel the current encode if needed.</li>
          <li><strong>Encode</strong> — Pod240 uses the Olsro <strong>240p30</strong> HandBrake preset for iPod Classic / Video. HandBrake CLI must be available to the app; AtomicParsley is used when you add tags.</li>
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
        <p class="app-about-thanks"><strong>Thanks</strong> to <strong>Olsro</strong> for their outstanding work documenting and supporting the iPod community.</p>
      </div>
      <div class="meta-actions">
        <button type="button" id="app-about-close">Close</button>
      </div>
    </div>`;

  const close = mountOverlay(overlay);
  overlay.querySelector("#app-about-close")!.addEventListener("click", close);
}

export async function setupAppMenu(appendLog: (s: string) => void): Promise<void> {
  try {
    const menuBar = await Submenu.new({
      text: "Menu...",
      items: [
        await MenuItem.new({
          id: "menu-add-tmdb-key",
          text: "Add TMDB API Key",
          action: () => {
            showTmdbKeyDialog(appendLog);
          },
        }),
        await MenuItem.new({
          id: "menu-tag-reference",
          text: "Tag Reference",
          action: () => {
            showTagReferenceDialog();
          },
        }),
        await MenuItem.new({
          id: "menu-help",
          text: "Help",
          action: () => {
            showHelpDialog();
          },
        }),
        await MenuItem.new({
          id: "menu-about",
          text: "About",
          action: () => {
            showAboutDialog();
          },
        }),
      ],
    });

    const menu = await Menu.new({
      items: [menuBar],
    });
    await menu.setAsAppMenu();
  } catch (e) {
    appendLog(`Menu: ${String(e)}`);
  }
}
