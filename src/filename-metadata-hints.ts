/**
 * Heuristic metadata hints from release-style filenames (no network).
 * TMDB remains authoritative when the user fetches from there.
 */

export interface FilenameMetadataHints {
  /** Lowercase `tt` + digits, e.g. tt0163651 */
  imdbId: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  episodeTitle: string | null;
  /** Movie title or TV series name (cleaned) */
  displayTitle: string;
}

/**
 * Parse a file stem (filename without extension).
 */
export function parseFilenameMetadataHints(fileStem: string): FilenameMetadataHints {
  const raw = fileStem.trim();
  if (!raw) {
    return {
      imdbId: null,
      year: null,
      season: null,
      episode: null,
      episodeTitle: null,
      displayTitle: "",
    };
  }

  const imdbMatch = raw.match(/\{imdb-(tt\d+)\}/i);
  const imdbId = imdbMatch ? imdbMatch[1]!.toLowerCase() : null;

  const seMatch = raw.match(/\b[Ss](\d{1,2})[Ee](\d{1,3})\b/);
  const season = seMatch ? Number(seMatch[1]) : null;
  const episode = seMatch ? Number(seMatch[2]) : null;

  let year: number | null = null;
  const yMatch = raw.match(/\((\d{4})\)/);
  if (yMatch) {
    const y = Number(yMatch[1]);
    if (!Number.isNaN(y) && y >= 1900 && y <= 2100) year = y;
  }

  let episodeTitle: string | null = null;
  if (seMatch) {
    const after = raw.slice(seMatch.index! + seMatch[0].length);
    const epTit = after.match(/^\s*-\s*([^[\]\n-]+?)(?=\s*[\[\n-]|$)/);
    if (epTit) {
      const t = epTit[1]!.trim();
      if (t.length > 0) episodeTitle = t;
    }
  }

  let work = raw
    .replace(/\{imdb-tt\d+\}/gi, "")
    .replace(/\{edition-[^}]+\}/gi, "")
    .replace(/\{[^}]+\}/g, "")
    .replace(/\s+/g, " ")
    .trim();

  work = work.replace(/\s*-\s*[^[\]\n]+$/u, "").trim();

  let displayTitle = work;
  if (seMatch) {
    const idx = work.toLowerCase().indexOf(seMatch[0].toLowerCase());
    if (idx > 0) {
      displayTitle = work.slice(0, idx).replace(/\s*-\s*$/u, "").trim();
    }
  }

  displayTitle = displayTitle.replace(/\s*\(\d{4}\)\s*$/u, "").trim();

  while (/\[[^\]]+\]\s*$/u.test(displayTitle)) {
    displayTitle = displayTitle.replace(/\s*\[[^\]]+\]\s*$/u, "").trim();
  }

  displayTitle = displayTitle.replace(/\s+/g, " ").trim();

  if (!displayTitle) displayTitle = raw;

  return {
    imdbId,
    year,
    season: season != null && !Number.isNaN(season) ? season : null,
    episode: episode != null && !Number.isNaN(episode) ? episode : null,
    episodeTitle,
    displayTitle,
  };
}

/**
 * Strip YouTube-style clutter (video id, “(1)” copies), “Official Music Video”, etc.
 * so `Artist - Title` parsing works on ripped downloads without manual editing.
 */
export function sanitizeMusicVideoFileStem(stem: string): string {
  let s = stem.trim().replace(/\s+/g, " ");

  s = s.replace(/\s*\(\s*Official\s+Music\s+Video\s*\)/gi, "");
  s = s.replace(/\s*\(\s*Official\s+Video\s*\)/gi, "");
  s = s.replace(/\s*\(\s*Official\s+Audio\s*\)/gi, "");
  s = s.replace(/\s*\(\s*Lyric\s+Video\s*\)/gi, "");
  s = s.replace(/\s*\(\s*Lyrics\s*\)/gi, "");
  s = s.replace(/\s*\[\s*Official\s+Music\s+Video\s*\]/gi, "");
  s = s.replace(/\s*\[\s*Official\s+Video\s*\]/gi, "");

  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/\s*\[\s*(?:1080|720|480|4K|HD|HQ|60fps)\s*\]\s*$/i, "").trim();
    if (s === before) break;
  }

  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(/\s*\(\d{1,3}\)\s*$/g, "").trim();
    s = s.replace(/-[a-zA-Z0-9_-]{11}\s*$/g, "").trim();
    if (s === before) break;
  }

  return s.replace(/\s+/g, " ").trim();
}

/**
 * Split `Artist - Title` style stems for music-video defaults (first ` - ` wins).
 */
export function parseMusicVideoArtistTitle(stem: string): { artist: string; title: string } {
  const s = sanitizeMusicVideoFileStem(stem);
  if (!s) return { artist: "", title: "" };
  const parts = s.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return {
      artist: parts[0]!.trim(),
      title: parts.slice(1).join(" - ").trim(),
    };
  }
  return { artist: "", title: s };
}
