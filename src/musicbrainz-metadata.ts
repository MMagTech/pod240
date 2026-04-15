/**
 * MusicBrainz recording search (tags) + Cover Art Archive thumbnails in the tag picker.
 * No API key. Official policy: identify with User-Agent and stay ≤ 1 request/sec.
 * HTTP runs in Rust (MusicBrainz does not send CORS headers for browser fetch).
 */

import { invoke } from "@tauri-apps/api/core";

const MB_API = "https://musicbrainz.org/ws/2";
const CAA_RELEASE = "https://coverartarchive.org/release";

let lastRequestAt = 0;

async function rateLimitOnePerSecond(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < 1000) {
    await new Promise((r) => setTimeout(r, 1000 - elapsed));
  }
  lastRequestAt = Date.now();
}

function escapeLuceneTerm(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function titleCaseTagPhrase(s: string): string {
  const t = s.trim();
  if (!t) return "";
  return t
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ""))
    .join(" ");
}

/** Top MusicBrainz recording tags → comma-separated genre string for iTunes-style tags. */
function tagsToGenreString(tags: Array<{ name?: string; count?: number }> | undefined): string {
  if (!tags?.length) return "";
  const sorted = [...tags].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const names = sorted
    .slice(0, 4)
    .map((t) => t.name?.trim())
    .filter((n): n is string => Boolean(n));
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(titleCaseTagPhrase(n));
  }
  return uniq.join(", ");
}

/** Merge MB `tags` + official `genres` (same `{ name, count }` shape) for `tagsToGenreString`. */
function combinedTagsAndGenres(
  tags?: Array<{ name?: string; count?: number }>,
  genres?: Array<{ name?: string; count?: number }>
): string {
  const merged = [...(tags ?? []), ...(genres ?? [])];
  return tagsToGenreString(merged);
}

/**
 * Release lookup: MB often stores genre on the release **group**, not on the recording.
 */
async function fetchGenreFromReleaseAndGroup(releaseMbid: string): Promise<string> {
  const id = releaseMbid.trim();
  if (!id) return "";
  await rateLimitOnePerSecond();
  const u = `${MB_API}/release/${encodeURIComponent(id)}?inc=tags+genres+release-groups&fmt=json`;
  const text = await invoke<string>("musicbrainz_http_get", { url: u });
  const j = JSON.parse(text) as {
    tags?: Array<{ name?: string; count?: number }>;
    genres?: Array<{ name?: string; count?: number }>;
    "release-group"?: {
      tags?: Array<{ name?: string; count?: number }>;
      genres?: Array<{ name?: string; count?: number }>;
    };
  };
  let s = combinedTagsAndGenres(j.tags, j.genres);
  if (s) return s;
  const rg = j["release-group"];
  if (rg) {
    s = combinedTagsAndGenres(rg.tags, rg.genres);
  }
  return s;
}

/**
 * Community tags + official genres on the recording, then (if still empty) the linked release
 * and its release-group — MB often leaves recordings untagged while the album RG has genres.
 */
export async function fetchRecordingTagsAsGenre(
  recordingMbid: string,
  releaseMbid?: string
): Promise<string> {
  const id = recordingMbid.trim();
  if (!id) return "";
  await rateLimitOnePerSecond();
  const u = `${MB_API}/recording/${encodeURIComponent(id)}?inc=tags+genres&fmt=json`;
  const text = await invoke<string>("musicbrainz_http_get", { url: u });
  const j = JSON.parse(text) as {
    tags?: Array<{ name?: string; count?: number }>;
    genres?: Array<{ name?: string; count?: number }>;
  };
  let s = combinedTagsAndGenres(j.tags, j.genres);
  if (s) return s;
  const rel = releaseMbid?.trim();
  if (rel) {
    return fetchGenreFromReleaseAndGroup(rel);
  }
  return "";
}

export interface MbRecordingCandidate {
  recordingMbid: string;
  title: string;
  artistDisplay: string;
  albumTitle: string;
  year: number | null;
  releaseMbid: string;
  subtitle: string;
}

function joinArtistCredit(
  credits: Array<{ name?: string; artist?: { name?: string } }> | undefined
): string {
  if (!credits?.length) return "";
  return credits
    .map((c) => c.name ?? c.artist?.name ?? "")
    .filter(Boolean)
    .join(", ");
}

/** Release row from recording search JSON (includes release-group when present). */
type MbSearchRelease = {
  id?: string;
  title?: string;
  date?: string;
  status?: string;
  "release-group"?: {
    "primary-type"?: string;
    "secondary-types"?: string[];
  };
};

function releasePrimaryType(r: MbSearchRelease): string {
  return (r["release-group"]?.["primary-type"] ?? "").trim();
}

/** Prefer studio LP over single when dates tie (same calendar year / day). */
function primaryTypeRank(pt: string): number {
  const p = pt.toLowerCase();
  if (p === "album") return 0;
  if (p === "single") return 1;
  return 2;
}

/**
 * Official album or single (retail), not a compilation release group.
 * EPs, live/bootleg RGs, soundtracks, etc. fall through to legacy picking.
 */
function isRetailAlbumOrSingle(r: MbSearchRelease): boolean {
  if (!r.id || !r.title) return false;
  if ((r.status ?? "").toLowerCase() !== "official") return false;
  const pt = releasePrimaryType(r).toLowerCase();
  if (pt !== "album" && pt !== "single") return false;
  const sec = r["release-group"]?.["secondary-types"] ?? [];
  if (sec.some((s) => (s ?? "").toLowerCase() === "compilation")) return false;
  return true;
}

function sortReleasesByDateThenAlbumBeforeSingle(releases: MbSearchRelease[]): MbSearchRelease[] {
  return [...releases].sort((a, b) => {
    const da = (a.date ?? "9999").slice(0, 10);
    const db = (b.date ?? "9999").slice(0, 10);
    const byDate = da.localeCompare(db);
    if (byDate !== 0) return byDate;
    return primaryTypeRank(releasePrimaryType(a)) - primaryTypeRank(releasePrimaryType(b));
  });
}

function pickBestReleaseLegacy(releases: MbSearchRelease[]): MbSearchRelease | null {
  const withId = releases.filter((r) => r.id && r.title);
  if (withId.length === 0) return null;
  const official = withId.filter((r) => (r.status ?? "").toLowerCase() === "official");
  const nonBootleg = withId.filter((r) => (r.status ?? "").toLowerCase() !== "bootleg");
  const pool =
    official.length > 0
      ? official
      : nonBootleg.length > 0
        ? nonBootleg
        : withId;
  if (pool.length === 0) return null;
  return sortReleasesByDateThenAlbumBeforeSingle(pool)[0] ?? null;
}

function pickBestRelease(releases: MbSearchRelease[] | undefined): {
  id: string;
  title: string;
  year: number | null;
} | null {
  if (!releases?.length) return null;
  const withId = releases.filter((r) => r.id && r.title);
  if (withId.length === 0) return null;

  const retail = withId.filter(isRetailAlbumOrSingle);
  const chosen = retail.length > 0 ? sortReleasesByDateThenAlbumBeforeSingle(retail)[0] : pickBestReleaseLegacy(withId);

  if (!chosen?.id || !chosen.title) return null;
  const yRaw = chosen.date?.slice(0, 4);
  const y = yRaw && /^\d{4}$/.test(yRaw) ? Number(yRaw) : null;
  return { id: chosen.id, title: chosen.title, year: y };
}

function recordingToCandidate(rec: {
  id?: string;
  title?: string;
  "artist-credit"?: Array<{ name?: string; artist?: { name?: string } }>;
  releases?: MbSearchRelease[];
}): MbRecordingCandidate | null {
  if (!rec.id || !rec.title) return null;
  const artistDisplay = joinArtistCredit(rec["artist-credit"]);
  const rel = pickBestRelease(rec.releases);
  if (!rel) {
    return {
      recordingMbid: rec.id,
      title: rec.title,
      artistDisplay,
      albumTitle: "",
      year: null,
      releaseMbid: "",
      subtitle: artistDisplay || "Recording",
    };
  }
  return {
    recordingMbid: rec.id,
    title: rec.title,
    artistDisplay,
    albumTitle: rel.title,
    year: rel.year,
    releaseMbid: rel.id,
    subtitle: [rel.title, rel.year != null ? String(rel.year) : ""].filter(Boolean).join(" · "),
  };
}

/**
 * Search recordings by artist + title (from filename or form).
 * Candidates may include a release MBID (used for picker thumbnails on CAA).
 */
export async function searchMusicBrainzRecordings(
  artist: string,
  title: string
): Promise<MbRecordingCandidate[]> {
  const a = artist.trim();
  const t = title.trim();
  if (!t) return [];

  let query: string;
  if (a) {
    query = `artist:"${escapeLuceneTerm(a)}" AND recording:"${escapeLuceneTerm(t)}"`;
  } else {
    query = `recording:"${escapeLuceneTerm(t)}"`;
  }

  const u = new URL(`${MB_API}/recording`);
  u.searchParams.set("query", query);
  u.searchParams.set("fmt", "json");
  u.searchParams.set("limit", "15");

  await rateLimitOnePerSecond();
  const text = await invoke<string>("musicbrainz_http_get", { url: u.toString() });
  const j = JSON.parse(text) as {
    recordings?: Array<{
      id?: string;
      title?: string;
      "artist-credit"?: Array<{ name?: string; artist?: { name?: string } }>;
      releases?: Array<{ id?: string; title?: string; date?: string; status?: string }>;
    }>;
  };

  const out: MbRecordingCandidate[] = [];
  for (const rec of j.recordings ?? []) {
    const c = recordingToCandidate(rec);
    if (c) out.push(c);
  }
  return out;
}

function caaReleaseThumbUrl(releaseMbid: string): string {
  return `${CAA_RELEASE}/${releaseMbid}/front-250`;
}

function mbPickCaption(c: MbRecordingCandidate): string {
  const a = c.albumTitle.trim();
  if (a) return a;
  return c.subtitle.trim() || c.title;
}

function mbPickSub(c: MbRecordingCandidate): string {
  const y = c.year != null ? ` · ${c.year}` : "";
  return `${c.title} — ${c.artistDisplay}${y}`;
}

function makeMbCoverPlaceholder(): HTMLElement {
  const d = document.createElement("div");
  d.className = "meta-mb-pick-placeholder";
  d.setAttribute("aria-hidden", "true");
  return d;
}

/**
 * Same grid + tile pattern as TMDB (`mountTmdbPosterPicker`). Thumbnails load from
 * Cover Art Archive (`/release/{mbid}/front-250`) when we have a release MBID — no
 * extra MusicBrainz fields are required; images load in the webview like normal `<img>`s.
 */
export function mountMusicBrainzRecordingPicker(
  container: HTMLElement,
  candidates: MbRecordingCandidate[],
  onPick: (c: MbRecordingCandidate) => void | Promise<void>,
  heading?: HTMLElement | null
): void {
  container.hidden = false;
  container.replaceChildren();

  if (candidates.length === 0) {
    if (heading) heading.hidden = true;
    const p = document.createElement("p");
    p.className = "meta-tiny meta-tmdb-picks-empty";
    p.textContent = "No recordings found. Adjust artist or song and try again.";
    container.appendChild(p);
    return;
  }

  if (heading) heading.hidden = false;

  const row = document.createElement("div");
  row.className = "meta-tmdb-picks-grid";

  for (const c of candidates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meta-tmdb-pick meta-mb-pick";
    btn.setAttribute(
      "aria-label",
      `Use release: ${mbPickCaption(c)} — ${mbPickSub(c)}`
    );

    if (c.releaseMbid) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = caaReleaseThumbUrl(c.releaseMbid);
      img.addEventListener(
        "error",
        () => {
          img.replaceWith(makeMbCoverPlaceholder());
        },
        { once: true }
      );
      btn.appendChild(img);
    } else {
      btn.appendChild(makeMbCoverPlaceholder());
    }

    const cap = document.createElement("div");
    cap.className = "meta-tmdb-pick-caption";
    cap.textContent = mbPickCaption(c);

    const sub = document.createElement("div");
    sub.className = "meta-tmdb-pick-sub";
    sub.textContent = mbPickSub(c);

    btn.append(cap, sub);
    btn.addEventListener("click", async () => {
      row.querySelectorAll(".meta-tmdb-pick").forEach((el) => el.classList.remove("meta-tmdb-pick--selected"));
      btn.classList.add("meta-tmdb-pick--selected");
      await onPick(c);
    });
    row.appendChild(btn);
  }

  container.appendChild(row);
}

export function clearMusicBrainzPicker(container: HTMLElement, heading?: HTMLElement | null): void {
  container.replaceChildren();
  container.hidden = true;
  if (heading) heading.hidden = true;
}
