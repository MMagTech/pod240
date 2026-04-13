/**
 * TMDB movie/TV details + IMDb external-id lookup for metadata forms.
 */

import type { TmdbSearchMode } from "./tmdb-posters";

const TMDB_API = "https://api.themoviedb.org/3";

export interface TmdbFilledMetadata {
  kind: "movie" | "tv";
  title: string;
  year?: number;
  overview?: string;
  genres?: string;
  posterPath?: string | null;
  episodeTitle?: string;
  /** TMDB id for episode API when kind === "tv" */
  seriesId?: number;
  movieId?: number;
}

function yearFromDate(d: string | undefined | null): number | undefined {
  if (!d || d.length < 4) return undefined;
  const y = Number(d.slice(0, 4));
  if (Number.isNaN(y) || y < 1800 || y > 2100) return undefined;
  return y;
}

function genresToString(
  genres: { name?: string }[] | undefined
): string | undefined {
  if (!genres?.length) return undefined;
  const s = genres.map((g) => g.name).filter(Boolean).join(", ");
  return s || undefined;
}

export async function findTmdbIdsByImdbId(
  apiKey: string,
  imdbRaw: string
): Promise<{ kind: "movie" | "tv"; id: number } | null> {
  const id = imdbRaw.toLowerCase().startsWith("tt")
    ? imdbRaw.toLowerCase()
    : `tt${imdbRaw.replace(/\D/g, "")}`;
  if (!/^tt\d+$/.test(id)) return null;

  const u = new URL(`${TMDB_API}/find/${encodeURIComponent(id)}`);
  u.searchParams.set("api_key", apiKey);
  u.searchParams.set("external_source", "imdb_id");

  const r = await fetch(u.toString());
  if (!r.ok) return null;

  const j = (await r.json()) as {
    movie_results?: { id?: number }[];
    tv_results?: { id?: number }[];
  };
  const m = j.movie_results?.[0];
  const t = j.tv_results?.[0];
  if (m?.id != null) return { kind: "movie", id: m.id };
  if (t?.id != null) return { kind: "tv", id: t.id };
  return null;
}

async function fetchMovieDetails(
  apiKey: string,
  movieId: number
): Promise<TmdbFilledMetadata | null> {
  const u = new URL(`${TMDB_API}/movie/${movieId}`);
  u.searchParams.set("api_key", apiKey);

  const r = await fetch(u.toString());
  if (!r.ok) return null;

  const j = (await r.json()) as {
    title?: string;
    release_date?: string;
    overview?: string;
    genres?: { name?: string }[];
    poster_path?: string | null;
  };

  return {
    kind: "movie",
    title: j.title ?? "",
    year: yearFromDate(j.release_date),
    overview: j.overview?.trim() || undefined,
    genres: genresToString(j.genres),
    posterPath: j.poster_path ?? null,
    movieId,
  };
}

async function fetchTvDetails(
  apiKey: string,
  tvId: number
): Promise<TmdbFilledMetadata | null> {
  const u = new URL(`${TMDB_API}/tv/${tvId}`);
  u.searchParams.set("api_key", apiKey);

  const r = await fetch(u.toString());
  if (!r.ok) return null;

  const j = (await r.json()) as {
    name?: string;
    first_air_date?: string;
    overview?: string;
    genres?: { name?: string }[];
    poster_path?: string | null;
  };

  return {
    kind: "tv",
    title: j.name ?? "",
    year: yearFromDate(j.first_air_date),
    overview: j.overview?.trim() || undefined,
    genres: genresToString(j.genres),
    posterPath: j.poster_path ?? null,
    seriesId: tvId,
  };
}

async function fetchTvEpisodeTitle(
  apiKey: string,
  tvId: number,
  season: number,
  episode: number
): Promise<string | undefined> {
  const u = new URL(
    `${TMDB_API}/tv/${tvId}/season/${season}/episode/${episode}`
  );
  u.searchParams.set("api_key", apiKey);

  const r = await fetch(u.toString());
  if (!r.ok) return undefined;

  const j = (await r.json()) as { name?: string };
  const n = j.name?.trim();
  return n || undefined;
}

export async function fetchTmdbDetailsById(
  apiKey: string,
  kind: TmdbSearchMode,
  id: number
): Promise<TmdbFilledMetadata | null> {
  if (kind === "movie") return fetchMovieDetails(apiKey, id);
  return fetchTvDetails(apiKey, id);
}

export async function enrichWithTvEpisodeTitle(
  apiKey: string,
  base: TmdbFilledMetadata,
  season: number,
  episode: number
): Promise<TmdbFilledMetadata> {
  if (base.kind !== "tv" || base.seriesId == null) return base;
  if (season < 0 || episode < 1) return base;
  const ep = await fetchTvEpisodeTitle(apiKey, base.seriesId, season, episode);
  if (!ep) return base;
  return { ...base, episodeTitle: ep };
}

/**
 * IMDb id in filename → /find + details + optional episode title (TV).
 * Returns null if no id, wrong media kind vs `mode`, or API failure.
 */
export async function fetchTmdbMetadataFromImdbId(
  apiKey: string,
  opts: {
    mode: TmdbSearchMode;
    imdbId?: string | null;
    tvSeason?: number | null;
    tvEpisode?: number | null;
  }
): Promise<TmdbFilledMetadata | null> {
  const { mode, imdbId, tvSeason, tvEpisode } = opts;
  if (!imdbId?.trim()) return null;

  const found = await findTmdbIdsByImdbId(apiKey, imdbId.trim());
  if (!found || found.kind !== mode) return null;

  const base =
    found.kind === "movie"
      ? await fetchMovieDetails(apiKey, found.id)
      : await fetchTvDetails(apiKey, found.id);
  if (!base) return null;

  if (
    base.kind === "tv" &&
    base.seriesId != null &&
    tvSeason != null &&
    tvEpisode != null &&
    tvSeason >= 0 &&
    tvEpisode >= 1
  ) {
    const epTitle = await fetchTvEpisodeTitle(
      apiKey,
      base.seriesId,
      tvSeason,
      tvEpisode
    );
    if (epTitle) base.episodeTitle = epTitle;
  }

  return base;
}
