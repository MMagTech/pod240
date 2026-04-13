/**
 * Pre-queue metadata: iTunes tags for HandBrake output (AtomicParsley).
 */

import { invoke } from "@tauri-apps/api/core";
import { dbgSession } from "./debug-session-log";
import {
  applyCommonTagFields,
  commonTagFieldsHtml,
  readCommonTagFields,
  type CommonTagFields,
} from "./metadata-common";
import { parseFilenameMetadataHints } from "./filename-metadata-hints";
import {
  enrichWithTvEpisodeTitle,
  fetchTmdbDetailsById,
  fetchTmdbMetadataFromImdbId,
  findTmdbIdsByImdbId,
  type TmdbFilledMetadata,
} from "./tmdb-metadata";
import {
  clearTmdbPosterPicker,
  downloadTmdbPosterBase64,
  mountTmdbPosterPicker,
  searchTmdbPosterCandidates,
  type TmdbSearchMode,
} from "./tmdb-posters";
import { EMBEDDED_ARTWORK_SECTION_HTML, initEmbeddedArtworkBlock } from "./embedded-artwork-ui";

const META_ART_FILENAME_EMPTY = "No Image Selected";

function syncMetaArtFilenameDisplay(input: HTMLInputElement, labelEl: HTMLElement) {
  const f = input.files?.[0];
  labelEl.textContent = f ? f.name : META_ART_FILENAME_EMPTY;
}

/** Clears a manual artwork file so a TMDB-fetched poster fully replaces it. */
function clearManualArtFilePick(artFile: HTMLInputElement, labelEl: HTMLElement) {
  artFile.value = "";
  syncMetaArtFilenameDisplay(artFile, labelEl);
}

export interface EpisodeParseInfo {
  ok: boolean;
  season: number | null;
  episode: number | null;
  inferredShow: string | null;
}

export interface AnalyzedFile {
  sourcePath: string;
  treeRoot: string | null;
  parse: EpisodeParseInfo;
}

export interface AnalyzeResult {
  files: AnalyzedFile[];
  suggestBatchTv: boolean;
  seasonGroups: { season: number; fileIndices: number[] }[];
  /** Indices into `files` with failed episode filename parse. */
  unparsedFileIndices: number[];
}

export type EmbeddableTagsPayload =
  | { kind: "skip" }
  | ({ kind: "movie"; title: string; year?: number; artworkBase64?: string } & CommonTagFields)
  | ({
      kind: "tv";
      showName: string;
      season: number;
      episode: number;
      episodeTitle?: string;
      artworkBase64?: string;
      episodeId?: string;
      tvNetwork?: string;
      sortShow?: string;
    } & CommonTagFields)
  | ({
      kind: "musicVideo";
      title: string;
      artist: string;
      artworkBase64?: string;
      albumArtist?: string;
      album?: string;
      composer?: string;
      compilation?: boolean;
    } & CommonTagFields);

export interface EnqueueTaggedItemPayload {
  sourcePath: string;
  treeRoot: string | null;
  tags: EmbeddableTagsPayload;
  /** HandBrake 1-based audio source track. */
  audioTrack?: number;
}

export type SingleFileMetadataResult =
  | { type: "cancel" }
  | { type: "back" }
  | { type: "tagged"; item: EnqueueTaggedItemPayload };

export function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

export function stem(p: string): string {
  const b = basename(p);
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(0, dot) : b;
}

function applyOverviewToOptionalTags(
  overlay: HTMLElement,
  prefix: string,
  overview: string | undefined
): void {
  const ov = overview?.trim();
  if (!ov) return;
  const desc = overlay.querySelector(`#${prefix}-desc`) as HTMLTextAreaElement | null;
  const ldes = overlay.querySelector(`#${prefix}-ldes`) as HTMLTextAreaElement | null;
  if (desc) desc.value = ov.length > 400 ? `${ov.slice(0, 397)}…` : ov;
  if (ldes) ldes.value = ov;
  const wrap = overlay.querySelector(`#${prefix}-wrap`) as HTMLDetailsElement | null;
  if (wrap) wrap.open = true;
}

/** TMDB text fields + optional descriptions only (no artwork). */
function applyTmdbTagsToSingleFileForm(
  overlay: HTMLElement,
  kind: "movie" | "tv",
  meta: TmdbFilledMetadata
): void {
  if (kind === "movie" && meta.kind === "movie") {
    (overlay.querySelector("#mv-title") as HTMLInputElement).value = meta.title;
    if (meta.year != null) {
      (overlay.querySelector("#mv-year") as HTMLInputElement).value = String(meta.year);
    }
    if (meta.genres) {
      (overlay.querySelector("#mv-genre") as HTMLInputElement).value = meta.genres;
    }
  } else if (kind === "tv" && meta.kind === "tv") {
    (overlay.querySelector("#tv-show") as HTMLInputElement).value = meta.title;
    if (meta.episodeTitle) {
      (overlay.querySelector("#tv-etitle") as HTMLInputElement).value = meta.episodeTitle;
    }
    if (meta.genres) {
      (overlay.querySelector("#tv-genre") as HTMLInputElement).value = meta.genres;
    }
  }
  applyOverviewToOptionalTags(overlay, "meta-common", meta.overview);
}

function applyTmdbTagsToTvSharedForm(
  overlay: HTMLElement,
  prefix: string,
  meta: TmdbFilledMetadata,
  showInputSelector: string,
  genreInputSelector: string
): void {
  if (meta.kind !== "tv") return;
  (overlay.querySelector(showInputSelector) as HTMLInputElement).value = meta.title;
  if (meta.genres) {
    (overlay.querySelector(genreInputSelector) as HTMLInputElement).value = meta.genres;
  }
  applyOverviewToOptionalTags(overlay, prefix, meta.overview);
}

function applyEnqueueItemToSingleFileForm(
  overlay: HTMLElement,
  file: AnalyzedFile,
  item: EnqueueTaggedItemPayload
): "movie" | "tv" | "musicVideo" | "skip" {
  if (item.sourcePath !== file.sourcePath) return "movie";
  const tags = item.tags;
  let kind: "movie" | "tv" | "musicVideo" | "skip";
  if (tags.kind === "skip") kind = "skip";
  else if (tags.kind === "tv") kind = "tv";
  else if (tags.kind === "musicVideo") kind = "musicVideo";
  else kind = "movie";

  if (tags.kind === "movie") {
    (overlay.querySelector("#mv-title") as HTMLInputElement).value = tags.title;
    (overlay.querySelector("#mv-year") as HTMLInputElement).value =
      tags.year != null ? String(tags.year) : "";
    (overlay.querySelector("#mv-genre") as HTMLInputElement).value = tags.genre ?? "";
  }
  if (tags.kind === "tv") {
    (overlay.querySelector("#tv-show") as HTMLInputElement).value = tags.showName;
    (overlay.querySelector("#tv-seas") as HTMLInputElement).value = String(tags.season);
    (overlay.querySelector("#tv-ep") as HTMLInputElement).value = String(tags.episode);
    (overlay.querySelector("#tv-etitle") as HTMLInputElement).value = tags.episodeTitle ?? "";
    (overlay.querySelector("#tv-epid") as HTMLInputElement).value = tags.episodeId ?? "";
    (overlay.querySelector("#tv-net") as HTMLInputElement).value = tags.tvNetwork ?? "";
    (overlay.querySelector("#tv-sorts") as HTMLInputElement).value = tags.sortShow ?? "";
    (overlay.querySelector("#tv-genre") as HTMLInputElement).value = tags.genre ?? "";
  }
  if (tags.kind === "musicVideo") {
    (overlay.querySelector("#mvv-song") as HTMLInputElement).value = tags.title;
    (overlay.querySelector("#mvv-artist") as HTMLInputElement).value = tags.artist;
    (overlay.querySelector("#mvv-aart") as HTMLInputElement).value = tags.albumArtist ?? "";
    (overlay.querySelector("#mvv-album") as HTMLInputElement).value = tags.album ?? "";
    (overlay.querySelector("#mvv-genre") as HTMLInputElement).value = tags.genre ?? "";
    const comp = overlay.querySelector("#meta-common-composer") as HTMLInputElement | null;
    if (comp) comp.value = tags.composer ?? "";
    (overlay.querySelector("#mvv-cpil") as HTMLInputElement).checked = !!tags.compilation;
  }

  if (tags.kind !== "skip") {
    const t = tags as CommonTagFields & { artworkBase64?: string };
    const common: CommonTagFields = {};
    if (t.description) common.description = t.description;
    if (t.longDescription) common.longDescription = t.longDescription;
    if (t.releaseDate) common.releaseDate = t.releaseDate;
    if (t.sortTitle) common.sortTitle = t.sortTitle;
    if (t.hdVideo) common.hdVideo = t.hdVideo;
    if (t.contentRating) common.contentRating = t.contentRating;
    if (t.encoder) common.encoder = t.encoder;
    if (t.copyright) common.copyright = t.copyright;
    if (Object.keys(common).length > 0) {
      applyCommonTagFields(overlay, "meta-common", common);
      const wrap = overlay.querySelector("#meta-common-wrap") as HTMLDetailsElement | null;
      if (wrap) wrap.open = true;
    }
    if (t.artworkBase64) {
      const artPreview = overlay.querySelector("#meta-art-preview") as HTMLDivElement;
      artPreview.hidden = false;
      artPreview.innerHTML = `<img src="data:image/jpeg;base64,${t.artworkBase64}" alt="" />`;
    }
  }

  overlay.querySelectorAll(".meta-type-btn").forEach((b) => {
    const el = b as HTMLButtonElement;
    el.classList.toggle("active", el.dataset.kind === kind);
  });
  const secMovie = overlay.querySelector("#meta-movie") as HTMLDivElement;
  const secTvSingle = overlay.querySelector("#meta-tv-single") as HTMLDivElement;
  const secMv = overlay.querySelector("#meta-mv") as HTMLDivElement;
  const secCommon = overlay.querySelector("#meta-common-wrap") as HTMLElement | null;
  const secArt = overlay.querySelector("#meta-art") as HTMLDivElement | null;
  secMovie.hidden = kind !== "movie";
  secTvSingle.hidden = kind !== "tv";
  secMv.hidden = kind !== "musicVideo";
  if (secCommon) secCommon.hidden = kind === "skip";
  if (secArt) secArt.hidden = kind === "skip";
  return kind;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      const i = s.indexOf("base64,");
      resolve(i >= 0 ? s.slice(i + 7) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function getStoredTmdbApiKey(): Promise<string | null> {
  const s = await invoke<{ tmdb_api_key?: string | null }>("get_settings");
  const k = s.tmdb_api_key?.trim();
  return k || null;
}

function getModalHost(): HTMLElement | null {
  return document.getElementById("metadata-modal-host");
}

/**
 * Register nothing: metadata dialogs close only via Cancel (no outside click, no Escape).
 */
function attachModalDismiss(
  _overlay: HTMLElement,
  _onCancel: (reason: "escape" | "overlay") => void,
  _ctx: string
): () => void {
  return () => {};
}

export type PromptSingleFileMetadataOptions = {
  showSkipTagging?: boolean;
  /** Folder has multiple videos: one metadata dialog per file; show step text and “next” button label. */
  multiFile?: { fileIndex: number; totalFiles: number };
  /** Show Back to return to the previous file (wizard handles state). */
  canGoBack?: boolean;
  /** Restore fields from a prior visit (same `file.sourcePath`). */
  prefillItem?: EnqueueTaggedItemPayload;
};

/**
 * One file: Movie, TV Show, or Music Video (optional fourth: skip tagging).
 */
export function promptSingleFileMetadata(
  file: AnalyzedFile,
  appendLog: (s: string) => void,
  options?: PromptSingleFileMetadataOptions
): Promise<SingleFileMetadataResult> {
  const showSkipTagging = options?.showSkipTagging ?? false;
  const multi = options?.multiFile;
  const canGoBack = options?.canGoBack ?? false;
  const prefillItem = options?.prefillItem;
  return new Promise((resolve) => {
    const hostEl = getModalHost();
    if (!hostEl) {
      resolve({ type: "cancel" });
      return;
    }
    const modalHost = hostEl;

    const p = file.parse;
    let kind: "movie" | "tv" | "musicVideo" | "skip" = p.ok ? "tv" : "movie";

    const overlay = document.createElement("div");
    overlay.className = "meta-overlay";
    const skipBtn = showSkipTagging
      ? `<button type="button" class="meta-type-btn secondary" data-kind="skip">Skip Tagging</button>`
      : "";

    overlay.innerHTML = `
      <div class="meta-panel meta-panel--single-file" role="dialog" aria-modal="true" aria-labelledby="meta-sf-title">
        <h2 id="meta-sf-title">Metadata for iTunes / iPod</h2>
        <p id="meta-sf-multi" class="meta-hint meta-multi-file-banner" hidden></p>
        <p class="meta-hint">Choose a Category and fill out Tags</p>
        <div class="meta-type-grid">
          <button type="button" class="meta-type-btn" data-kind="movie">Movie</button>
          <button type="button" class="meta-type-btn" data-kind="tv">TV Show</button>
          <button type="button" class="meta-type-btn" data-kind="musicVideo">Music Video</button>
          ${skipBtn}
        </div>
        <div id="meta-movie" class="meta-section" hidden>
          <p class="meta-section-label">Movie</p>
          <label>Title
            <input type="text" id="mv-title" class="meta-input" /></label>
          <div class="meta-row2">
            <label>Year <input type="number" id="mv-year" class="meta-input" min="1900" max="2100" placeholder="Optional" /></label>
            <label>Genre
              <input type="text" id="mv-genre" class="meta-input" placeholder="Optional" /></label>
          </div>
        </div>
        <div id="meta-tv-single" class="meta-section" hidden>
          <p class="meta-section-label">TV Show</p>
          <label>Show
            <input type="text" id="tv-show" class="meta-input" /></label>
          <div class="meta-row2">
            <label>Season
              <input type="number" id="tv-seas" class="meta-input" min="0" /></label>
            <label>Episode
              <input type="number" id="tv-ep" class="meta-input" min="1" /></label>
          </div>
          <label>Episode Title
            <input type="text" id="tv-etitle" class="meta-input" placeholder="Optional" /></label>
          <label>Episode ID
            <input type="text" id="tv-epid" class="meta-input" placeholder="Optional" /></label>
          <div class="meta-row2">
            <label>TV Network
              <input type="text" id="tv-net" class="meta-input" placeholder="Optional" /></label>
            <label>Sort Show
              <input type="text" id="tv-sorts" class="meta-input" placeholder="Optional" /></label>
          </div>
          <label>Genre
            <input type="text" id="tv-genre" class="meta-input" placeholder="Optional" /></label>
        </div>
        <div id="meta-mv" class="meta-section" hidden>
          <p class="meta-section-label">Music Video</p>
          <label>Song
            <input type="text" id="mvv-song" class="meta-input" placeholder="Track name" /></label>
          <label>Artist
            <input type="text" id="mvv-artist" class="meta-input" /></label>
          <label>Album Artist
            <input type="text" id="mvv-aart" class="meta-input" placeholder="Optional" /></label>
          <label>Album
            <input type="text" id="mvv-album" class="meta-input" placeholder="Optional" /></label>
          <label>Genre
            <input type="text" id="mvv-genre" class="meta-input" placeholder="Optional" /></label>
          <label class="meta-check-label">
            <input type="checkbox" id="mvv-cpil" /> Compilation
          </label>
        </div>
        <div id="meta-tmdb-tags-section" class="meta-section meta-tmdb-tags-section" hidden>
          <p class="meta-section-label">Tags from TMDB</p>
          <div id="meta-tmdb-tags-block" class="meta-tmdb-fetch-block" hidden>
            <div class="meta-tmdb-row">
              <button type="button" id="meta-tmdb-tags-fetch" class="meta-tmdb-fetch-btn">Fetch Tags from TMDB</button>
            </div>
            <div class="meta-tmdb-fetch-help">
              <p class="meta-tiny">Fetches title, genre, and descriptions only. Uses IMDb ID from filename when present.</p>
              <p id="meta-tmdb-tags-picks-heading" class="meta-tiny" hidden>Choose a Match Below</p>
            </div>
            <div id="meta-tmdb-tags-picks" class="meta-tmdb-picks" hidden></div>
          </div>
        </div>
        ${commonTagFieldsHtml("meta-common", {
          defaultOpen: false,
          detailsClass: "meta-optional-tags-details--single-file",
          includeComposerRow: true,
          excludeGenre: true,
        })}
        ${EMBEDDED_ARTWORK_SECTION_HTML}
        <div id="meta-art" class="meta-section">
          <label class="meta-file-label" for="meta-art-file">Artwork (Optional)</label>
          <div class="meta-file-row">
            <input type="file" id="meta-art-file" class="meta-art-file-input" tabindex="-1" accept="image/jpeg,image/png,image/webp" />
            <button type="button" class="secondary meta-art-file-pick" id="meta-art-file-pick" aria-label="Select artwork image">Select…</button>
            <span id="meta-art-filename" class="meta-file-filename" aria-live="polite">No Image Selected</span>
          </div>
          <p id="meta-tmdb-menu-hint" class="meta-tiny meta-tmdb-menu-hint" hidden>
            To use TMDB for posters or tags, add an API key under <strong>Menu → Add TMDB API Key</strong>.
          </p>
          <div id="meta-tmdb-art-block" class="meta-tmdb-fetch-block" hidden>
            <div class="meta-tmdb-row">
              <button type="button" id="meta-tmdb-art-fetch" class="secondary meta-tmdb-fetch-btn">Fetch Poster</button>
            </div>
            <div class="meta-tmdb-fetch-help">
              <p class="meta-tiny">Cover art only. Uses Title and Year (Movies) or Show Name (TV).</p>
              <p id="meta-tmdb-art-picks-heading" class="meta-tiny" hidden>Choose a Poster Below</p>
            </div>
            <div id="meta-tmdb-art-picks" class="meta-tmdb-picks" hidden></div>
          </div>
          <div id="meta-art-preview" class="meta-art-preview" hidden></div>
        </div>
        <div class="meta-actions">
          <button type="button" class="secondary" id="meta-back" hidden>Back</button>
          <div class="meta-actions-filler" aria-hidden="true"></div>
          <button type="button" class="secondary" id="meta-cancel">Cancel</button>
          <button type="button" id="meta-ok">Add to Queue</button>
        </div>
      </div>`;

    modalHost.innerHTML = "";
    modalHost.appendChild(overlay);

    const embeddedArt = initEmbeddedArtworkBlock(overlay, appendLog);
    void embeddedArt.load(file.sourcePath);

    let artworkBase64: string | undefined;

    const mvTitle = overlay.querySelector("#mv-title") as HTMLInputElement;
    const mvYear = overlay.querySelector("#mv-year") as HTMLInputElement;
    const mvGenre = overlay.querySelector("#mv-genre") as HTMLInputElement;
    const tvShow = overlay.querySelector("#tv-show") as HTMLInputElement;
    const tvSeas = overlay.querySelector("#tv-seas") as HTMLInputElement;
    const tvEp = overlay.querySelector("#tv-ep") as HTMLInputElement;
    const tvEtitle = overlay.querySelector("#tv-etitle") as HTMLInputElement;
    const mvvSong = overlay.querySelector("#mvv-song") as HTMLInputElement;
    const mvvArtist = overlay.querySelector("#mvv-artist") as HTMLInputElement;
    const mvvAart = overlay.querySelector("#mvv-aart") as HTMLInputElement;
    const mvvAlbum = overlay.querySelector("#mvv-album") as HTMLInputElement;
    const mvvGenre = overlay.querySelector("#mvv-genre") as HTMLInputElement;
    const mvvCpil = overlay.querySelector("#mvv-cpil") as HTMLInputElement;
    const tvEpid = overlay.querySelector("#tv-epid") as HTMLInputElement;
    const tvNet = overlay.querySelector("#tv-net") as HTMLInputElement;
    const tvSorts = overlay.querySelector("#tv-sorts") as HTMLInputElement;
    const tvGenre = overlay.querySelector("#tv-genre") as HTMLInputElement;
    const artFile = overlay.querySelector("#meta-art-file") as HTMLInputElement;
    const artFilename = overlay.querySelector("#meta-art-filename") as HTMLElement;
    const artPickBtn = overlay.querySelector("#meta-art-file-pick") as HTMLButtonElement;
    artPickBtn.addEventListener("click", () => artFile.click());
    const artPreview = overlay.querySelector("#meta-art-preview") as HTMLDivElement;
    const tmdbMenuHint = overlay.querySelector("#meta-tmdb-menu-hint") as HTMLElement;
    const tmdbTagsSection = overlay.querySelector("#meta-tmdb-tags-section") as HTMLElement;
    const tmdbTagsBlock = overlay.querySelector("#meta-tmdb-tags-block") as HTMLElement;
    const tmdbTagsPicks = overlay.querySelector("#meta-tmdb-tags-picks") as HTMLDivElement;
    const tmdbTagsPicksHeading = overlay.querySelector("#meta-tmdb-tags-picks-heading") as HTMLElement;
    const tmdbTagsFetch = overlay.querySelector("#meta-tmdb-tags-fetch") as HTMLButtonElement;
    const tmdbArtBlock = overlay.querySelector("#meta-tmdb-art-block") as HTMLElement;
    const tmdbArtPicks = overlay.querySelector("#meta-tmdb-art-picks") as HTMLDivElement;
    const tmdbArtPicksHeading = overlay.querySelector("#meta-tmdb-art-picks-heading") as HTMLElement;
    const tmdbArtFetch = overlay.querySelector("#meta-tmdb-art-fetch") as HTMLButtonElement;

    const secMovie = overlay.querySelector("#meta-movie") as HTMLDivElement;
    const secTvSingle = overlay.querySelector("#meta-tv-single") as HTMLDivElement;
    const secMv = overlay.querySelector("#meta-mv") as HTMLDivElement;
    const secCommon = overlay.querySelector("#meta-common-wrap") as HTMLElement | null;
    const secArt = overlay.querySelector("#meta-art") as HTMLDivElement | null;
    const multiBanner = overlay.querySelector("#meta-sf-multi") as HTMLElement;
    const metaOkBtn = overlay.querySelector("#meta-ok") as HTMLButtonElement;
    const metaBackBtn = overlay.querySelector("#meta-back") as HTMLButtonElement;
    const allowBack = canGoBack && (!multi || multi.fileIndex > 1);
    metaBackBtn.hidden = !allowBack;
    metaBackBtn.disabled = !allowBack;

    const stemHints = parseFilenameMetadataHints(stem(file.sourcePath));

    if (multi && multi.totalFiles > 1) {
      multiBanner.hidden = false;
      multiBanner.textContent = `File ${multi.fileIndex} of ${multi.totalFiles} — Proceed with Next Until All Titles are Tagged.`;
      metaOkBtn.textContent =
        multi.fileIndex < multi.totalFiles ? "Next File" : "Add to Queue";
    }

    if (prefillItem) {
      kind = applyEnqueueItemToSingleFileForm(overlay, file, prefillItem);
      const tg = prefillItem.tags;
      if (tg.kind !== "skip" && "artworkBase64" in tg && tg.artworkBase64) {
        artworkBase64 = tg.artworkBase64;
      }
    } else {
      const st = stem(file.sourcePath);
      const h = stemHints;
      mvTitle.value = h.displayTitle || st;
      if (h.year != null) mvYear.value = String(h.year);
      if (p.ok) {
        tvShow.value = h.displayTitle || p.inferredShow || st;
        tvSeas.value = String(p.season ?? h.season ?? 1);
        tvEp.value = String(p.episode ?? h.episode ?? 1);
      } else {
        tvShow.value = h.displayTitle || st;
        tvSeas.value = String(h.season ?? 1);
        tvEp.value = String(h.episode ?? 1);
      }
      if (h.episodeTitle) tvEtitle.value = h.episodeTitle;
      mvvSong.value = st;
    }

    function syncTmdbUi() {
      void getStoredTmdbApiKey().then((key) => {
        const has = Boolean(key);
        const mv = kind === "musicVideo";
        const sk = kind === "skip";
        const showTmdb = has && !mv && !sk;
        tmdbMenuHint.hidden = has || mv || sk;
        tmdbTagsSection.hidden = !showTmdb;
        tmdbTagsBlock.hidden = !showTmdb;
        tmdbArtBlock.hidden = !showTmdb;
        if (mv || sk) {
          clearTmdbPosterPicker(tmdbArtPicks, tmdbArtPicksHeading);
          clearTmdbPosterPicker(tmdbTagsPicks, tmdbTagsPicksHeading);
        }
      });
    }
    syncTmdbUi();

    function setActiveTypeButtons() {
      overlay.querySelectorAll(".meta-type-btn").forEach((b) => {
        const el = b as HTMLButtonElement;
        el.classList.toggle("active", el.dataset.kind === kind);
      });
    }

    function refreshSections() {
      secMovie.hidden = kind !== "movie";
      secTvSingle.hidden = kind !== "tv";
      secMv.hidden = kind !== "musicVideo";
      if (secCommon) secCommon.hidden = kind === "skip";
      if (secArt) secArt.hidden = kind === "skip";
      const compRow = overlay.querySelector("#meta-common-composer-row") as HTMLElement | null;
      if (compRow) compRow.hidden = kind !== "musicVideo";
      syncTmdbUi();
      setActiveTypeButtons();
    }

    overlay.querySelectorAll(".meta-type-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const k = (b as HTMLButtonElement).dataset.kind as typeof kind;
        kind = k;
        refreshSections();
      });
    });

    artFile.addEventListener("change", async () => {
      syncMetaArtFilenameDisplay(artFile, artFilename);
      const f = artFile.files?.[0];
      if (!f) return;
      try {
        artworkBase64 = await fileToBase64(f);
        clearTmdbPosterPicker(tmdbArtPicks, tmdbArtPicksHeading);
        clearTmdbPosterPicker(tmdbTagsPicks, tmdbTagsPicksHeading);
        artPreview.hidden = false;
        artPreview.innerHTML = `<img src="data:${f.type};base64,${artworkBase64}" alt="" />`;
      } catch (e) {
        appendLog(String(e));
      }
    });
    syncMetaArtFilenameDisplay(artFile, artFilename);

    tmdbArtFetch.addEventListener("click", async () => {
      const key = await getStoredTmdbApiKey();
      if (!key) {
        appendLog("No TMDB API key configured. Add one from the Menu.");
        return;
      }
      if (kind !== "movie" && kind !== "tv") return;

      let mode: TmdbSearchMode;
      let q: string;
      let explicitYear: string | undefined;
      if (kind === "movie") {
        mode = "movie";
        q = mvTitle.value.trim();
        explicitYear = mvYear.value;
      } else {
        mode = "tv";
        q = tvShow.value.trim();
        explicitYear = undefined;
      }

      if (!q) {
        appendLog("Enter a title or show name first.");
        return;
      }

      clearTmdbPosterPicker(tmdbArtPicks, tmdbArtPicksHeading);
      tmdbArtFetch.disabled = true;
      try {
        if (stemHints.imdbId) {
          const found = await findTmdbIdsByImdbId(key, stemHints.imdbId);
          if (found && found.kind === mode) {
            const detail = await fetchTmdbDetailsById(
              key,
              found.kind === "movie" ? "movie" : "tv",
              found.id
            );
            if (detail?.posterPath) {
              const b64 = await downloadTmdbPosterBase64(detail.posterPath);
              if (b64) {
                clearManualArtFilePick(artFile, artFilename);
                artworkBase64 = b64;
                artPreview.hidden = false;
                artPreview.innerHTML = `<img src="data:image/jpeg;base64,${b64}" alt="" />`;
                appendLog("TMDB: poster applied (IMDb id from filename).");
                return;
              }
            }
          }
        }

        const candidates = await searchTmdbPosterCandidates(key, mode, q, explicitYear);
        if (candidates.length === 0) {
          appendLog("No poster results for that search.");
          return;
        }
        if (candidates.length === 1) {
          const b64 = await downloadTmdbPosterBase64(candidates[0]!.posterPath);
          if (!b64) {
            appendLog("Could not download that poster.");
            return;
          }
          clearManualArtFilePick(artFile, artFilename);
          artworkBase64 = b64;
          artPreview.hidden = false;
          artPreview.innerHTML = `<img src="data:image/jpeg;base64,${b64}" alt="" />`;
          appendLog("TMDB: poster applied.");
          return;
        }

        mountTmdbPosterPicker(
          tmdbArtPicks,
          candidates,
          async (cand) => {
            const b64 = await downloadTmdbPosterBase64(cand.posterPath);
            if (!b64) {
              appendLog("Could not download that poster.");
              return;
            }
            clearManualArtFilePick(artFile, artFilename);
            artworkBase64 = b64;
            artPreview.replaceChildren();
            artPreview.hidden = true;
            appendLog(`TMDB: poster — ${cand.title}.`);
          },
          tmdbArtPicksHeading
        );
        appendLog("TMDB: choose a poster below.");
      } catch (e) {
        appendLog(`TMDB: ${String(e)}`);
      } finally {
        tmdbArtFetch.disabled = false;
      }
    });

    tmdbTagsFetch.addEventListener("click", async () => {
      const key = await getStoredTmdbApiKey();
      if (!key) {
        appendLog("No TMDB API key configured. Add one from the Menu.");
        return;
      }
      if (kind !== "movie" && kind !== "tv") return;

      const mediaKind: "movie" | "tv" = kind;

      let mode: TmdbSearchMode;
      let q: string;
      let explicitYear: string | undefined;
      if (mediaKind === "movie") {
        mode = "movie";
        q = mvTitle.value.trim();
        explicitYear = mvYear.value;
      } else {
        mode = "tv";
        q = tvShow.value.trim();
        explicitYear = undefined;
      }

      if (!q) {
        appendLog("Enter a title or show name first.");
        return;
      }

      clearTmdbPosterPicker(tmdbTagsPicks, tmdbTagsPicksHeading);
      tmdbTagsFetch.disabled = true;
      try {
        const fromImdb = await fetchTmdbMetadataFromImdbId(key, {
          mode,
          imdbId: stemHints.imdbId,
          tvSeason: mediaKind === "tv" ? Number(tvSeas.value) : null,
          tvEpisode: mediaKind === "tv" ? Number(tvEp.value) : null,
        });

        if (fromImdb && fromImdb.kind === mode) {
          applyTmdbTagsToSingleFileForm(overlay, mediaKind, fromImdb);
          appendLog("TMDB: tags applied (IMDb id from filename).");
          return;
        }

        const candidates = await searchTmdbPosterCandidates(key, mode, q, explicitYear);
        if (candidates.length === 0) {
          appendLog("No TMDB results for that search.");
          return;
        }
        if (candidates.length === 1) {
          const c0 = candidates[0]!;
          let detail = await fetchTmdbDetailsById(key, c0.mediaType, c0.tmdbId);
          if (!detail) {
            appendLog("Could not load TMDB details.");
            return;
          }
          if (mediaKind === "tv" && detail.kind === "tv") {
            detail = await enrichWithTvEpisodeTitle(
              key,
              detail,
              Number(tvSeas.value) || 0,
              Number(tvEp.value) || 1
            );
          }
          applyTmdbTagsToSingleFileForm(overlay, mediaKind, detail);
          appendLog("TMDB: tags applied (first search match).");
          return;
        }

        mountTmdbPosterPicker(
          tmdbTagsPicks,
          candidates,
          async (cand) => {
            let detail = await fetchTmdbDetailsById(key, cand.mediaType, cand.tmdbId);
            if (!detail) {
              appendLog("Could not load TMDB details.");
              return;
            }
            if (mediaKind === "tv" && detail.kind === "tv") {
              detail = await enrichWithTvEpisodeTitle(
                key,
                detail,
                Number(tvSeas.value) || 0,
                Number(tvEp.value) || 1
              );
            }
            applyTmdbTagsToSingleFileForm(overlay, mediaKind, detail);
            appendLog(`TMDB: tags — “${cand.title}”.`);
          },
          tmdbTagsPicksHeading
        );
        appendLog("TMDB: choose a match below for tags.");
      } catch (e) {
        appendLog(`TMDB: ${String(e)}`);
      } finally {
        tmdbTagsFetch.disabled = false;
      }
    });

    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as Node;
      if (overlay.contains(t)) return;
      // #region agent log
      dbgSession("H3", "promptSingleFile:focusin", "focus moved outside overlay", {
        tag: (t as HTMLElement).tagName ?? "",
        id: (t as HTMLElement).id ?? "",
      });
      // #endregion
    };
    const onKeyDebug = (e: KeyboardEvent) => {
      if (!overlay.isConnected) return;
      if (e.key !== "Enter") return;
      // #region agent log
      dbgSession("H4", "promptSingleFile:keydown(capture)", "Enter", {
        targetTag: (e.target as HTMLElement | null)?.tagName ?? "",
        activeTag: document.activeElement?.tagName ?? "",
        activeId: (document.activeElement as HTMLElement | null)?.id ?? "",
      });
      // #endregion
    };
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("keydown", onKeyDebug, true);

    function cleanup(v: SingleFileMetadataResult, closedVia?: string) {
      // #region agent log
      dbgSession("H5", "promptSingleFile:cleanup", closedVia ?? "unknown", {
        resultType: v.type,
      });
      // #endregion
      removeAll();
      modalHost.innerHTML = "";
      resolve(v);
    }

    const removeDismissOnly = attachModalDismiss(
      overlay,
      (reason) => cleanup({ type: "cancel" }, `dismiss_${reason}`),
      "singleFile"
    );

    function removeAll() {
      removeDismissOnly();
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("keydown", onKeyDebug, true);
    }

    overlay.querySelector("#meta-cancel")!.addEventListener("click", () => cleanup({ type: "cancel" }, "cancel_btn"));
    metaBackBtn.addEventListener("click", () => {
      if (!allowBack) return;
      cleanup({ type: "back" }, "back_btn");
    });

    overlay.querySelector("#meta-ok")!.addEventListener("click", () => {
      if (kind === "skip") {
        cleanup(
          {
            type: "tagged",
            item: {
              sourcePath: file.sourcePath,
              treeRoot: file.treeRoot,
              tags: { kind: "skip" },
            },
          },
          "ok_skip"
        );
        return;
      }

      const art = artworkBase64;

      const common = readCommonTagFields(overlay, "meta-common", { skipGenre: true });
      const gMain =
        kind === "movie"
          ? mvGenre.value.trim()
          : kind === "tv"
            ? tvGenre.value.trim()
            : kind === "musicVideo"
              ? mvvGenre.value.trim()
              : "";
      if (gMain) common.genre = gMain;
      else delete common.genre;

      if (kind === "movie") {
        cleanup(
          {
            type: "tagged",
            item: {
              sourcePath: file.sourcePath,
              treeRoot: file.treeRoot,
              tags: {
                kind: "movie",
                title: mvTitle.value.trim() || stem(file.sourcePath),
                year: mvYear.value ? Number(mvYear.value) : undefined,
                artworkBase64: art,
                ...common,
              },
            },
          },
          "ok_movie"
        );
        return;
      }

      if (kind === "tv") {
        cleanup(
          {
            type: "tagged",
            item: {
              sourcePath: file.sourcePath,
              treeRoot: file.treeRoot,
              tags: {
                kind: "tv",
                showName: tvShow.value.trim() || stem(file.sourcePath),
                season: Number(tvSeas.value) || 1,
                episode: Number(tvEp.value) || 1,
                episodeTitle: tvEtitle.value.trim() || undefined,
                artworkBase64: art,
                episodeId: tvEpid.value.trim() || undefined,
                tvNetwork: tvNet.value.trim() || undefined,
                sortShow: tvSorts.value.trim() || undefined,
                ...common,
              },
            },
          },
          "ok_tv"
        );
        return;
      }

      cleanup(
        {
          type: "tagged",
          item: {
            sourcePath: file.sourcePath,
            treeRoot: file.treeRoot,
            tags: {
              kind: "musicVideo",
              title: mvvSong.value.trim() || stem(file.sourcePath),
              artist: mvvArtist.value.trim() || "Unknown Artist",
              artworkBase64: art,
              albumArtist: mvvAart.value.trim() || undefined,
              album: mvvAlbum.value.trim() || undefined,
              composer: (overlay.querySelector("#meta-common-composer") as HTMLInputElement | null)?.value.trim() || undefined,
              compilation: mvvCpil.checked ? true : undefined,
              ...common,
            },
          },
        },
        "ok_musicVideo"
      );
    });

    refreshSections();
    setActiveTypeButtons();
  });
}

export type BatchMetadataResult =
  | { type: "cancel" }
  | { type: "back" }
  | { type: "tagged"; items: EnqueueTaggedItemPayload[] };

/** Shared show-level fields to reuse on the next season (or orphan) step without retyping. */
export type TvBatchCarryForward = {
  show: string;
  tvNetwork?: string;
  sortShow?: string;
  common?: CommonTagFields;
  artworkBase64?: string;
};

export type TvSeasonBatchOptions = {
  /** Primary action (default Confirm). */
  confirmButtonLabel?: string;
  /** Values from the previous season step in this wizard. */
  carryForward?: TvBatchCarryForward;
  /** Return to the previous season step (wizard handles state). */
  canGoBack?: boolean;
  /** Restore this season’s rows and tags (same order as `files`). */
  prefillItems?: EnqueueTaggedItemPayload[];
};

/**
 * TV batch for one season: shared show + season + artwork; per-row episode and optional title.
 */
export function promptTvSeasonGroupBatch(
  files: AnalyzedFile[],
  seasonDefault: number,
  appendLog: (s: string) => void,
  stepHint?: string,
  batchOptions?: TvSeasonBatchOptions
): Promise<BatchMetadataResult> {
  return new Promise((resolve) => {
    const hostEl = getModalHost();
    if (!hostEl) {
      resolve({ type: "cancel" });
      return;
    }
    const modalHost = hostEl;

    const overlay = document.createElement("div");
    overlay.className = "meta-overlay";
    const hint = stepHint
      ? `<p class="meta-hint">${stepHint}</p>`
      : `<p class="meta-hint">One season — shared show name and artwork. Episode numbers are per file.</p>`;

    overlay.innerHTML = `
      <div class="meta-panel meta-tv-batch-panel" role="dialog" aria-modal="true" aria-labelledby="meta-tvb-title">
        <h2 id="meta-tvb-title">TV Batch (Season ${seasonDefault})</h2>
        ${hint}
        <div class="meta-row-show-season">
          <label>Show <input type="text" id="tv-batch-show" class="meta-input" /></label>
          <label class="meta-season-label">Season
            <input type="number" id="tv-batch-season" class="meta-input meta-input-season" min="0" value="${seasonDefault}" /></label>
        </div>
        <div class="meta-row2">
          <label>TV Network
            <input type="text" id="tv-batch-net" class="meta-input" placeholder="Optional" /></label>
          <label>Sort Show
            <input type="text" id="tv-batch-sorts" class="meta-input" placeholder="Optional" /></label>
        </div>
        <label>Genre
          <input type="text" id="tv-batch-genre" class="meta-input" placeholder="Optional" /></label>
        <div id="meta-tmdb-tags-section" class="meta-section meta-tmdb-tags-section" hidden>
          <p class="meta-section-label">Tags from TMDB</p>
          <div id="meta-tmdb-tags-block" class="meta-tmdb-fetch-block" hidden>
            <div class="meta-tmdb-row">
              <button type="button" id="meta-tmdb-tags-fetch" class="meta-tmdb-fetch-btn">Fetch Tags from TMDB</button>
            </div>
            <div class="meta-tmdb-fetch-help">
              <p class="meta-tiny">Fetches show name, genre, and descriptions only. Uses IMDb ID from the first filename when present.</p>
              <p id="meta-tmdb-tags-picks-heading" class="meta-tiny" hidden>Choose a Match Below</p>
            </div>
            <div id="meta-tmdb-tags-picks" class="meta-tmdb-picks" hidden></div>
          </div>
        </div>
        ${commonTagFieldsHtml("tv-batch-common", {
          defaultOpen: false,
          detailsClass: "meta-optional-tags-details--tv-dialog",
          excludeGenre: true,
        })}
        ${EMBEDDED_ARTWORK_SECTION_HTML}
        <div class="meta-batch-wrap">
          <table class="meta-batch-table" id="tv-batch-table"><thead><tr>
            <th>File</th><th>Episode</th><th>Title</th>
          </tr></thead><tbody></tbody></table>
        </div>
        <div id="meta-art" class="meta-section">
          <label class="meta-file-label" for="meta-art-file">Artwork (Optional)</label>
          <div class="meta-file-row">
            <input type="file" id="meta-art-file" class="meta-art-file-input" tabindex="-1" accept="image/jpeg,image/png,image/webp" />
            <button type="button" class="secondary meta-art-file-pick" id="meta-art-file-pick" aria-label="Select artwork image">Select…</button>
            <span id="meta-art-filename" class="meta-file-filename" aria-live="polite">No Image Selected</span>
          </div>
          <p id="meta-tmdb-menu-hint" class="meta-tiny meta-tmdb-menu-hint" hidden>
            To use TMDB for posters or tags, add an API key under <strong>Menu → Add TMDB API Key</strong>.
          </p>
          <div id="meta-tmdb-art-block" class="meta-tmdb-fetch-block" hidden>
            <div class="meta-tmdb-row">
              <button type="button" id="meta-tmdb-art-fetch" class="secondary meta-tmdb-fetch-btn">Fetch Poster</button>
            </div>
            <div class="meta-tmdb-fetch-help">
              <p class="meta-tiny">Cover art only. Uses the Show field (and optional year from filename).</p>
              <p id="meta-tmdb-art-picks-heading" class="meta-tiny" hidden>Choose a Poster Below</p>
            </div>
            <div id="meta-tmdb-art-picks" class="meta-tmdb-picks" hidden></div>
          </div>
          <div id="meta-art-preview" class="meta-art-preview" hidden></div>
        </div>
        <div class="meta-actions">
          <button type="button" class="secondary" id="meta-back-tv" hidden>Back</button>
          <div class="meta-actions-filler" aria-hidden="true"></div>
          <button type="button" class="secondary" id="meta-cancel">Cancel</button>
          <button type="button" id="meta-ok">${batchOptions?.confirmButtonLabel ?? "Confirm"}</button>
        </div>
      </div>`;

    modalHost.innerHTML = "";
    modalHost.appendChild(overlay);

    const embeddedArt = initEmbeddedArtworkBlock(overlay, appendLog);
    if (files[0]) {
      void embeddedArt.load(
        files[0].sourcePath,
        `Preview uses the first file only (${basename(files[0].sourcePath)}). Other rows may have different embedded art.`
      );
    }

    let artworkBase64: string | undefined;
    const tvBackBtn = overlay.querySelector("#meta-back-tv") as HTMLButtonElement;
    tvBackBtn.hidden = !(batchOptions?.canGoBack ?? false);

    const tvBatchShow = overlay.querySelector("#tv-batch-show") as HTMLInputElement;
    const tvBatchSeason = overlay.querySelector("#tv-batch-season") as HTMLInputElement;
    const tvBatchNet = overlay.querySelector("#tv-batch-net") as HTMLInputElement;
    const tvBatchSorts = overlay.querySelector("#tv-batch-sorts") as HTMLInputElement;
    const tvBatchGenre = overlay.querySelector("#tv-batch-genre") as HTMLInputElement;
    const tvBatchBody = overlay.querySelector("#tv-batch-table tbody") as HTMLTableSectionElement;
    const artFile = overlay.querySelector("#meta-art-file") as HTMLInputElement;
    const artFilename = overlay.querySelector("#meta-art-filename") as HTMLElement;
    const artPickBtn = overlay.querySelector("#meta-art-file-pick") as HTMLButtonElement;
    artPickBtn.addEventListener("click", () => artFile.click());
    const artPreview = overlay.querySelector("#meta-art-preview") as HTMLDivElement;
    const tmdbMenuHint = overlay.querySelector("#meta-tmdb-menu-hint") as HTMLElement;
    const tmdbTagsSection = overlay.querySelector("#meta-tmdb-tags-section") as HTMLElement;
    const tmdbTagsBlock = overlay.querySelector("#meta-tmdb-tags-block") as HTMLElement;
    const tmdbTagsPicks = overlay.querySelector("#meta-tmdb-tags-picks") as HTMLDivElement;
    const tmdbTagsPicksHeading = overlay.querySelector("#meta-tmdb-tags-picks-heading") as HTMLElement;
    const tmdbTagsFetch = overlay.querySelector("#meta-tmdb-tags-fetch") as HTMLButtonElement;
    const tmdbArtBlock = overlay.querySelector("#meta-tmdb-art-block") as HTMLElement;
    const tmdbArtPicks = overlay.querySelector("#meta-tmdb-art-picks") as HTMLDivElement;
    const tmdbArtPicksHeading = overlay.querySelector("#meta-tmdb-art-picks-heading") as HTMLElement;
    const tmdbArtFetch = overlay.querySelector("#meta-tmdb-art-fetch") as HTMLButtonElement;
    const batchStemHints = files[0]
      ? parseFilenameMetadataHints(stem(files[0].sourcePath))
      : null;

    void getStoredTmdbApiKey().then((key) => {
      const has = Boolean(key);
      tmdbMenuHint.hidden = has;
      tmdbTagsSection.hidden = !has;
      tmdbTagsBlock.hidden = !has;
      tmdbArtBlock.hidden = !has;
    });

    const batchInputs: { episode: HTMLInputElement; title: HTMLInputElement }[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const tr = document.createElement("tr");
      if (!f.parse.ok) tr.classList.add("meta-parse-warn");
      const shortName = basename(f.sourcePath);
      const p = f.parse;
      const epVal = p.ok && p.episode != null ? String(p.episode) : "";
      tr.innerHTML = `<td title="${f.sourcePath.replace(/"/g, "&quot;")}">${shortName}</td>
        <td><input type="number" class="meta-input mini" data-i="${i}" min="1" value="${epVal}" placeholder="Required" /></td>
        <td><input type="text" class="meta-input" data-i="${i}" placeholder="Optional" /></td>`;
      tvBatchBody.appendChild(tr);
      const ins = tr.querySelectorAll("input");
      batchInputs.push({
        episode: ins[0] as HTMLInputElement,
        title: ins[1] as HTMLInputElement,
      });
    }

    const prefItems = batchOptions?.prefillItems;
    const cf = batchOptions?.carryForward;
    if (prefItems && prefItems.length === files.length) {
      let pathsOk = true;
      for (let i = 0; i < files.length; i++) {
        if (prefItems[i]!.sourcePath !== files[i]!.sourcePath) pathsOk = false;
      }
      const t0 = prefItems[0]!.tags;
      if (pathsOk && t0.kind === "tv") {
        tvBatchShow.value = t0.showName;
        tvBatchSeason.value = String(t0.season);
        tvBatchNet.value = t0.tvNetwork ?? "";
        tvBatchSorts.value = t0.sortShow ?? "";
        const common: CommonTagFields = {};
        if (t0.description) common.description = t0.description;
        if (t0.longDescription) common.longDescription = t0.longDescription;
        if (t0.releaseDate) common.releaseDate = t0.releaseDate;
        if (t0.sortTitle) common.sortTitle = t0.sortTitle;
        if (t0.hdVideo) common.hdVideo = t0.hdVideo;
        if (t0.contentRating) common.contentRating = t0.contentRating;
        if (t0.encoder) common.encoder = t0.encoder;
        if (t0.copyright) common.copyright = t0.copyright;
        tvBatchGenre.value = t0.genre ?? "";
        if (Object.keys(common).length > 0) {
          applyCommonTagFields(overlay, "tv-batch-common", common);
          const wrap = overlay.querySelector("#tv-batch-common-wrap") as HTMLDetailsElement | null;
          if (wrap) wrap.open = true;
        }
        if (t0.artworkBase64) {
          artworkBase64 = t0.artworkBase64;
          artPreview.hidden = false;
          artPreview.innerHTML = `<img src="data:image/jpeg;base64,${t0.artworkBase64}" alt="" />`;
        }
        for (let i = 0; i < files.length; i++) {
          const tg = prefItems[i]!.tags;
          if (tg.kind !== "tv") continue;
          batchInputs[i]!.episode.value = String(tg.episode);
          batchInputs[i]!.title.value = tg.episodeTitle ?? "";
        }
      }
    } else if (cf) {
      tvBatchShow.value = cf.show;
      if (cf.tvNetwork !== undefined) tvBatchNet.value = cf.tvNetwork;
      if (cf.sortShow !== undefined) tvBatchSorts.value = cf.sortShow;
      if (cf.common) {
        const { genre: _g, ...rest } = cf.common;
        applyCommonTagFields(overlay, "tv-batch-common", rest);
        if (cf.common.genre !== undefined) tvBatchGenre.value = cf.common.genre;
        const wrap = overlay.querySelector("#tv-batch-common-wrap") as HTMLDetailsElement | null;
        if (wrap && Object.keys(rest).length > 0) wrap.open = true;
      }
      if (cf.artworkBase64) {
        artworkBase64 = cf.artworkBase64;
        artPreview.hidden = false;
        artPreview.innerHTML = `<img src="data:image/jpeg;base64,${cf.artworkBase64}" alt="" />`;
      }
    } else if (files[0]) {
      const h = batchStemHints;
      const st = stem(files[0].sourcePath);
      tvBatchShow.value = h?.displayTitle || files[0].parse.inferredShow || st;
    }

    artFile.addEventListener("change", async () => {
      syncMetaArtFilenameDisplay(artFile, artFilename);
      const f = artFile.files?.[0];
      if (!f) return;
      try {
        artworkBase64 = await fileToBase64(f);
        clearTmdbPosterPicker(tmdbArtPicks, tmdbArtPicksHeading);
        clearTmdbPosterPicker(tmdbTagsPicks, tmdbTagsPicksHeading);
        artPreview.hidden = false;
        artPreview.innerHTML = `<img src="data:${f.type};base64,${artworkBase64}" alt="" />`;
      } catch (e) {
        appendLog(String(e));
      }
    });
    syncMetaArtFilenameDisplay(artFile, artFilename);

    tmdbArtFetch.addEventListener("click", async () => {
      const key = await getStoredTmdbApiKey();
      if (!key) {
        appendLog("No TMDB API key configured. Add one from the Menu.");
        return;
      }
      const q = tvBatchShow.value.trim();
      if (!q) {
        appendLog("Enter a show name first.");
        return;
      }
      clearTmdbPosterPicker(tmdbArtPicks, tmdbArtPicksHeading);
      tmdbArtFetch.disabled = true;
      try {
        if (batchStemHints?.imdbId) {
          const found = await findTmdbIdsByImdbId(key, batchStemHints.imdbId);
          if (found?.kind === "tv") {
            const detail = await fetchTmdbDetailsById(key, "tv", found.id);
            if (detail?.posterPath) {
              const b64 = await downloadTmdbPosterBase64(detail.posterPath);
              if (b64) {
                clearManualArtFilePick(artFile, artFilename);
                artworkBase64 = b64;
                artPreview.hidden = false;
                artPreview.innerHTML = `<img src="data:image/jpeg;base64,${b64}" alt="" />`;
                appendLog("TMDB: poster applied (IMDb id from filename).");
                return;
              }
            }
          }
        }

        const yearHint =
          batchStemHints?.year != null ? String(batchStemHints.year) : undefined;
        const candidates = await searchTmdbPosterCandidates(key, "tv", q, yearHint);
        if (candidates.length === 0) {
          appendLog("No poster results for that search.");
          return;
        }
        if (candidates.length === 1) {
          const b64 = await downloadTmdbPosterBase64(candidates[0]!.posterPath);
          if (!b64) {
            appendLog("Could not download that poster.");
            return;
          }
          clearManualArtFilePick(artFile, artFilename);
          artworkBase64 = b64;
          artPreview.hidden = false;
          artPreview.innerHTML = `<img src="data:image/jpeg;base64,${b64}" alt="" />`;
          appendLog("TMDB: poster applied.");
          return;
        }

        mountTmdbPosterPicker(
          tmdbArtPicks,
          candidates,
          async (cand) => {
            const b64 = await downloadTmdbPosterBase64(cand.posterPath);
            if (!b64) {
              appendLog("Could not download that poster.");
              return;
            }
            clearManualArtFilePick(artFile, artFilename);
            artworkBase64 = b64;
            artPreview.replaceChildren();
            artPreview.hidden = true;
            appendLog(`TMDB: poster — ${cand.title}.`);
          },
          tmdbArtPicksHeading
        );
        appendLog("TMDB: choose a poster below.");
      } catch (e) {
        appendLog(`TMDB: ${String(e)}`);
      } finally {
        tmdbArtFetch.disabled = false;
      }
    });

    tmdbTagsFetch.addEventListener("click", async () => {
      const key = await getStoredTmdbApiKey();
      if (!key) {
        appendLog("No TMDB API key configured. Add one from the Menu.");
        return;
      }
      const q = tvBatchShow.value.trim();
      if (!q) {
        appendLog("Enter a show name first.");
        return;
      }
      clearTmdbPosterPicker(tmdbTagsPicks, tmdbTagsPicksHeading);
      tmdbTagsFetch.disabled = true;
      try {
        const fromImdb = await fetchTmdbMetadataFromImdbId(key, {
          mode: "tv",
          imdbId: batchStemHints?.imdbId ?? null,
          tvSeason: null,
          tvEpisode: null,
        });

        if (fromImdb && fromImdb.kind === "tv") {
          applyTmdbTagsToTvSharedForm(
            overlay,
            "tv-batch-common",
            fromImdb,
            "#tv-batch-show",
            "#tv-batch-genre"
          );
          appendLog("TMDB: tags applied (IMDb id from filename).");
          return;
        }

        const yearHint =
          batchStemHints?.year != null ? String(batchStemHints.year) : undefined;
        const candidates = await searchTmdbPosterCandidates(key, "tv", q, yearHint);
        if (candidates.length === 0) {
          appendLog("No TMDB results for that search.");
          return;
        }
        if (candidates.length === 1) {
          const c0 = candidates[0]!;
          const detail = await fetchTmdbDetailsById(key, c0.mediaType, c0.tmdbId);
          if (!detail) {
            appendLog("Could not load TMDB details.");
            return;
          }
          applyTmdbTagsToTvSharedForm(
            overlay,
            "tv-batch-common",
            detail,
            "#tv-batch-show",
            "#tv-batch-genre"
          );
          appendLog("TMDB: tags applied (first search match).");
          return;
        }

        mountTmdbPosterPicker(
          tmdbTagsPicks,
          candidates,
          async (cand) => {
            const detail = await fetchTmdbDetailsById(key, cand.mediaType, cand.tmdbId);
            if (!detail) {
              appendLog("Could not load TMDB details.");
              return;
            }
            applyTmdbTagsToTvSharedForm(
              overlay,
              "tv-batch-common",
              detail,
              "#tv-batch-show",
              "#tv-batch-genre"
            );
            appendLog(`TMDB: tags — “${cand.title}”.`);
          },
          tmdbTagsPicksHeading
        );
        appendLog("TMDB: choose a match below for tags.");
      } catch (e) {
        appendLog(`TMDB: ${String(e)}`);
      } finally {
        tmdbTagsFetch.disabled = false;
      }
    });

    function cleanup(v: BatchMetadataResult, closedVia?: string) {
      // #region agent log
      dbgSession("H5", "tvBatch:cleanup", closedVia ?? "unknown", { resultType: v.type });
      // #endregion
      removeDismiss();
      modalHost.innerHTML = "";
      resolve(v);
    }

    const removeDismiss = attachModalDismiss(
      overlay,
      (reason) => cleanup({ type: "cancel" }, `dismiss_${reason}`),
      "tvBatch"
    );

    overlay.querySelector("#meta-cancel")!.addEventListener("click", () => cleanup({ type: "cancel" }, "cancel_btn"));
    tvBackBtn.addEventListener("click", () => cleanup({ type: "back" }, "back_btn"));

    overlay.querySelector("#meta-ok")!.addEventListener("click", () => {
      const show = tvBatchShow.value.trim();
      if (!show) {
        appendLog("Enter a show name.");
        return;
      }
      const seasonNum = Number(tvBatchSeason.value);
      if (Number.isNaN(seasonNum) || seasonNum < 0) {
        appendLog("Enter a valid season number.");
        return;
      }
      const art = artworkBase64;
      const common = readCommonTagFields(overlay, "tv-batch-common", { skipGenre: true });
      const gBatch = tvBatchGenre.value.trim();
      if (gBatch) common.genre = gBatch;
      const net = tvBatchNet.value.trim() || undefined;
      const sortShow = tvBatchSorts.value.trim() || undefined;
      const items: EnqueueTaggedItemPayload[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        const epRaw = batchInputs[i]!.episode.value.trim();
        const ep = Number(epRaw);
        if (epRaw === "" || Number.isNaN(ep) || ep < 1) {
          appendLog(`Episode required for ${basename(f.sourcePath)}.`);
          return;
        }
        items.push({
          sourcePath: f.sourcePath,
          treeRoot: f.treeRoot,
          tags: {
            kind: "tv",
            showName: show,
            season: seasonNum,
            episode: ep,
            episodeTitle: batchInputs[i]!.title.value.trim() || undefined,
            artworkBase64: art,
            tvNetwork: net,
            sortShow,
            ...common,
          },
        });
      }
      cleanup({ type: "tagged", items }, "ok_confirm");
    });
  });
}

export type TvUnparsedOrphansOptions = {
  confirmButtonLabel?: string;
  /** Same show/network/tags/artwork as the last season batch when applicable. */
  carryForward?: TvBatchCarryForward;
  /** Return to the last TV season batch step. */
  canGoBack?: boolean;
  /** Restore rows (same order as `files`). */
  prefillItems?: EnqueueTaggedItemPayload[];
};

/**
 * Files that did not parse as episodes: user must enter season and episode per row.
 */
export function promptTvUnparsedOrphans(
  files: AnalyzedFile[],
  appendLog: (s: string) => void,
  orphanOptions?: TvUnparsedOrphansOptions
): Promise<BatchMetadataResult> {
  return new Promise((resolve) => {
    const hostEl = getModalHost();
    if (!hostEl) {
      resolve({ type: "cancel" });
      return;
    }
    const modalHost = hostEl;

    const overlay = document.createElement("div");
    overlay.className = "meta-overlay";

    overlay.innerHTML = `
      <div class="meta-panel meta-tv-batch-panel" role="dialog" aria-modal="true" aria-labelledby="meta-orph-title">
        <h2 id="meta-orph-title">Unparsed Filenames</h2>
        <p class="meta-hint">These files did not match an episode pattern. Enter season and episode for each (required).</p>
        <p class="meta-tiny meta-wizard-final-note">Last tagging step — when you continue, all items from this wizard are added to the queue together.</p>
        <label>Show <input type="text" id="tv-orph-show" class="meta-input" /></label>
        <div class="meta-row2">
          <label>TV Network
            <input type="text" id="tv-orph-net" class="meta-input" placeholder="Optional" /></label>
          <label>Sort Show
            <input type="text" id="tv-orph-sorts" class="meta-input" placeholder="Optional" /></label>
        </div>
        <label>Genre
          <input type="text" id="tv-orph-genre" class="meta-input" placeholder="Optional" /></label>
        <div id="meta-tmdb-tags-section" class="meta-section meta-tmdb-tags-section" hidden>
          <p class="meta-section-label">Tags from TMDB</p>
          <div id="meta-tmdb-tags-block" class="meta-tmdb-fetch-block" hidden>
            <div class="meta-tmdb-row">
              <button type="button" id="meta-tmdb-tags-fetch" class="meta-tmdb-fetch-btn">Fetch Tags from TMDB</button>
            </div>
            <div class="meta-tmdb-fetch-help">
              <p class="meta-tiny">Fetches show name, genre, and descriptions only. Uses IMDb ID from the first filename when present.</p>
              <p id="meta-tmdb-tags-picks-heading" class="meta-tiny" hidden>Choose a Match Below</p>
            </div>
            <div id="meta-tmdb-tags-picks" class="meta-tmdb-picks" hidden></div>
          </div>
        </div>
        ${commonTagFieldsHtml("tv-orph-common", {
          defaultOpen: false,
          detailsClass: "meta-optional-tags-details--tv-dialog",
          excludeGenre: true,
        })}
        ${EMBEDDED_ARTWORK_SECTION_HTML}
        <div class="meta-batch-wrap">
          <table class="meta-batch-table" id="tv-orph-table"><thead><tr>
            <th>File</th><th>Season</th><th>Episode</th><th>Title</th>
          </tr></thead><tbody></tbody></table>
        </div>
        <div id="meta-art" class="meta-section">
          <label class="meta-file-label" for="meta-art-file">Artwork (Optional)</label>
          <div class="meta-file-row">
            <input type="file" id="meta-art-file" class="meta-art-file-input" tabindex="-1" accept="image/jpeg,image/png,image/webp" />
            <button type="button" class="secondary meta-art-file-pick" id="meta-art-file-pick" aria-label="Select artwork image">Select…</button>
            <span id="meta-art-filename" class="meta-file-filename" aria-live="polite">No Image Selected</span>
          </div>
          <p id="meta-tmdb-menu-hint" class="meta-tiny meta-tmdb-menu-hint" hidden>
            To use TMDB for posters or tags, add an API key under <strong>Menu → Add TMDB API Key</strong>.
          </p>
          <div id="meta-tmdb-art-block" class="meta-tmdb-fetch-block" hidden>
            <div class="meta-tmdb-row">
              <button type="button" id="meta-tmdb-art-fetch" class="secondary meta-tmdb-fetch-btn">Fetch Poster</button>
            </div>
            <div class="meta-tmdb-fetch-help">
              <p class="meta-tiny">Cover art only. Uses the Show field (and optional year from filename).</p>
              <p id="meta-tmdb-art-picks-heading" class="meta-tiny" hidden>Choose a Poster Below</p>
            </div>
            <div id="meta-tmdb-art-picks" class="meta-tmdb-picks" hidden></div>
          </div>
          <div id="meta-art-preview" class="meta-art-preview" hidden></div>
        </div>
        <div class="meta-actions">
          <button type="button" class="secondary" id="meta-back-orph" hidden>Back</button>
          <div class="meta-actions-filler" aria-hidden="true"></div>
          <button type="button" class="secondary" id="meta-cancel">Cancel</button>
          <button type="button" id="meta-ok">${orphanOptions?.confirmButtonLabel ?? "Add to Queue"}</button>
        </div>
      </div>`;

    modalHost.innerHTML = "";
    modalHost.appendChild(overlay);

    const embeddedArt = initEmbeddedArtworkBlock(overlay, appendLog);
    if (files[0]) {
      void embeddedArt.load(
        files[0].sourcePath,
        `Preview uses the first file only (${basename(files[0].sourcePath)}). Other rows may have different embedded art.`
      );
    }

    let artworkBase64: string | undefined;
    const orphBackBtn = overlay.querySelector("#meta-back-orph") as HTMLButtonElement;
    orphBackBtn.hidden = !(orphanOptions?.canGoBack ?? false);

    const tvOrphShow = overlay.querySelector("#tv-orph-show") as HTMLInputElement;
    const tvOrphNet = overlay.querySelector("#tv-orph-net") as HTMLInputElement;
    const tvOrphSorts = overlay.querySelector("#tv-orph-sorts") as HTMLInputElement;
    const tvOrphGenre = overlay.querySelector("#tv-orph-genre") as HTMLInputElement;
    const tbody = overlay.querySelector("#tv-orph-table tbody") as HTMLTableSectionElement;
    const artFile = overlay.querySelector("#meta-art-file") as HTMLInputElement;
    const artFilename = overlay.querySelector("#meta-art-filename") as HTMLElement;
    const artPickBtn = overlay.querySelector("#meta-art-file-pick") as HTMLButtonElement;
    artPickBtn.addEventListener("click", () => artFile.click());
    const artPreview = overlay.querySelector("#meta-art-preview") as HTMLDivElement;
    const tmdbMenuHint = overlay.querySelector("#meta-tmdb-menu-hint") as HTMLElement;
    const tmdbTagsSection = overlay.querySelector("#meta-tmdb-tags-section") as HTMLElement;
    const tmdbTagsBlock = overlay.querySelector("#meta-tmdb-tags-block") as HTMLElement;
    const tmdbTagsPicks = overlay.querySelector("#meta-tmdb-tags-picks") as HTMLDivElement;
    const tmdbTagsPicksHeading = overlay.querySelector("#meta-tmdb-tags-picks-heading") as HTMLElement;
    const tmdbTagsFetch = overlay.querySelector("#meta-tmdb-tags-fetch") as HTMLButtonElement;
    const tmdbArtBlock = overlay.querySelector("#meta-tmdb-art-block") as HTMLElement;
    const tmdbArtPicks = overlay.querySelector("#meta-tmdb-art-picks") as HTMLDivElement;
    const tmdbArtPicksHeading = overlay.querySelector("#meta-tmdb-art-picks-heading") as HTMLElement;
    const tmdbArtFetch = overlay.querySelector("#meta-tmdb-art-fetch") as HTMLButtonElement;
    const orphStemHints = files[0]
      ? parseFilenameMetadataHints(stem(files[0].sourcePath))
      : null;

    void getStoredTmdbApiKey().then((key) => {
      const has = Boolean(key);
      tmdbMenuHint.hidden = has;
      tmdbTagsSection.hidden = !has;
      tmdbTagsBlock.hidden = !has;
      tmdbArtBlock.hidden = !has;
    });

    const rowInputs: { season: HTMLInputElement; episode: HTMLInputElement; title: HTMLInputElement }[] = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const tr = document.createElement("tr");
      tr.classList.add("meta-parse-warn");
      const shortName = basename(f.sourcePath);
      tr.innerHTML = `<td title="${f.sourcePath.replace(/"/g, "&quot;")}">${shortName}</td>
        <td><input type="number" class="meta-input mini" min="0" placeholder="" /></td>
        <td><input type="number" class="meta-input mini" min="1" placeholder="" /></td>
        <td><input type="text" class="meta-input" placeholder="Optional" /></td>`;
      tbody.appendChild(tr);
      const ins = tr.querySelectorAll("input");
      rowInputs.push({
        season: ins[0] as HTMLInputElement,
        episode: ins[1] as HTMLInputElement,
        title: ins[2] as HTMLInputElement,
      });
    }

    const prefOr = orphanOptions?.prefillItems;
    const ocf = orphanOptions?.carryForward;
    if (prefOr && prefOr.length === files.length) {
      let pathsOk = true;
      for (let i = 0; i < files.length; i++) {
        if (prefOr[i]!.sourcePath !== files[i]!.sourcePath) pathsOk = false;
      }
      const t0 = prefOr[0]!.tags;
      if (pathsOk && t0.kind === "tv") {
        tvOrphShow.value = t0.showName;
        tvOrphNet.value = t0.tvNetwork ?? "";
        tvOrphSorts.value = t0.sortShow ?? "";
        const common: CommonTagFields = {};
        if (t0.description) common.description = t0.description;
        if (t0.longDescription) common.longDescription = t0.longDescription;
        if (t0.releaseDate) common.releaseDate = t0.releaseDate;
        if (t0.sortTitle) common.sortTitle = t0.sortTitle;
        if (t0.hdVideo) common.hdVideo = t0.hdVideo;
        if (t0.contentRating) common.contentRating = t0.contentRating;
        if (t0.encoder) common.encoder = t0.encoder;
        if (t0.copyright) common.copyright = t0.copyright;
        tvOrphGenre.value = t0.genre ?? "";
        if (Object.keys(common).length > 0) {
          applyCommonTagFields(overlay, "tv-orph-common", common);
          const wrap = overlay.querySelector("#tv-orph-common-wrap") as HTMLDetailsElement | null;
          if (wrap) wrap.open = true;
        }
        if (t0.artworkBase64) {
          artworkBase64 = t0.artworkBase64;
          artPreview.hidden = false;
          artPreview.innerHTML = `<img src="data:image/jpeg;base64,${t0.artworkBase64}" alt="" />`;
        }
        for (let i = 0; i < files.length; i++) {
          const tg = prefOr[i]!.tags;
          if (tg.kind !== "tv") continue;
          rowInputs[i]!.season.value = String(tg.season);
          rowInputs[i]!.episode.value = String(tg.episode);
          rowInputs[i]!.title.value = tg.episodeTitle ?? "";
        }
      }
    } else if (ocf) {
      tvOrphShow.value = ocf.show;
      if (ocf.tvNetwork !== undefined) tvOrphNet.value = ocf.tvNetwork;
      if (ocf.sortShow !== undefined) tvOrphSorts.value = ocf.sortShow;
      if (ocf.common) {
        const { genre: _og, ...orest } = ocf.common;
        applyCommonTagFields(overlay, "tv-orph-common", orest);
        if (ocf.common.genre !== undefined) tvOrphGenre.value = ocf.common.genre;
        const wrap = overlay.querySelector("#tv-orph-common-wrap") as HTMLDetailsElement | null;
        if (wrap && Object.keys(orest).length > 0) wrap.open = true;
      }
      if (ocf.artworkBase64) {
        artworkBase64 = ocf.artworkBase64;
        artPreview.hidden = false;
        artPreview.innerHTML = `<img src="data:image/jpeg;base64,${ocf.artworkBase64}" alt="" />`;
      }
    } else if (files[0]) {
      const h = orphStemHints;
      const st = stem(files[0].sourcePath);
      tvOrphShow.value = h?.displayTitle || files[0].parse.inferredShow || st;
    }

    artFile.addEventListener("change", async () => {
      syncMetaArtFilenameDisplay(artFile, artFilename);
      const f = artFile.files?.[0];
      if (!f) return;
      try {
        artworkBase64 = await fileToBase64(f);
        clearTmdbPosterPicker(tmdbArtPicks, tmdbArtPicksHeading);
        clearTmdbPosterPicker(tmdbTagsPicks, tmdbTagsPicksHeading);
        artPreview.hidden = false;
        artPreview.innerHTML = `<img src="data:${f.type};base64,${artworkBase64}" alt="" />`;
      } catch (e) {
        appendLog(String(e));
      }
    });
    syncMetaArtFilenameDisplay(artFile, artFilename);

    tmdbArtFetch.addEventListener("click", async () => {
      const key = await getStoredTmdbApiKey();
      if (!key) {
        appendLog("No TMDB API key configured. Add one from the Menu.");
        return;
      }
      const q = tvOrphShow.value.trim();
      if (!q) {
        appendLog("Enter a show name first.");
        return;
      }
      clearTmdbPosterPicker(tmdbArtPicks, tmdbArtPicksHeading);
      tmdbArtFetch.disabled = true;
      try {
        if (orphStemHints?.imdbId) {
          const found = await findTmdbIdsByImdbId(key, orphStemHints.imdbId);
          if (found?.kind === "tv") {
            const detail = await fetchTmdbDetailsById(key, "tv", found.id);
            if (detail?.posterPath) {
              const b64 = await downloadTmdbPosterBase64(detail.posterPath);
              if (b64) {
                clearManualArtFilePick(artFile, artFilename);
                artworkBase64 = b64;
                artPreview.hidden = false;
                artPreview.innerHTML = `<img src="data:image/jpeg;base64,${b64}" alt="" />`;
                appendLog("TMDB: poster applied (IMDb id from filename).");
                return;
              }
            }
          }
        }

        const yearHint =
          orphStemHints?.year != null ? String(orphStemHints.year) : undefined;
        const candidates = await searchTmdbPosterCandidates(key, "tv", q, yearHint);
        if (candidates.length === 0) {
          appendLog("No poster results for that search.");
          return;
        }
        if (candidates.length === 1) {
          const b64 = await downloadTmdbPosterBase64(candidates[0]!.posterPath);
          if (!b64) {
            appendLog("Could not download that poster.");
            return;
          }
          clearManualArtFilePick(artFile, artFilename);
          artworkBase64 = b64;
          artPreview.hidden = false;
          artPreview.innerHTML = `<img src="data:image/jpeg;base64,${b64}" alt="" />`;
          appendLog("TMDB: poster applied.");
          return;
        }

        mountTmdbPosterPicker(
          tmdbArtPicks,
          candidates,
          async (cand) => {
            const b64 = await downloadTmdbPosterBase64(cand.posterPath);
            if (!b64) {
              appendLog("Could not download that poster.");
              return;
            }
            clearManualArtFilePick(artFile, artFilename);
            artworkBase64 = b64;
            artPreview.replaceChildren();
            artPreview.hidden = true;
            appendLog(`TMDB: poster — ${cand.title}.`);
          },
          tmdbArtPicksHeading
        );
        appendLog("TMDB: choose a poster below.");
      } catch (e) {
        appendLog(`TMDB: ${String(e)}`);
      } finally {
        tmdbArtFetch.disabled = false;
      }
    });

    tmdbTagsFetch.addEventListener("click", async () => {
      const key = await getStoredTmdbApiKey();
      if (!key) {
        appendLog("No TMDB API key configured. Add one from the Menu.");
        return;
      }
      const q = tvOrphShow.value.trim();
      if (!q) {
        appendLog("Enter a show name first.");
        return;
      }
      clearTmdbPosterPicker(tmdbTagsPicks, tmdbTagsPicksHeading);
      tmdbTagsFetch.disabled = true;
      try {
        const fromImdb = await fetchTmdbMetadataFromImdbId(key, {
          mode: "tv",
          imdbId: orphStemHints?.imdbId ?? null,
          tvSeason: null,
          tvEpisode: null,
        });

        if (fromImdb && fromImdb.kind === "tv") {
          applyTmdbTagsToTvSharedForm(
            overlay,
            "tv-orph-common",
            fromImdb,
            "#tv-orph-show",
            "#tv-orph-genre"
          );
          appendLog("TMDB: tags applied (IMDb id from filename).");
          return;
        }

        const yearHint =
          orphStemHints?.year != null ? String(orphStemHints.year) : undefined;
        const candidates = await searchTmdbPosterCandidates(key, "tv", q, yearHint);
        if (candidates.length === 0) {
          appendLog("No TMDB results for that search.");
          return;
        }
        if (candidates.length === 1) {
          const c0 = candidates[0]!;
          const detail = await fetchTmdbDetailsById(key, c0.mediaType, c0.tmdbId);
          if (!detail) {
            appendLog("Could not load TMDB details.");
            return;
          }
          applyTmdbTagsToTvSharedForm(
            overlay,
            "tv-orph-common",
            detail,
            "#tv-orph-show",
            "#tv-orph-genre"
          );
          appendLog("TMDB: tags applied (first search match).");
          return;
        }

        mountTmdbPosterPicker(
          tmdbTagsPicks,
          candidates,
          async (cand) => {
            const detail = await fetchTmdbDetailsById(key, cand.mediaType, cand.tmdbId);
            if (!detail) {
              appendLog("Could not load TMDB details.");
              return;
            }
            applyTmdbTagsToTvSharedForm(
              overlay,
              "tv-orph-common",
              detail,
              "#tv-orph-show",
              "#tv-orph-genre"
            );
            appendLog(`TMDB: tags — “${cand.title}”.`);
          },
          tmdbTagsPicksHeading
        );
        appendLog("TMDB: choose a match below for tags.");
      } catch (e) {
        appendLog(`TMDB: ${String(e)}`);
      } finally {
        tmdbTagsFetch.disabled = false;
      }
    });

    function cleanup(v: BatchMetadataResult, closedVia?: string) {
      // #region agent log
      dbgSession("H5", "tvOrphan:cleanup", closedVia ?? "unknown", { resultType: v.type });
      // #endregion
      removeDismiss();
      modalHost.innerHTML = "";
      resolve(v);
    }

    const removeDismiss = attachModalDismiss(
      overlay,
      (reason) => cleanup({ type: "cancel" }, `dismiss_${reason}`),
      "tvOrphan"
    );

    overlay.querySelector("#meta-cancel")!.addEventListener("click", () => cleanup({ type: "cancel" }, "cancel_btn"));
    orphBackBtn.addEventListener("click", () => cleanup({ type: "back" }, "back_btn"));

    overlay.querySelector("#meta-ok")!.addEventListener("click", () => {
      const show = tvOrphShow.value.trim();
      if (!show) {
        appendLog("Enter a show name.");
        return;
      }
      const art = artworkBase64;
      const common = readCommonTagFields(overlay, "tv-orph-common", { skipGenre: true });
      const gOrph = tvOrphGenre.value.trim();
      if (gOrph) common.genre = gOrph;
      const net = tvOrphNet.value.trim() || undefined;
      const sortShow = tvOrphSorts.value.trim() || undefined;
      const items: EnqueueTaggedItemPayload[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        const sRaw = rowInputs[i]!.season.value.trim();
        const eRaw = rowInputs[i]!.episode.value.trim();
        const s = Number(sRaw);
        const e = Number(eRaw);
        if (sRaw === "" || Number.isNaN(s) || s < 0) {
          appendLog(`Season required for ${basename(f.sourcePath)}.`);
          return;
        }
        if (eRaw === "" || Number.isNaN(e) || e < 1) {
          appendLog(`Episode required for ${basename(f.sourcePath)}.`);
          return;
        }
        items.push({
          sourcePath: f.sourcePath,
          treeRoot: f.treeRoot,
          tags: {
            kind: "tv",
            showName: show,
            season: s,
            episode: e,
            episodeTitle: rowInputs[i]!.title.value.trim() || undefined,
            artworkBase64: art,
            tvNetwork: net,
            sortShow,
            ...common,
          },
        });
      }
      cleanup({ type: "tagged", items }, "ok_confirm");
    });
  });
}
