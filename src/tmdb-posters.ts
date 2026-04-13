/**
 * TMDB poster search + download for metadata artwork.
 * Uses movie/TV-specific search endpoints (not /search/multi) to avoid grabbing people or wrong types.
 */

const TMDB_API = "https://api.themoviedb.org/3";
export const TMDB_IMG_BASE = "https://image.tmdb.org/t/p";

export type TmdbSearchMode = "movie" | "tv";

export interface TmdbPosterCandidate {
  posterPath: string;
  title: string;
  subtitle: string;
  tmdbId: number;
  mediaType: TmdbSearchMode;
}

/** "Show Name (2000)" → clean title + year for TMDB filters */
export function splitQueryYear(query: string): { text: string; year?: number } {
  const t = query.trim();
  const m = t.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (m) {
    const y = Number(m[2]);
    if (!Number.isNaN(y) && y >= 1800 && y <= 2100) {
      return { text: m[1]!.trim() || t, year: y };
    }
  }
  return { text: t };
}

function yearFromInput(raw: string): number | undefined {
  const n = Number(raw.trim());
  if (Number.isNaN(n) || n < 1800 || n > 2100) return undefined;
  return n;
}

export async function searchTmdbPosterCandidates(
  apiKey: string,
  mode: TmdbSearchMode,
  query: string,
  explicitYear?: string | null
): Promise<TmdbPosterCandidate[]> {
  const { text, year: fromTitle } = splitQueryYear(query);
  const q = text;
  if (!q) return [];

  const yExplicit = explicitYear != null ? yearFromInput(explicitYear) : undefined;
  const year = yExplicit ?? fromTitle;

  const u = new URL(mode === "movie" ? `${TMDB_API}/search/movie` : `${TMDB_API}/search/tv`);
  u.searchParams.set("api_key", apiKey);
  u.searchParams.set("query", q);
  if (mode === "movie" && year != null) {
    u.searchParams.set("primary_release_year", String(year));
  }
  if (mode === "tv" && year != null) {
    u.searchParams.set("first_air_date_year", String(year));
  }

  const r = await fetch(u.toString());
  if (!r.ok) return [];

  if (mode === "movie") {
    const j = (await r.json()) as {
      results?: {
        id?: number;
        poster_path?: string | null;
        title?: string;
        release_date?: string;
      }[];
    };
    const out: TmdbPosterCandidate[] = [];
    for (const row of j.results ?? []) {
      if (!row.poster_path || !row.title || row.id == null) continue;
      const y = row.release_date?.slice(0, 4);
      out.push({
        posterPath: row.poster_path,
        title: row.title,
        subtitle: y ? `${y}` : "Movie",
        tmdbId: row.id,
        mediaType: "movie",
      });
      if (out.length >= 12) break;
    }
    return out;
  }

  const j = (await r.json()) as {
    results?: {
      id?: number;
      poster_path?: string | null;
      name?: string;
      first_air_date?: string;
    }[];
  };
  const out: TmdbPosterCandidate[] = [];
  for (const row of j.results ?? []) {
    if (!row.poster_path || !row.name || row.id == null) continue;
    const y = row.first_air_date?.slice(0, 4);
    out.push({
      posterPath: row.poster_path,
      title: row.name,
      subtitle: y ? `${y}` : "TV",
      tmdbId: row.id,
      mediaType: "tv",
    });
    if (out.length >= 12) break;
  }
  return out;
}

/** Full-size poster for embedding (matches previous w342 behavior). */
export async function downloadTmdbPosterBase64(posterPath: string): Promise<string | null> {
  const imgUrl = `${TMDB_IMG_BASE}/w342${posterPath}`;
  const imgR = await fetch(imgUrl);
  if (!imgR.ok) return null;
  const buf = new Uint8Array(await imgR.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
  return btoa(bin);
}

export function mountTmdbPosterPicker(
  container: HTMLElement,
  candidates: TmdbPosterCandidate[],
  onPick: (candidate: TmdbPosterCandidate) => void | Promise<void>,
  picksHeading?: HTMLElement | null
): void {
  container.hidden = false;
  container.replaceChildren();

  if (candidates.length === 0) {
    if (picksHeading) picksHeading.hidden = true;
    const p = document.createElement("p");
    p.className = "meta-tiny meta-tmdb-picks-empty";
    p.textContent = "No posters returned. Try a shorter or different title.";
    container.appendChild(p);
    return;
  }

  if (picksHeading) picksHeading.hidden = false;

  const row = document.createElement("div");
  row.className = "meta-tmdb-picks-grid";

  for (const c of candidates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "meta-tmdb-pick";
    btn.setAttribute("aria-label", `Use poster: ${c.title}`);

    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = `${TMDB_IMG_BASE}/w154${c.posterPath}`;

    const cap = document.createElement("div");
    cap.className = "meta-tmdb-pick-caption";
    cap.textContent = c.title;

    const sub = document.createElement("div");
    sub.className = "meta-tmdb-pick-sub";
    sub.textContent = c.subtitle;

    btn.append(img, cap, sub);
    btn.addEventListener("click", async () => {
      row.querySelectorAll(".meta-tmdb-pick").forEach((el) => el.classList.remove("meta-tmdb-pick--selected"));
      btn.classList.add("meta-tmdb-pick--selected");
      await onPick(c);
    });
    row.appendChild(btn);
  }

  container.appendChild(row);
}

export function clearTmdbPosterPicker(container: HTMLElement, picksHeading?: HTMLElement | null): void {
  container.replaceChildren();
  container.hidden = true;
  if (picksHeading) picksHeading.hidden = true;
}
