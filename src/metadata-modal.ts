/**
 * Pre-queue metadata: iTunes tags for HandBrake output (AtomicParsley).
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  applyCommonTagFields,
  commonTagFieldsHtml,
  readCommonTagFields,
  type CommonTagFields,
} from "./metadata-common";
import { parseFilenameMetadataHints, parseMusicVideoArtistTitle } from "./filename-metadata-hints";
import { formatTvEpisodeSortId } from "./tv-episode-sort-id";
import {
  clearMusicBrainzPicker,
  fetchRecordingTagsAsGenre,
  mountMusicBrainzRecordingPicker,
  searchMusicBrainzRecordings,
  type MbRecordingCandidate,
} from "./musicbrainz-metadata";
import {
  enrichWithTvEpisodeTitle,
  fetchTmdbDetailsById,
  fetchTmdbMetadataFromImdbId,
  fetchTmdbSeasonEpisodeMap,
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
import { wireMusicVideoFramePicker } from "./music-video-frame-ui";

const META_ART_FILENAME_EMPTY = "No Image Selected";

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function probeSidecarSubtitle(sourcePath: string): Promise<string | null> {
  try {
    return await invoke<string | null>("probe_sidecar_subtitle", { sourcePath });
  } catch {
    return null;
  }
}

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
  /** Absolute path to `.srt` for HandBrake burn-in when user opted in (metadata step). */
  subtitleBurnPath?: string;
  /** Strip inherited embedded cover on the encoded file only (never modifies the source). */
  omitEmbeddedCoverOnOutput?: boolean;
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
  const ldes = overlay.querySelector(`#${prefix}-ldes`) as HTMLTextAreaElement | null;
  if (ldes) ldes.value = ov;
  const wrap = overlay.querySelector(`#${prefix}-wrap`) as HTMLDetailsElement | null;
  if (wrap) wrap.open = true;
}

/** Clears shared “Full description” (TV batch uses per-episode text instead of series overview). */
function clearSharedFullDescriptionInOptionalTags(
  overlay: HTMLElement,
  prefix: string
): void {
  const ldes = overlay.querySelector(`#${prefix}-ldes`) as HTMLTextAreaElement | null;
  if (ldes) ldes.value = "";
}

/** TMDB text fields + full description only in optional tags (no artwork). */
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
    if (meta.episodeAirDate) {
      const tvRel = overlay.querySelector("#tv-release") as HTMLInputElement | null;
      if (tvRel) tvRel.value = meta.episodeAirDate;
    }
  }
  applyOverviewToOptionalTags(overlay, "meta-common", meta.overview);
}

function applyTmdbTagsToTvSharedForm(
  overlay: HTMLElement,
  prefix: string,
  meta: TmdbFilledMetadata,
  showInputSelector: string,
  genreInputSelector: string,
  options?: { omitSharedFullDescription?: boolean }
): void {
  if (meta.kind !== "tv") return;
  (overlay.querySelector(showInputSelector) as HTMLInputElement).value = meta.title;
  if (meta.genres) {
    (overlay.querySelector(genreInputSelector) as HTMLInputElement).value = meta.genres;
  }
  if (options?.omitSharedFullDescription) {
    clearSharedFullDescriptionInOptionalTags(overlay, prefix);
  } else {
    applyOverviewToOptionalTags(overlay, prefix, meta.overview);
  }
}

/** After shared TMDB tags: fill each row’s episode title + release date + episode full description (one season API call when possible). */
async function fillTmdbEpisodeTitlesForTvSeasonTable(
  appendLog: (s: string) => void,
  apiKey: string,
  detail: TmdbFilledMetadata,
  rows: {
    episode: HTMLInputElement;
    title: HTMLInputElement;
    releaseDate: HTMLInputElement;
  }[],
  seasonNum: number,
  rowLongDescriptions: string[]
): Promise<void> {
  if (detail.kind !== "tv" || detail.seriesId == null) return;
  if (Number.isNaN(seasonNum) || seasonNum < 0) return;
  const map = await fetchTmdbSeasonEpisodeMap(apiKey, detail.seriesId, seasonNum);
  let nTitle = 0;
  let nAir = 0;
  let nLdes = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const ep = Number(row.episode.value);
    if (Number.isNaN(ep) || ep < 1) continue;
    const fromMap = map.get(ep);
    if (fromMap) {
      if (fromMap.title) {
        row.title.value = fromMap.title;
        nTitle += 1;
      }
      if (fromMap.airDate) {
        row.releaseDate.value = fromMap.airDate;
        nAir += 1;
      }
      if (fromMap.overview) {
        rowLongDescriptions[i] = fromMap.overview;
        nLdes += 1;
      }
    } else {
      const enriched = await enrichWithTvEpisodeTitle(apiKey, { ...detail }, seasonNum, ep);
      if (enriched.episodeTitle) {
        row.title.value = enriched.episodeTitle;
        nTitle += 1;
      }
      if (enriched.episodeAirDate) {
        row.releaseDate.value = enriched.episodeAirDate;
        nAir += 1;
      }
      if (enriched.overview) {
        rowLongDescriptions[i] = enriched.overview;
        nLdes += 1;
      }
    }
  }
  if (nTitle > 0) appendLog(`TMDB: filled episode titles for ${nTitle} row(s).`);
  if (nAir > 0) appendLog(`TMDB: filled per-row release date from air date for ${nAir} row(s).`);
  if (nLdes > 0) appendLog(`TMDB: filled episode full description for ${nLdes} row(s).`);
}

/** Unparsed orphan table: each row has its own season + episode cells. */
async function fillTmdbEpisodeTitlesForTvOrphanTable(
  appendLog: (s: string) => void,
  apiKey: string,
  detail: TmdbFilledMetadata,
  rows: {
    season: HTMLInputElement;
    episode: HTMLInputElement;
    title: HTMLInputElement;
    releaseDate: HTMLInputElement;
  }[],
  rowLongDescriptions: string[]
): Promise<void> {
  if (detail.kind !== "tv" || detail.seriesId == null) return;
  let nTitle = 0;
  let nAir = 0;
  let nLdes = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const season = Number(row.season.value);
    const ep = Number(row.episode.value);
    if (Number.isNaN(season) || season < 0 || Number.isNaN(ep) || ep < 1) continue;
    const enriched = await enrichWithTvEpisodeTitle(apiKey, { ...detail }, season, ep);
    if (enriched.episodeTitle) {
      row.title.value = enriched.episodeTitle;
      nTitle += 1;
    }
    if (enriched.episodeAirDate) {
      row.releaseDate.value = enriched.episodeAirDate;
      nAir += 1;
    }
    if (enriched.overview) {
      rowLongDescriptions[i] = enriched.overview;
      nLdes += 1;
    }
  }
  if (nTitle > 0) appendLog(`TMDB: filled episode titles for ${nTitle} row(s).`);
  if (nAir > 0) appendLog(`TMDB: filled per-row release date from air date for ${nAir} row(s).`);
  if (nLdes > 0) appendLog(`TMDB: filled episode full description for ${nLdes} row(s).`);
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
    (overlay.querySelector("#tv-epid") as HTMLInputElement).value =
      tags.episodeId?.trim() || formatTvEpisodeSortId(tags.season, tags.episode);
    const tvRel = overlay.querySelector("#tv-release") as HTMLInputElement | null;
    if (tvRel && tags.releaseDate) tvRel.value = tags.releaseDate;
    (overlay.querySelector("#meta-common-tv-network") as HTMLInputElement).value =
      tags.tvNetwork ?? "";
    (overlay.querySelector("#meta-common-tv-sort-show") as HTMLInputElement).value =
      tags.sortShow ?? "";
    (overlay.querySelector("#tv-genre") as HTMLInputElement).value = tags.genre ?? "";
    if (tags.tvNetwork || tags.sortShow) {
      const wrap = overlay.querySelector("#meta-common-wrap") as HTMLDetailsElement | null;
      if (wrap) wrap.open = true;
    }
  }
  if (tags.kind === "musicVideo") {
    (overlay.querySelector("#mvv-song") as HTMLInputElement).value = tags.title;
    (overlay.querySelector("#mvv-artist") as HTMLInputElement).value = tags.artist;
    (overlay.querySelector("#meta-common-mv-album-artist") as HTMLInputElement).value =
      tags.albumArtist ?? "";
    (overlay.querySelector("#mvv-album") as HTMLInputElement).value = tags.album ?? "";
    (overlay.querySelector("#mvv-genre") as HTMLInputElement).value = tags.genre ?? "";
    const comp = overlay.querySelector("#meta-common-composer") as HTMLInputElement | null;
    if (comp) comp.value = tags.composer ?? "";
    (overlay.querySelector("#mvv-cpil") as HTMLInputElement).checked = !!tags.compilation;
    if (tags.albumArtist) {
      const wrap = overlay.querySelector("#meta-common-wrap") as HTMLDetailsElement | null;
      if (wrap) wrap.open = true;
    }
  }

  if (tags.kind !== "skip") {
    const t = tags as CommonTagFields & { artworkBase64?: string };
    const common: CommonTagFields = {};
    if (t.description) common.description = t.description;
    if (t.longDescription) common.longDescription = t.longDescription;
    if (t.releaseDate && tags.kind !== "tv") common.releaseDate = t.releaseDate;
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

  const subInc = overlay.querySelector("#meta-sub-include") as HTMLInputElement | null;
  const subLbl = overlay.querySelector("#meta-sub-label") as HTMLElement | null;
  const subHint = overlay.querySelector("#meta-sub-hint") as HTMLElement | null;
  if (subInc && subLbl) {
    const sp = item.subtitleBurnPath;
    if (sp) {
      subInc.checked = true;
      subLbl.textContent = basename(sp);
    } else {
      subInc.checked = false;
      subLbl.textContent = "None";
    }
    if (subHint) subHint.textContent = "";
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
  const mvFrameSection = overlay.querySelector("#meta-mv-frame-section") as HTMLElement | null;
  secMovie.hidden = kind !== "movie";
  secTvSingle.hidden = kind !== "tv";
  secMv.hidden = kind !== "musicVideo";
  if (mvFrameSection) mvFrameSection.hidden = kind !== "musicVideo";
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
            <label>Year <input type="number" id="mv-year" class="meta-input" min="1900" max="2100" /></label>
            <label>Genre
              <input type="text" id="mv-genre" class="meta-input" /></label>
          </div>
        </div>
        <div id="meta-tv-single" class="meta-section" hidden>
          <p class="meta-section-label">TV Show</p>
          <label>Show
            <input type="text" id="tv-show" class="meta-input" /></label>
          <label>Episode Title
            <input type="text" id="tv-etitle" class="meta-input" /></label>
          <div class="meta-row2">
            <label>Season
              <input type="number" id="tv-seas" class="meta-input" min="0" /></label>
            <label>Episode
              <input type="number" id="tv-ep" class="meta-input" min="1" /></label>
          </div>
          <div class="meta-row2">
            <label>Episode ID
              <input type="text" id="tv-epid" class="meta-input" placeholder="Used for iPod Episode Sort Order, Example: S01E01" spellcheck="false" /></label>
            <label>Release Date
              <input type="text" id="tv-release" class="meta-input" placeholder="YYYY-MM-DD" spellcheck="false" /></label>
          </div>
          <label>Genre
            <input type="text" id="tv-genre" class="meta-input" /></label>
        </div>
        <div id="meta-mv" class="meta-section" hidden>
          <p class="meta-section-label">Music Video</p>
          <label>Song
            <input type="text" id="mvv-song" class="meta-input" /></label>
          <label>Artist
            <input type="text" id="mvv-artist" class="meta-input" /></label>
          <label>Album
            <input type="text" id="mvv-album" class="meta-input" /></label>
          <label>Genre
            <input type="text" id="mvv-genre" class="meta-input" /></label>
          <label class="meta-check-label">
            <input type="checkbox" id="mvv-cpil" /> Compilation
          </label>
        </div>
        <div id="meta-musicbrainz-tags-section" class="meta-section meta-musicbrainz-tags-section" hidden>
          <p class="meta-section-label">Tags from MusicBrainz</p>
          <div id="meta-musicbrainz-tags-block" class="meta-tmdb-fetch-block">
            <div class="meta-tmdb-row">
              <button type="button" id="meta-mb-tags-fetch" class="meta-tmdb-fetch-btn">Fetch Tags from MusicBrainz</button>
            </div>
            <div class="meta-tmdb-fetch-help">
              <p class="meta-tiny" id="meta-mb-tags-fetch-desc"></p>
              <p id="meta-mb-tags-picks-heading" class="meta-tiny" hidden>Choose a Match Below</p>
            </div>
            <div id="meta-mb-tags-picks" class="meta-tmdb-picks" hidden></div>
          </div>
        </div>
        <div id="meta-tmdb-tags-section" class="meta-section meta-tmdb-tags-section" hidden>
          <p class="meta-section-label">Tags from TMDB</p>
          <div id="meta-tmdb-tags-block" class="meta-tmdb-fetch-block" hidden>
            <div class="meta-tmdb-row">
              <button type="button" id="meta-tmdb-tags-fetch" class="meta-tmdb-fetch-btn">Fetch Tags from TMDB</button>
            </div>
            <div class="meta-tmdb-fetch-help">
              <p class="meta-tiny" id="meta-tmdb-tags-fetch-desc"></p>
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
          omitReleaseDate: true,
          includeMusicVideoAlbumArtistRow: true,
          includeTvNetworkSortRow: true,
        })}
        <details id="meta-sub-wrap" class="meta-optional-tags-details meta-sub-details--single-file">
          <summary class="meta-optional-tags-summary">
            <span class="meta-optional-tags-title">Subtitles</span>
          </summary>
          <div class="meta-optional-tags-body">
            <div id="meta-sub-burn" class="meta-section meta-sub-burn-section">
              <label class="meta-check-label">
                <input type="checkbox" id="meta-sub-include" />
                Burn in Subtitles
              </label>
              <p id="meta-sub-hint" class="meta-tiny">—</p>
              <div class="meta-file-row">
                <button type="button" class="secondary" id="meta-sub-pick">Choose .srt…</button>
                <span id="meta-sub-label" class="meta-file-filename" aria-live="polite">—</span>
              </div>
            </div>
          </div>
        </details>
        ${EMBEDDED_ARTWORK_SECTION_HTML}
        <div id="meta-art" class="meta-section">
          <label class="meta-file-label" for="meta-art-file">Cover (Optional)</label>
          <div class="meta-file-row">
            <input type="file" id="meta-art-file" class="meta-art-file-input" tabindex="-1" accept="image/jpeg,image/png,image/webp" />
            <button type="button" class="secondary meta-art-file-pick" id="meta-art-file-pick" aria-label="Select cover image">Select…</button>
            <span id="meta-art-filename" class="meta-file-filename" aria-live="polite">No Image Selected</span>
          </div>
          <p id="meta-tmdb-menu-hint" class="meta-tiny meta-tmdb-menu-hint" hidden>
            To use TMDB for posters or tags, add an API key under <strong>Menu → TMDB API</strong>.
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
          <div id="meta-mv-frame-section" class="meta-section meta-mv-frame-section" hidden>
            <p class="meta-section-label">Frame From Video</p>
            <div class="meta-mv-frame-row">
              <canvas id="meta-mv-frame-canvas" class="meta-mv-frame-canvas" width="1" height="1"></canvas>
              <div class="meta-mv-frame-controls">
                <input
                  type="range"
                  id="meta-mv-frame-slider"
                  class="meta-mv-frame-slider"
                  min="0"
                  max="1000"
                  value="0"
                  step="1"
                  disabled
                  aria-label="Scrub video time for cover frame"
                />
                <div class="meta-mv-frame-time meta-tiny">
                  <span id="meta-mv-frame-time">0:00</span> / <span id="meta-mv-frame-duration">0:00</span>
                </div>
                <button type="button" class="secondary" id="meta-mv-frame-use" disabled>Use This Frame</button>
              </div>
            </div>
            <video
              id="meta-mv-frame-video"
              class="meta-mv-frame-video"
              playsinline
              muted
              preload="metadata"
              hidden
            ></video>
            <p class="meta-tiny">Scrub to a frame to use as the Cover</p>
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
    const mvvAart = overlay.querySelector("#meta-common-mv-album-artist") as HTMLInputElement;
    const mvvAlbum = overlay.querySelector("#mvv-album") as HTMLInputElement;
    const mvvGenre = overlay.querySelector("#mvv-genre") as HTMLInputElement;
    const mvvCpil = overlay.querySelector("#mvv-cpil") as HTMLInputElement;
    const tvEpid = overlay.querySelector("#tv-epid") as HTMLInputElement;
    /** Value last set automatically from season/episode; used to avoid overwriting custom Episode ID. */
    let lastAutoEpisodeId = "";

    function syncTvEpisodeIdField() {
      if (kind !== "tv") return;
      const s = Number(tvSeas.value);
      const e = Number(tvEp.value);
      if (Number.isNaN(s) || Number.isNaN(e) || e < 1) return;
      const derived = formatTvEpisodeSortId(s, e);
      const cur = tvEpid.value.trim();
      const isAuto = cur === "" || cur === lastAutoEpisodeId || cur === derived;
      if (isAuto) {
        tvEpid.value = derived;
        lastAutoEpisodeId = derived;
      } else {
        lastAutoEpisodeId = "";
      }
    }

    tvSeas.addEventListener("input", () => syncTvEpisodeIdField());
    tvEp.addEventListener("input", () => syncTvEpisodeIdField());

    const tvNet = overlay.querySelector("#meta-common-tv-network") as HTMLInputElement;
    const tvSorts = overlay.querySelector("#meta-common-tv-sort-show") as HTMLInputElement;
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
    const metaMusicBrainzTagsSection = overlay.querySelector("#meta-musicbrainz-tags-section") as HTMLElement;
    const mbTagsFetch = overlay.querySelector("#meta-mb-tags-fetch") as HTMLButtonElement;
    const mbTagsPicks = overlay.querySelector("#meta-mb-tags-picks") as HTMLDivElement;
    const mbTagsPicksHeading = overlay.querySelector("#meta-mb-tags-picks-heading") as HTMLElement;
    const mvFrameSection = overlay.querySelector("#meta-mv-frame-section") as HTMLElement;
    const mvFrameVideo = overlay.querySelector("#meta-mv-frame-video") as HTMLVideoElement;
    const mvFrameCanvas = overlay.querySelector("#meta-mv-frame-canvas") as HTMLCanvasElement;
    const mvFrameSlider = overlay.querySelector("#meta-mv-frame-slider") as HTMLInputElement;
    const mvFrameTime = overlay.querySelector("#meta-mv-frame-time") as HTMLElement;
    const mvFrameDuration = overlay.querySelector("#meta-mv-frame-duration") as HTMLElement;
    const mvFrameUse = overlay.querySelector("#meta-mv-frame-use") as HTMLButtonElement;

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
      const mvParts = parseMusicVideoArtistTitle(st);
      mvvSong.value = mvParts.title || st;
      mvvArtist.value = mvParts.artist;
    }

    if (kind === "tv") {
      syncTvEpisodeIdField();
    }

    void embeddedArt.load(
      file.sourcePath,
      undefined,
      prefillItem?.omitEmbeddedCoverOnOutput
    );

    let priorKind: typeof kind = kind;

    async function applyMbCandidate(c: MbRecordingCandidate): Promise<void> {
      mvvSong.value = c.title;
      mvvArtist.value = c.artistDisplay;
      mvvAlbum.value = c.albumTitle;
      if (c.year != null) {
        applyCommonTagFields(overlay, "meta-common", { releaseDate: String(c.year) });
      }
      try {
        const genre = await fetchRecordingTagsAsGenre(c.recordingMbid, c.releaseMbid);
        if (genre) mvvGenre.value = genre;
      } catch {
        /* ignore */
      }
    }

    async function runMbSearch(): Promise<MbRecordingCandidate[] | null> {
      const artist = mvvArtist.value.trim();
      const title = mvvSong.value.trim();
      if (!title) {
        appendLog("Enter a song title (and artist if known) first.");
        return null;
      }
      try {
        return await searchMusicBrainzRecordings(artist, title);
      } catch (e) {
        appendLog(`MusicBrainz: ${String(e)}`);
        return null;
      }
    }

    function applyFrameFromVideo(jpegBase64: string): void {
      clearManualArtFilePick(artFile, artFilename);
      clearTmdbPosterPicker(tmdbArtPicks, tmdbArtPicksHeading);
      clearTmdbPosterPicker(tmdbTagsPicks, tmdbTagsPicksHeading);
      clearMusicBrainzPicker(mbTagsPicks, mbTagsPicksHeading);
      artworkBase64 = jpegBase64;
      artPreview.hidden = false;
      artPreview.innerHTML = `<img src="data:image/jpeg;base64,${jpegBase64}" alt="" />`;
      appendLog("Cover: frame from video.");
    }

    const framePicker = wireMusicVideoFramePicker(
      {
        video: mvFrameVideo,
        canvas: mvFrameCanvas,
        slider: mvFrameSlider,
        timeCurrent: mvFrameTime,
        timeDuration: mvFrameDuration,
        useBtn: mvFrameUse,
      },
      applyFrameFromVideo,
      appendLog
    );

    const subInclude = overlay.querySelector("#meta-sub-include") as HTMLInputElement;
    const subLabel = overlay.querySelector("#meta-sub-label") as HTMLElement;
    const subHint = overlay.querySelector("#meta-sub-hint") as HTMLElement;
    const subPick = overlay.querySelector("#meta-sub-pick") as HTMLButtonElement;
    let burnSubPath: string | null = prefillItem?.subtitleBurnPath ?? null;

    subPick.addEventListener("click", async () => {
      const sel = await open({
        filters: [{ name: "Subtitles", extensions: ["srt"] }],
        multiple: false,
      });
      if (typeof sel !== "string" || !sel) return;
      burnSubPath = sel;
      subLabel.textContent = basename(sel);
      subInclude.checked = true;
    });

    if (prefillItem?.subtitleBurnPath) {
      subHint.textContent = "Restored from a previous step.";
    } else {
      subHint.textContent = "Looking for a .srt next to this file…";
      void (async () => {
        const probed = await probeSidecarSubtitle(file.sourcePath);
        burnSubPath = probed;
        if (probed) {
          subInclude.checked = false;
          subLabel.textContent = basename(probed);
          subHint.textContent =
            "A matching .srt was found. Check the box above to burn it in, or use Choose .srt… to pick a different file.";
        } else {
          subInclude.checked = false;
          subLabel.textContent = "None";
          subHint.textContent =
            "No matching .srt found. Use Choose .srt… to add one.";
        }
      })();
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
        metaMusicBrainzTagsSection.hidden = sk || !mv;
        if (mv || sk) {
          clearTmdbPosterPicker(tmdbArtPicks, tmdbArtPicksHeading);
          clearTmdbPosterPicker(tmdbTagsPicks, tmdbTagsPicksHeading);
        }
        if (!mv) {
          clearMusicBrainzPicker(mbTagsPicks, mbTagsPicksHeading);
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

    function optionalTagsHintForKind(k: "movie" | "tv" | "musicVideo"): string {
      if (k === "movie") {
        return "TV-only and music-video–only fields are omitted for this category.";
      }
      if (k === "tv") {
        return "TV Network and Sort Show appear below for this category; music-video–only fields are omitted.";
      }
      return "Composer and Album Artist appear below for music video only.";
    }

    function tmdbTagsFetchHelpForKind(k: "movie" | "tv"): string {
      if (k === "movie") {
        return "Fetches movie title, year, genre, and full description (Optional Tags). Uses IMDb ID from filename when present.";
      }
      return "Fetches show name, episode title, genre, episode air date, and full description (episode overview). Uses IMDb ID from filename when present.";
    }

    function musicBrainzTagsFetchHelp(): string {
      return "Loads song title, artist, album, and genre from the selected MusicBrainz recording (recording and release tags).";
    }

    function refreshSections() {
      secMovie.hidden = kind !== "movie";
      secTvSingle.hidden = kind !== "tv";
      secMv.hidden = kind !== "musicVideo";
      mvFrameSection.hidden = kind !== "musicVideo";
      if (kind === "musicVideo") {
        framePicker.load(file.sourcePath);
      } else {
        framePicker.unload();
      }
      if (secCommon) secCommon.hidden = kind === "skip";
      if (secArt) secArt.hidden = kind === "skip";
      const hintEl = overlay.querySelector("#meta-common-fieldset-hint") as HTMLElement | null;
      if (hintEl && kind !== "skip") {
        hintEl.textContent = optionalTagsHintForKind(kind);
      }
      const tmdbFetchDescEl = overlay.querySelector("#meta-tmdb-tags-fetch-desc") as HTMLElement | null;
      if (tmdbFetchDescEl) {
        if (kind === "movie" || kind === "tv") {
          tmdbFetchDescEl.textContent = tmdbTagsFetchHelpForKind(kind);
        } else {
          tmdbFetchDescEl.textContent = "";
        }
      }
      const mbFetchDescEl = overlay.querySelector("#meta-mb-tags-fetch-desc") as HTMLElement | null;
      if (mbFetchDescEl) {
        mbFetchDescEl.textContent = kind === "musicVideo" ? musicBrainzTagsFetchHelp() : "";
      }
      const mvExtras = overlay.querySelector("#meta-common-optional-mv-extras") as HTMLElement | null;
      if (mvExtras) mvExtras.hidden = kind !== "musicVideo";
      const tvExtras = overlay.querySelector("#meta-common-optional-tv-extras") as HTMLElement | null;
      if (tvExtras) tvExtras.hidden = kind !== "tv";
      const subWrap = overlay.querySelector("#meta-sub-wrap") as HTMLDetailsElement | null;
      if (subWrap) {
        subWrap.hidden = kind === "skip" || kind === "musicVideo";
        if (kind === "tv") {
          subWrap.open = true;
        } else if (kind === "movie" && priorKind === "tv") {
          subWrap.open = false;
        }
      }
      priorKind = kind;
      if (kind === "tv") {
        syncTvEpisodeIdField();
      }
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
        clearMusicBrainzPicker(mbTagsPicks, mbTagsPicksHeading);
        artPreview.hidden = false;
        artPreview.innerHTML = `<img src="data:${f.type};base64,${artworkBase64}" alt="" />`;
      } catch (e) {
        appendLog(String(e));
      }
    });
    syncMetaArtFilenameDisplay(artFile, artFilename);

    mbTagsFetch.addEventListener("click", async () => {
      if (kind !== "musicVideo") return;
      mbTagsFetch.disabled = true;
      clearMusicBrainzPicker(mbTagsPicks, mbTagsPicksHeading);
      try {
        const list = await runMbSearch();
        if (!list || list.length === 0) {
          appendLog("MusicBrainz: no recordings found.");
          return;
        }
        if (list.length === 1) {
          await applyMbCandidate(list[0]!);
          appendLog("MusicBrainz: tags applied.");
          return;
        }
        mountMusicBrainzRecordingPicker(
          mbTagsPicks,
          list,
          async (c) => {
            await applyMbCandidate(c);
            appendLog(`MusicBrainz: tags — ${c.title}.`);
          },
          mbTagsPicksHeading
        );
        appendLog("MusicBrainz: choose a match below.");
      } finally {
        mbTagsFetch.disabled = false;
      }
    });

    tmdbArtFetch.addEventListener("click", async () => {
      const key = await getStoredTmdbApiKey();
      if (!key) {
        appendLog("No TMDB API key configured. Add one under Menu → TMDB API.");
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
        appendLog("No TMDB API key configured. Add one under Menu → TMDB API.");
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

    function cleanup(v: SingleFileMetadataResult) {
      framePicker.unload();
      removeAll();
      modalHost.innerHTML = "";
      resolve(v);
    }

    const removeDismissOnly = attachModalDismiss(
      overlay,
      (_reason) => cleanup({ type: "cancel" }),
      "singleFile"
    );

    function removeAll() {
      removeDismissOnly();
    }

    overlay.querySelector("#meta-cancel")!.addEventListener("click", () => cleanup({ type: "cancel" }));
    metaBackBtn.addEventListener("click", () => {
      if (!allowBack) return;
      cleanup({ type: "back" });
    });

    overlay.querySelector("#meta-ok")!.addEventListener("click", () => {
      if (
        (kind === "movie" || kind === "tv") &&
        subInclude.checked &&
        !burnSubPath
      ) {
        appendLog("Choose a .srt file for burn-in, or turn off burned-in subtitles.");
        return;
      }
      const subBurn =
        kind === "musicVideo"
          ? undefined
          : subInclude.checked && burnSubPath
            ? burnSubPath
            : undefined;

      if (kind === "skip") {
        cleanup({
          type: "tagged",
          item: {
            sourcePath: file.sourcePath,
            treeRoot: file.treeRoot,
            tags: { kind: "skip" },
            ...(subBurn ? { subtitleBurnPath: subBurn } : {}),
          },
        });
        return;
      }

      const omitOut =
        embeddedArt.getOmitEmbeddedCoverOnOutput() ? ({ omitEmbeddedCoverOnOutput: true } as const) : {};

      const art = artworkBase64;

      const common = readCommonTagFields(overlay, "meta-common", { skipGenre: true });
      if (kind === "tv") {
        const rd = (overlay.querySelector("#tv-release") as HTMLInputElement | null)?.value.trim();
        if (rd) common.releaseDate = rd;
        else delete common.releaseDate;
      }
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
        cleanup({
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
            ...(subBurn ? { subtitleBurnPath: subBurn } : {}),
            ...omitOut,
          },
        });
        return;
      }

      if (kind === "tv") {
        cleanup({
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
              episodeId:
                tvEpid.value.trim() ||
                formatTvEpisodeSortId(
                  Number(tvSeas.value) || 0,
                  Math.max(1, Number(tvEp.value) || 1)
                ),
              tvNetwork: tvNet.value.trim() || undefined,
              sortShow: tvSorts.value.trim() || undefined,
              ...common,
            },
            ...(subBurn ? { subtitleBurnPath: subBurn } : {}),
            ...omitOut,
          },
        });
        return;
      }

      cleanup({
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
          ...omitOut,
        },
      });
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
      : `<p class="meta-hint">One season — shared show name and cover. Episode numbers are per file.</p>`;

    overlay.innerHTML = `
      <div class="meta-panel meta-tv-batch-panel" role="dialog" aria-modal="true" aria-labelledby="meta-tvb-title">
        <h2 id="meta-tvb-title">TV Batch (Season ${seasonDefault})</h2>
        ${hint}
        <div class="meta-row-show-season">
          <label>Show <input type="text" id="tv-batch-show" class="meta-input" /></label>
          <label class="meta-season-label">Season
            <input type="number" id="tv-batch-season" class="meta-input meta-input-season" min="0" value="${seasonDefault}" /></label>
        </div>
        <label>Genre
          <input type="text" id="tv-batch-genre" class="meta-input" /></label>
        <div id="meta-tmdb-tags-section" class="meta-section meta-tmdb-tags-section" hidden>
          <p class="meta-section-label">Tags from TMDB</p>
          <div id="meta-tmdb-tags-block" class="meta-tmdb-fetch-block" hidden>
            <div class="meta-tmdb-row">
              <button type="button" id="meta-tmdb-tags-fetch" class="meta-tmdb-fetch-btn">Fetch Tags from TMDB</button>
            </div>
            <div class="meta-tmdb-fetch-help">
              <p class="meta-tiny">Fetches show name and genre; fills each row’s episode title, release date, and full description (episode overview from TMDB — not the series overview). Uses IMDb ID from the first filename when present.</p>
              <p id="meta-tmdb-tags-picks-heading" class="meta-tiny" hidden>Choose a Match Below</p>
            </div>
            <div id="meta-tmdb-tags-picks" class="meta-tmdb-picks" hidden></div>
          </div>
        </div>
        ${commonTagFieldsHtml("tv-batch-common", {
          defaultOpen: false,
          detailsClass: "meta-optional-tags-details--tv-dialog",
          excludeGenre: true,
          includeTvNetworkSortRow: true,
          tvNetworkSortRowAlwaysVisible: true,
          tvBatchLongDescriptionHint: true,
        })}
        ${EMBEDDED_ARTWORK_SECTION_HTML}
        <div class="meta-batch-wrap">
          <table class="meta-batch-table" id="tv-batch-table"><thead><tr>
            <th>File</th><th class="meta-batch-th-narrow" title="Episode">Ep</th><th>Title</th>
            <th class="meta-batch-th-narrow" title="Episode ID (tven)">Ep ID</th>
            <th class="meta-batch-th-narrow" title="Release date">Release</th>
            <th class="meta-batch-th-narrow" title="Subtitle file">Subs</th>
          </tr></thead><tbody></tbody></table>
        </div>
        <div id="tv-batch-ep-desc-panel" class="tv-batch-ep-desc-panel">
          <p class="meta-tiny tv-batch-ep-desc-hint">Click a row in the table to edit full description for that episode. Fetch Tags fills one description per episode from TMDB (episode overview, not the series overview).</p>
          <label class="meta-label-block">Full Description (Episode)
            <span id="tv-batch-ep-desc-context" class="meta-tiny tv-batch-ep-desc-context" aria-live="polite"></span>
            <textarea id="tv-batch-ep-desc" class="meta-input tv-batch-ep-desc-textarea" rows="5" spellcheck="true" placeholder="Select a row in the table…" disabled></textarea>
          </label>
        </div>
        <div id="meta-art" class="meta-section">
          <label class="meta-file-label" for="meta-art-file">Cover (Optional)</label>
          <div class="meta-file-row">
            <input type="file" id="meta-art-file" class="meta-art-file-input" tabindex="-1" accept="image/jpeg,image/png,image/webp" />
            <button type="button" class="secondary meta-art-file-pick" id="meta-art-file-pick" aria-label="Select cover image">Select…</button>
            <span id="meta-art-filename" class="meta-file-filename" aria-live="polite">No Image Selected</span>
          </div>
          <p id="meta-tmdb-menu-hint" class="meta-tiny meta-tmdb-menu-hint" hidden>
            To use TMDB for posters or tags, add an API key under <strong>Menu → TMDB API</strong>.
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

    let artworkBase64: string | undefined;
    const tvBackBtn = overlay.querySelector("#meta-back-tv") as HTMLButtonElement;
    tvBackBtn.hidden = !(batchOptions?.canGoBack ?? false);

    const tvBatchShow = overlay.querySelector("#tv-batch-show") as HTMLInputElement;
    const tvBatchSeason = overlay.querySelector("#tv-batch-season") as HTMLInputElement;
    const tvBatchNet = overlay.querySelector("#tv-batch-common-tv-network") as HTMLInputElement;
    const tvBatchSorts = overlay.querySelector("#tv-batch-common-tv-sort-show") as HTMLInputElement;
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

    const batchInputs: {
      episode: HTMLInputElement;
      title: HTMLInputElement;
      episodeId: HTMLInputElement;
      releaseDate: HTMLInputElement;
    }[] = [];
    const batchSubPaths: (string | null)[] = new Array(files.length).fill(null);
    const batchSubCells: { inc: HTMLInputElement; cap: HTMLElement }[] = [];

    const syncTvBatchRowEpisodeId = (bi: (typeof batchInputs)[number]) => {
      const sn = Number(tvBatchSeason.value);
      const ep = Number(bi.episode.value);
      if (Number.isNaN(sn) || sn < 0 || Number.isNaN(ep) || ep < 1) return;
      bi.episodeId.value = formatTvEpisodeSortId(sn, ep);
    };

    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const tr = document.createElement("tr");
      tr.classList.add("tv-batch-row-selectable");
      tr.dataset.rowIndex = String(i);
      if (!f.parse.ok) tr.classList.add("meta-parse-warn");
      const shortName = basename(f.sourcePath);
      const p = f.parse;
      const epVal = p.ok && p.episode != null ? String(p.episode) : "";
      const sn0 = Number(tvBatchSeason.value);
      const ep0 = epVal ? Number(epVal) : 1;
      const epid0 =
        !Number.isNaN(sn0) && sn0 >= 0 && !Number.isNaN(ep0) && ep0 >= 1
          ? formatTvEpisodeSortId(sn0, ep0)
          : "";
      tr.innerHTML = `<td class="meta-batch-file-cell" title="${escapeAttr(f.sourcePath)}">${escapeHtmlText(shortName)}</td>
        <td><input type="number" class="meta-input mini" data-i="${i}" min="1" value="${epVal}" placeholder="Required" /></td>
        <td><input type="text" class="meta-input" data-i="${i}" placeholder="Optional" /></td>
        <td><input type="text" class="meta-input meta-batch-epid-input" data-i="${i}" value="${escapeAttr(epid0)}" spellcheck="false" /></td>
        <td><input type="text" class="meta-input meta-batch-date-input" data-i="${i}" placeholder="YYYY-MM-DD" spellcheck="false" /></td>
        <td class="meta-batch-sub"><div class="meta-batch-sub-row">
        <label class="meta-check-label meta-batch-sub-check"><input type="checkbox" class="tv-batch-sub-inc" /></label>
        <button type="button" class="secondary tv-batch-sub-pick">SRT…</button></div>
        <span class="tv-batch-sub-cap meta-tiny">…</span></td>`;
      tvBatchBody.appendChild(tr);
      const tds = tr.querySelectorAll("td");
      const bi = {
        episode: tds[1]!.querySelector("input") as HTMLInputElement,
        title: tds[2]!.querySelector("input") as HTMLInputElement,
        episodeId: tds[3]!.querySelector("input") as HTMLInputElement,
        releaseDate: tds[4]!.querySelector("input") as HTMLInputElement,
      };
      batchInputs.push(bi);
      bi.episode.addEventListener("input", () => syncTvBatchRowEpisodeId(bi));
      const subTd = tr.querySelector(".meta-batch-sub") as HTMLElement;
      const subInc = subTd.querySelector(".tv-batch-sub-inc") as HTMLInputElement;
      const subCap = subTd.querySelector(".tv-batch-sub-cap") as HTMLElement;
      const subPick = subTd.querySelector(".tv-batch-sub-pick") as HTMLButtonElement;
      batchSubCells.push({ inc: subInc, cap: subCap });
      const idx = i;
      subPick.addEventListener("click", async () => {
        const sel = await open({
          filters: [{ name: "Subtitles", extensions: ["srt"] }],
          multiple: false,
        });
        if (typeof sel !== "string" || !sel) return;
        batchSubPaths[idx] = sel;
        subInc.checked = true;
        subCap.textContent = basename(sel);
      });
    }

    const batchRowLdes: string[] = files.map(() => "");

    const tvBatchEpDescTa = overlay.querySelector("#tv-batch-ep-desc") as HTMLTextAreaElement;
    const tvBatchEpDescCtx = overlay.querySelector(
      "#tv-batch-ep-desc-context"
    ) as HTMLElement;
    let tvBatchSelectedEpDescRow: number | null = null;

    const syncTvBatchEpDescTextarea = () => {
      if (tvBatchSelectedEpDescRow === null) {
        tvBatchEpDescTa.value = "";
        tvBatchEpDescTa.placeholder = "Select a row in the table…";
        tvBatchEpDescTa.disabled = true;
        tvBatchEpDescCtx.textContent = "";
        return;
      }
      tvBatchEpDescTa.disabled = false;
      tvBatchEpDescTa.placeholder = "";
      tvBatchEpDescTa.value = batchRowLdes[tvBatchSelectedEpDescRow] ?? "";
      tvBatchEpDescCtx.textContent = basename(files[tvBatchSelectedEpDescRow]!.sourcePath);
    };

    tvBatchBody.addEventListener("click", (ev) => {
      const tr = (ev.target as HTMLElement).closest("tr");
      if (!tr?.dataset.rowIndex) return;
      const idx = Number(tr.dataset.rowIndex);
      if (Number.isNaN(idx)) return;
      tvBatchBody
        .querySelectorAll("tr.tv-batch-row-selected")
        .forEach((r) => r.classList.remove("tv-batch-row-selected"));
      tr.classList.add("tv-batch-row-selected");
      tvBatchSelectedEpDescRow = idx;
      syncTvBatchEpDescTextarea();
    });

    tvBatchEpDescTa.addEventListener("input", () => {
      if (tvBatchSelectedEpDescRow === null) return;
      batchRowLdes[tvBatchSelectedEpDescRow] = tvBatchEpDescTa.value;
    });

    tvBatchSeason.addEventListener("input", () => {
      for (const bi of batchInputs) syncTvBatchRowEpisodeId(bi);
    });

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
        if (t0.tvNetwork || t0.sortShow) {
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
          batchInputs[i]!.episodeId.value =
            tg.episodeId?.trim() || formatTvEpisodeSortId(tg.season, tg.episode);
          if (tg.releaseDate) batchInputs[i]!.releaseDate.value = tg.releaseDate;
          if (tg.longDescription) batchRowLdes[i] = tg.longDescription;
        }
      }
    } else if (cf) {
      tvBatchShow.value = cf.show;
      if (cf.tvNetwork !== undefined) tvBatchNet.value = cf.tvNetwork;
      if (cf.sortShow !== undefined) tvBatchSorts.value = cf.sortShow;
      if (cf.common) {
        const { genre: _g, ...rest } = cf.common;
        applyCommonTagFields(overlay, "tv-batch-common", rest);
        clearSharedFullDescriptionInOptionalTags(overlay, "tv-batch-common");
        if (cf.common.genre !== undefined) tvBatchGenre.value = cf.common.genre;
        const wrap = overlay.querySelector("#tv-batch-common-wrap") as HTMLDetailsElement | null;
        if (wrap && Object.keys(rest).length > 0) wrap.open = true;
      }
      if (cf.tvNetwork || cf.sortShow) {
        const wrap = overlay.querySelector("#tv-batch-common-wrap") as HTMLDetailsElement | null;
        if (wrap) wrap.open = true;
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

    if (files[0]) {
      void embeddedArt.load(
        files[0].sourcePath,
        `Preview uses the first file only (${basename(files[0].sourcePath)}). Other rows may have different embedded art.`,
        prefItems?.[0]?.omitEmbeddedCoverOnOutput
      );
    }

    void (async () => {
      const results = await Promise.all(files.map((f) => probeSidecarSubtitle(f.sourcePath)));
      for (let i = 0; i < files.length; i++) {
        const prefSub = prefItems?.[i]?.subtitleBurnPath;
        if (prefSub) {
          batchSubPaths[i] = prefSub;
          batchSubCells[i]!.inc.checked = true;
          batchSubCells[i]!.cap.textContent = basename(prefSub);
          continue;
        }
        const p = results[i] ?? null;
        batchSubPaths[i] = p;
        const c = batchSubCells[i]!;
        if (p) {
          c.inc.checked = false;
          c.cap.textContent = basename(p);
        } else {
          c.inc.checked = false;
          c.cap.textContent = "—";
        }
      }
    })();

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
        appendLog("No TMDB API key configured. Add one under Menu → TMDB API.");
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
        appendLog("No TMDB API key configured. Add one under Menu → TMDB API.");
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
            "#tv-batch-genre",
            { omitSharedFullDescription: true }
          );
          await fillTmdbEpisodeTitlesForTvSeasonTable(
            appendLog,
            key,
            fromImdb,
            batchInputs,
            Number(tvBatchSeason.value) || 0,
            batchRowLdes
          );
          syncTvBatchEpDescTextarea();
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
            "#tv-batch-genre",
            { omitSharedFullDescription: true }
          );
          await fillTmdbEpisodeTitlesForTvSeasonTable(
            appendLog,
            key,
            detail,
            batchInputs,
            Number(tvBatchSeason.value) || 0,
            batchRowLdes
          );
          syncTvBatchEpDescTextarea();
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
              "#tv-batch-genre",
              { omitSharedFullDescription: true }
            );
            await fillTmdbEpisodeTitlesForTvSeasonTable(
              appendLog,
              key,
              detail,
              batchInputs,
              Number(tvBatchSeason.value) || 0,
              batchRowLdes
            );
            syncTvBatchEpDescTextarea();
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

    function cleanup(v: BatchMetadataResult) {
      removeDismiss();
      modalHost.innerHTML = "";
      resolve(v);
    }

    const removeDismiss = attachModalDismiss(
      overlay,
      (_reason) => cleanup({ type: "cancel" }),
      "tvBatch"
    );

    overlay.querySelector("#meta-cancel")!.addEventListener("click", () => cleanup({ type: "cancel" }));
    tvBackBtn.addEventListener("click", () => cleanup({ type: "back" }));

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
      const omitOut =
        embeddedArt.getOmitEmbeddedCoverOnOutput() ? ({ omitEmbeddedCoverOnOutput: true } as const) : {};
      const items: EnqueueTaggedItemPayload[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i]!;
        const epRaw = batchInputs[i]!.episode.value.trim();
        const ep = Number(epRaw);
        if (epRaw === "" || Number.isNaN(ep) || ep < 1) {
          appendLog(`Episode required for ${basename(f.sourcePath)}.`);
          return;
        }
        if (batchSubCells[i]!.inc.checked && !batchSubPaths[i]) {
          appendLog(`Choose a .srt or uncheck subtitles for ${basename(f.sourcePath)}.`);
          return;
        }
        const subBurn =
          batchSubCells[i]!.inc.checked && batchSubPaths[i] ? batchSubPaths[i]! : undefined;
        const tagsCommon = { ...common };
        const rowRel = batchInputs[i]!.releaseDate.value.trim();
        const releaseForRow = rowRel || tagsCommon.releaseDate;
        if (releaseForRow) tagsCommon.releaseDate = releaseForRow;
        else delete tagsCommon.releaseDate;
        const rowLdes = batchRowLdes[i]!.trim();
        const commonLdes = tagsCommon.longDescription?.trim();
        tagsCommon.longDescription =
          rowLdes !== "" ? rowLdes : commonLdes || undefined;
        if (!tagsCommon.longDescription) delete tagsCommon.longDescription;
        items.push({
          sourcePath: f.sourcePath,
          treeRoot: f.treeRoot,
          tags: {
            kind: "tv",
            showName: show,
            season: seasonNum,
            episode: ep,
            episodeId:
              batchInputs[i]!.episodeId.value.trim() ||
              formatTvEpisodeSortId(seasonNum, ep),
            episodeTitle: batchInputs[i]!.title.value.trim() || undefined,
            artworkBase64: art,
            tvNetwork: net,
            sortShow,
            ...tagsCommon,
          },
          ...(subBurn ? { subtitleBurnPath: subBurn } : {}),
          ...omitOut,
        });
      }
      cleanup({ type: "tagged", items });
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
        <label>Genre
          <input type="text" id="tv-orph-genre" class="meta-input" /></label>
        <div id="meta-tmdb-tags-section" class="meta-section meta-tmdb-tags-section" hidden>
          <p class="meta-section-label">Tags from TMDB</p>
          <div id="meta-tmdb-tags-block" class="meta-tmdb-fetch-block" hidden>
            <div class="meta-tmdb-row">
              <button type="button" id="meta-tmdb-tags-fetch" class="meta-tmdb-fetch-btn">Fetch Tags from TMDB</button>
            </div>
            <div class="meta-tmdb-fetch-help">
              <p class="meta-tiny">Fetches show name and genre; fills each row’s episode title, release date, and full description (episode overview from TMDB — not the series overview). Uses IMDb ID from the first filename when present.</p>
              <p id="meta-tmdb-tags-picks-heading" class="meta-tiny" hidden>Choose a Match Below</p>
            </div>
            <div id="meta-tmdb-tags-picks" class="meta-tmdb-picks" hidden></div>
          </div>
        </div>
        ${commonTagFieldsHtml("tv-orph-common", {
          defaultOpen: false,
          detailsClass: "meta-optional-tags-details--tv-dialog",
          excludeGenre: true,
          includeTvNetworkSortRow: true,
          tvNetworkSortRowAlwaysVisible: true,
          tvBatchLongDescriptionHint: true,
        })}
        ${EMBEDDED_ARTWORK_SECTION_HTML}
        <div class="meta-batch-wrap">
          <table class="meta-batch-table" id="tv-orph-table"><thead><tr>
            <th>File</th><th class="meta-batch-th-narrow" title="Season">S</th><th class="meta-batch-th-narrow" title="Episode">Ep</th><th>Title</th>
            <th class="meta-batch-th-narrow" title="Episode ID (tven)">Ep ID</th>
            <th class="meta-batch-th-narrow" title="Release date">Release</th>
            <th class="meta-batch-th-narrow" title="Subtitle file">Subs</th>
          </tr></thead><tbody></tbody></table>
        </div>
        <div id="tv-orph-ep-desc-panel" class="tv-batch-ep-desc-panel">
          <p class="meta-tiny tv-batch-ep-desc-hint">Click a row in the table to edit full description for that episode. Fetch Tags fills one description per episode from TMDB (episode overview, not the series overview).</p>
          <label class="meta-label-block">Full Description (Episode)
            <span id="tv-orph-ep-desc-context" class="meta-tiny tv-batch-ep-desc-context" aria-live="polite"></span>
            <textarea id="tv-orph-ep-desc" class="meta-input tv-batch-ep-desc-textarea" rows="5" spellcheck="true" placeholder="Select a row in the table…" disabled></textarea>
          </label>
        </div>
        <div id="meta-art" class="meta-section">
          <label class="meta-file-label" for="meta-art-file">Cover (Optional)</label>
          <div class="meta-file-row">
            <input type="file" id="meta-art-file" class="meta-art-file-input" tabindex="-1" accept="image/jpeg,image/png,image/webp" />
            <button type="button" class="secondary meta-art-file-pick" id="meta-art-file-pick" aria-label="Select cover image">Select…</button>
            <span id="meta-art-filename" class="meta-file-filename" aria-live="polite">No Image Selected</span>
          </div>
          <p id="meta-tmdb-menu-hint" class="meta-tiny meta-tmdb-menu-hint" hidden>
            To use TMDB for posters or tags, add an API key under <strong>Menu → TMDB API</strong>.
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

    let artworkBase64: string | undefined;
    const orphBackBtn = overlay.querySelector("#meta-back-orph") as HTMLButtonElement;
    orphBackBtn.hidden = !(orphanOptions?.canGoBack ?? false);

    const tvOrphShow = overlay.querySelector("#tv-orph-show") as HTMLInputElement;
    const tvOrphNet = overlay.querySelector("#tv-orph-common-tv-network") as HTMLInputElement;
    const tvOrphSorts = overlay.querySelector("#tv-orph-common-tv-sort-show") as HTMLInputElement;
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

    const rowInputs: {
      season: HTMLInputElement;
      episode: HTMLInputElement;
      title: HTMLInputElement;
      episodeId: HTMLInputElement;
      releaseDate: HTMLInputElement;
    }[] = [];
    const orphSubPaths: (string | null)[] = new Array(files.length).fill(null);
    const orphSubCells: { inc: HTMLInputElement; cap: HTMLElement }[] = [];

    const syncOrphanRowEpisodeId = (ri: (typeof rowInputs)[number]) => {
      const s = Number(ri.season.value);
      const ep = Number(ri.episode.value);
      if (Number.isNaN(s) || s < 0 || Number.isNaN(ep) || ep < 1) return;
      ri.episodeId.value = formatTvEpisodeSortId(s, ep);
    };

    for (let i = 0; i < files.length; i++) {
      const f = files[i]!;
      const tr = document.createElement("tr");
      tr.classList.add("meta-parse-warn", "tv-batch-row-selectable");
      tr.dataset.rowIndex = String(i);
      const shortName = basename(f.sourcePath);
      tr.innerHTML = `<td class="meta-batch-file-cell" title="${escapeAttr(f.sourcePath)}">${escapeHtmlText(shortName)}</td>
        <td><input type="number" class="meta-input mini" min="0" placeholder="" /></td>
        <td><input type="number" class="meta-input mini" min="1" placeholder="" /></td>
        <td><input type="text" class="meta-input" placeholder="Optional" /></td>
        <td><input type="text" class="meta-input meta-batch-epid-input" spellcheck="false" /></td>
        <td><input type="text" class="meta-input meta-batch-date-input" placeholder="YYYY-MM-DD" spellcheck="false" /></td>
        <td class="meta-batch-sub"><div class="meta-batch-sub-row">
        <label class="meta-check-label meta-batch-sub-check"><input type="checkbox" class="tv-orph-sub-inc" /></label>
        <button type="button" class="secondary tv-orph-sub-pick">SRT…</button></div>
        <span class="tv-orph-sub-cap meta-tiny">…</span></td>`;
      tbody.appendChild(tr);
      const tds = tr.querySelectorAll("td");
      const ri = {
        season: tds[1]!.querySelector("input") as HTMLInputElement,
        episode: tds[2]!.querySelector("input") as HTMLInputElement,
        title: tds[3]!.querySelector("input") as HTMLInputElement,
        episodeId: tds[4]!.querySelector("input") as HTMLInputElement,
        releaseDate: tds[5]!.querySelector("input") as HTMLInputElement,
      };
      rowInputs.push(ri);
      ri.season.addEventListener("input", () => syncOrphanRowEpisodeId(ri));
      ri.episode.addEventListener("input", () => syncOrphanRowEpisodeId(ri));
      const subTd = tr.querySelector(".meta-batch-sub") as HTMLElement;
      const subInc = subTd.querySelector(".tv-orph-sub-inc") as HTMLInputElement;
      const subCap = subTd.querySelector(".tv-orph-sub-cap") as HTMLElement;
      const subPick = subTd.querySelector(".tv-orph-sub-pick") as HTMLButtonElement;
      orphSubCells.push({ inc: subInc, cap: subCap });
      const idx = i;
      subPick.addEventListener("click", async () => {
        const sel = await open({
          filters: [{ name: "Subtitles", extensions: ["srt"] }],
          multiple: false,
        });
        if (typeof sel !== "string" || !sel) return;
        orphSubPaths[idx] = sel;
        subInc.checked = true;
        subCap.textContent = basename(sel);
      });
    }

    const orphRowLdes: string[] = files.map(() => "");

    const tvOrphEpDescTa = overlay.querySelector("#tv-orph-ep-desc") as HTMLTextAreaElement;
    const tvOrphEpDescCtx = overlay.querySelector(
      "#tv-orph-ep-desc-context"
    ) as HTMLElement;
    let tvOrphSelectedEpDescRow: number | null = null;

    const syncTvOrphEpDescTextarea = () => {
      if (tvOrphSelectedEpDescRow === null) {
        tvOrphEpDescTa.value = "";
        tvOrphEpDescTa.placeholder = "Select a row in the table…";
        tvOrphEpDescTa.disabled = true;
        tvOrphEpDescCtx.textContent = "";
        return;
      }
      tvOrphEpDescTa.disabled = false;
      tvOrphEpDescTa.placeholder = "";
      tvOrphEpDescTa.value = orphRowLdes[tvOrphSelectedEpDescRow] ?? "";
      tvOrphEpDescCtx.textContent = basename(files[tvOrphSelectedEpDescRow]!.sourcePath);
    };

    tbody.addEventListener("click", (ev) => {
      const tr = (ev.target as HTMLElement).closest("tr");
      if (!tr?.dataset.rowIndex) return;
      const idx = Number(tr.dataset.rowIndex);
      if (Number.isNaN(idx)) return;
      tbody
        .querySelectorAll("tr.tv-batch-row-selected")
        .forEach((r) => r.classList.remove("tv-batch-row-selected"));
      tr.classList.add("tv-batch-row-selected");
      tvOrphSelectedEpDescRow = idx;
      syncTvOrphEpDescTextarea();
    });

    tvOrphEpDescTa.addEventListener("input", () => {
      if (tvOrphSelectedEpDescRow === null) return;
      orphRowLdes[tvOrphSelectedEpDescRow] = tvOrphEpDescTa.value;
    });

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
        if (t0.tvNetwork || t0.sortShow) {
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
          rowInputs[i]!.episodeId.value =
            tg.episodeId?.trim() || formatTvEpisodeSortId(tg.season, tg.episode);
          if (tg.releaseDate) rowInputs[i]!.releaseDate.value = tg.releaseDate;
          if (tg.longDescription) orphRowLdes[i] = tg.longDescription;
        }
      }
    } else if (ocf) {
      tvOrphShow.value = ocf.show;
      if (ocf.tvNetwork !== undefined) tvOrphNet.value = ocf.tvNetwork;
      if (ocf.sortShow !== undefined) tvOrphSorts.value = ocf.sortShow;
      if (ocf.common) {
        const { genre: _og, ...orest } = ocf.common;
        applyCommonTagFields(overlay, "tv-orph-common", orest);
        clearSharedFullDescriptionInOptionalTags(overlay, "tv-orph-common");
        if (ocf.common.genre !== undefined) tvOrphGenre.value = ocf.common.genre;
        const wrap = overlay.querySelector("#tv-orph-common-wrap") as HTMLDetailsElement | null;
        if (wrap && Object.keys(orest).length > 0) wrap.open = true;
      }
      if (ocf.tvNetwork || ocf.sortShow) {
        const wrap = overlay.querySelector("#tv-orph-common-wrap") as HTMLDetailsElement | null;
        if (wrap) wrap.open = true;
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

    if (files[0]) {
      void embeddedArt.load(
        files[0].sourcePath,
        `Preview uses the first file only (${basename(files[0].sourcePath)}). Other rows may have different embedded art.`,
        prefOr?.[0]?.omitEmbeddedCoverOnOutput
      );
    }

    void (async () => {
      const results = await Promise.all(files.map((f) => probeSidecarSubtitle(f.sourcePath)));
      for (let i = 0; i < files.length; i++) {
        const prefSub = prefOr?.[i]?.subtitleBurnPath;
        if (prefSub) {
          orphSubPaths[i] = prefSub;
          orphSubCells[i]!.inc.checked = true;
          orphSubCells[i]!.cap.textContent = basename(prefSub);
          continue;
        }
        const p = results[i] ?? null;
        orphSubPaths[i] = p;
        const c = orphSubCells[i]!;
        if (p) {
          c.inc.checked = false;
          c.cap.textContent = basename(p);
        } else {
          c.inc.checked = false;
          c.cap.textContent = "—";
        }
      }
    })();

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
        appendLog("No TMDB API key configured. Add one under Menu → TMDB API.");
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
        appendLog("No TMDB API key configured. Add one under Menu → TMDB API.");
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
            "#tv-orph-genre",
            { omitSharedFullDescription: true }
          );
          await fillTmdbEpisodeTitlesForTvOrphanTable(
            appendLog,
            key,
            fromImdb,
            rowInputs,
            orphRowLdes
          );
          syncTvOrphEpDescTextarea();
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
            "#tv-orph-genre",
            { omitSharedFullDescription: true }
          );
          await fillTmdbEpisodeTitlesForTvOrphanTable(
            appendLog,
            key,
            detail,
            rowInputs,
            orphRowLdes
          );
          syncTvOrphEpDescTextarea();
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
              "#tv-orph-genre",
              { omitSharedFullDescription: true }
            );
            await fillTmdbEpisodeTitlesForTvOrphanTable(
              appendLog,
              key,
              detail,
              rowInputs,
              orphRowLdes
            );
            syncTvOrphEpDescTextarea();
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

    function cleanup(v: BatchMetadataResult) {
      removeDismiss();
      modalHost.innerHTML = "";
      resolve(v);
    }

    const removeDismiss = attachModalDismiss(
      overlay,
      (_reason) => cleanup({ type: "cancel" }),
      "tvOrphan"
    );

    overlay.querySelector("#meta-cancel")!.addEventListener("click", () => cleanup({ type: "cancel" }));
    orphBackBtn.addEventListener("click", () => cleanup({ type: "back" }));

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
      const omitOut =
        embeddedArt.getOmitEmbeddedCoverOnOutput() ? ({ omitEmbeddedCoverOnOutput: true } as const) : {};
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
        if (orphSubCells[i]!.inc.checked && !orphSubPaths[i]) {
          appendLog(`Choose a .srt or uncheck subtitles for ${basename(f.sourcePath)}.`);
          return;
        }
        const subBurn =
          orphSubCells[i]!.inc.checked && orphSubPaths[i] ? orphSubPaths[i]! : undefined;
        const tagsCommon = { ...common };
        const rowRel = rowInputs[i]!.releaseDate.value.trim();
        const releaseForRow = rowRel || tagsCommon.releaseDate;
        if (releaseForRow) tagsCommon.releaseDate = releaseForRow;
        else delete tagsCommon.releaseDate;
        const rowLdes = orphRowLdes[i]!.trim();
        const commonLdes = tagsCommon.longDescription?.trim();
        tagsCommon.longDescription =
          rowLdes !== "" ? rowLdes : commonLdes || undefined;
        if (!tagsCommon.longDescription) delete tagsCommon.longDescription;
        items.push({
          sourcePath: f.sourcePath,
          treeRoot: f.treeRoot,
          tags: {
            kind: "tv",
            showName: show,
            season: s,
            episode: e,
            episodeId:
              rowInputs[i]!.episodeId.value.trim() || formatTvEpisodeSortId(s, e),
            episodeTitle: rowInputs[i]!.title.value.trim() || undefined,
            artworkBase64: art,
            tvNetwork: net,
            sortShow,
            ...tagsCommon,
          },
          ...(subBurn ? { subtitleBurnPath: subBurn } : {}),
          ...omitOut,
        });
      }
      cleanup({ type: "tagged", items });
    });
  });
}
