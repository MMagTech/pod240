/**
 * iPod-style Episode ID for `tven` / `--TVEpisode` (e.g. S01E01).
 * Matches Rust `tv_episode_sort_id` in `tagging.rs`.
 */
export function formatTvEpisodeSortId(season: number, episode: number): string {
  const s = Math.max(0, Math.floor(Number(season)));
  const e = Math.max(0, Math.floor(Number(episode)));
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `S${pad(s)}E${pad(e)}`;
}
