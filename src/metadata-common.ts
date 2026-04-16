/**
 * Shared optional iTunes atoms (desc, genre, …) for movie / TV / music video.
 */

export interface CommonTagFields {
  description?: string;
  longDescription?: string;
  genre?: string;
  releaseDate?: string;
  sortTitle?: string;
  hdVideo?: boolean;
  contentRating?: string;
  encoder?: string;
  copyright?: string;
}

export interface CommonTagFieldsHtmlOptions {
  /** When false, optional tags are collapsed until the user expands (saves space in TV batch dialogs). Default true. */
  defaultOpen?: boolean;
  /** Extra class on the &lt;details&gt; wrapper (e.g. spacing after TV network row). */
  detailsClass?: string;
  /**
   * When true, adds a Composer row (©wrt) in optional tags — used for Music Video; the caller toggles
   * visibility when switching between Movie / TV / Music Video.
   */
  includeComposerRow?: boolean;
  /** When true, omit Genre from this optional block (caller places it in the main form for movie/TV). */
  excludeGenre?: boolean;
  /**
   * When true, adds TV Network + Sort show in the optional block (single-file TV).
   * Row visibility is toggled by the caller (e.g. hidden except when category is TV).
   */
  includeTvNetworkSortRow?: boolean;
  /**
   * When true with `includeTvNetworkSortRow`, the TV block is not given the `hidden` attribute
   * (TV-only batch dialogs: row is visible whenever Optional Tags is expanded).
   */
  tvNetworkSortRowAlwaysVisible?: boolean;
  /**
   * When true, adds Album Artist in the optional block (single-file Music Video).
   * Row visibility is toggled by the caller (e.g. hidden except when category is Music Video).
   */
  includeMusicVideoAlbumArtistRow?: boolean;
  /**
   * When true, omit the Release Date row here (e.g. single-file TV puts it next to Episode ID).
   */
  omitReleaseDate?: boolean;
  /**
   * TV batch / orphan batch: set placeholder text on the shared Full description textarea explaining fallback behavior.
   */
  tvBatchLongDescriptionHint?: boolean;
}

/** HTML for the optional shared fieldset; inputs use ids prefixed with `prefix` (default `meta-common-`). */
export function commonTagFieldsHtml(
  prefix = "meta-common",
  options?: CommonTagFieldsHtmlOptions
): string {
  const p = prefix;
  const defaultOpen = options?.defaultOpen !== false;
  const openAttr = defaultOpen ? " open" : "";
  const detailsClass = ["meta-optional-tags-details", options?.detailsClass]
    .filter(Boolean)
    .join(" ");
  const hasMvExtras =
    options?.includeComposerRow === true || options?.includeMusicVideoAlbumArtistRow === true;
  const mvExtrasBlock = hasMvExtras
    ? `
      <div id="${p}-optional-mv-extras" class="meta-optional-kind-block" hidden>
        ${
          options?.includeComposerRow === true
            ? `
        <div class="meta-row2 meta-optional-composer-row" id="${p}-composer-row">
          <label>Composer
            <input type="text" id="${p}-composer" class="meta-input" /></label>
        </div>`
            : ""
        }
        ${
          options?.includeMusicVideoAlbumArtistRow === true
            ? `
        <div id="${p}-mv-album-artist-row">
          <label>Album Artist
            <input type="text" id="${p}-mv-album-artist" class="meta-input" /></label>
        </div>`
            : ""
        }
      </div>`
    : "";
  const tvExtrasHidden =
    options?.includeTvNetworkSortRow === true &&
    options?.tvNetworkSortRowAlwaysVisible !== true;
  const tvExtrasBlock =
    options?.includeTvNetworkSortRow === true
      ? `
      <div id="${p}-optional-tv-extras" class="meta-optional-kind-block"${tvExtrasHidden ? " hidden" : ""}>
        <div class="meta-row2" id="${p}-tv-net-sort-row">
          <label>TV Network
            <input type="text" id="${p}-tv-network" class="meta-input" /></label>
          <label>Sort Show
            <input type="text" id="${p}-tv-sort-show" class="meta-input" /></label>
        </div>
      </div>`
      : "";
  const tvBatchLdesPlaceholder =
    options?.tvBatchLongDescriptionHint === true
      ? ' placeholder="This Full description is used only for rows where that episode field is still empty — for example when TMDB has no episode overview."'
      : "";
  const exGenre = options?.excludeGenre === true;
  const omitRd = options?.omitReleaseDate === true;
  const genreReleaseRow =
    exGenre && omitRd
      ? ""
      : exGenre
        ? `      <div class="meta-row2">
        <label>Release Date
          <input type="text" id="${p}-release" class="meta-input" />
        </label>
      </div>`
        : omitRd
          ? `      <div class="meta-row2">
        <span id="${p}-genre-wrap" class="meta-optional-genre-wrap">
        <label>Genre
          <input type="text" id="${p}-genre" class="meta-input" />
        </label>
        </span>
      </div>`
          : `      <div class="meta-row2">
        <span id="${p}-genre-wrap" class="meta-optional-genre-wrap">
        <label>Genre
          <input type="text" id="${p}-genre" class="meta-input" />
        </label>
        </span>
        <label>Release Date
          <input type="text" id="${p}-release" class="meta-input" />
        </label>
      </div>`;
  return `
    <details id="${p}-wrap" class="${detailsClass}"${openAttr}>
      <summary class="meta-optional-tags-summary">
        <span class="meta-optional-tags-title">Optional Tags</span>
      </summary>
      <div class="meta-optional-tags-body">
      <p class="meta-tiny meta-fieldset-hint" id="${p}-fieldset-hint">Short and full description, sort title, and other iTunes atoms. Every field here is optional.</p>
    <fieldset class="meta-fieldset meta-fieldset--optional" id="${p}-fieldset" aria-label="Optional Tags">
      <div class="meta-fieldset-desc-grid">
      <label>Short Description
        <textarea id="${p}-desc" class="meta-input meta-textarea" rows="3"></textarea>
      </label>
      <label>Full Description
        <textarea id="${p}-ldes" class="meta-input meta-textarea" rows="3"${tvBatchLdesPlaceholder}></textarea>
      </label>
      </div>
      ${mvExtrasBlock}
      ${tvExtrasBlock}
${genreReleaseRow}
      <div class="meta-sort-hd-row">
        <label>Sort Title
          <input type="text" id="${p}-sort-title" class="meta-input" />
        </label>
        <label class="meta-check-label meta-hd-toggle">
          <input type="checkbox" id="${p}-hd" /> HD Video
        </label>
      </div>
      <label>
        <span class="meta-label-heading">Content Rating
          <a class="app-menu-external-link" href="https://github.com/wez/atomicparsley" target="_blank" rel="noopener noreferrer">AtomicParsley Documentation</a>
        </span>
        <input type="text" id="${p}-rating" class="meta-input" />
      </label>
      <div class="meta-row2">
        <label>Encoder
          <input type="text" id="${p}-encoder" class="meta-input" />
        </label>
        <label>Copyright
          <input type="text" id="${p}-copyright" class="meta-input" />
        </label>
      </div>
    </fieldset>
      </div>
    </details>`;
}

export type ReadCommonTagFieldsOptions = {
  /** Skip reading genre from optional tags (e.g. Music Video uses genre in its main section). */
  skipGenre?: boolean;
};

export function readCommonTagFields(
  root: ParentNode,
  prefix = "meta-common",
  opts?: ReadCommonTagFieldsOptions
): CommonTagFields {
  const p = prefix;
  const val = (id: string) =>
    ((root.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "").trim();
  const desc = val(`${p}-desc`);
  const ldes = val(`${p}-ldes`);
  const genre = opts?.skipGenre ? "" : val(`${p}-genre`);
  const releaseDate = val(`${p}-release`);
  const sortTitle = val(`${p}-sort-title`);
  const contentRating = val(`${p}-rating`);
  const encoder = val(`${p}-encoder`);
  const copyright = val(`${p}-copyright`);
  const hdEl = root.querySelector(`#${p}-hd`) as HTMLInputElement | null;

  const out: CommonTagFields = {};
  if (desc) out.description = desc;
  if (ldes) out.longDescription = ldes;
  if (genre) out.genre = genre;
  if (releaseDate) out.releaseDate = releaseDate;
  if (sortTitle) out.sortTitle = sortTitle;
  if (hdEl?.checked) out.hdVideo = true;
  if (contentRating) out.contentRating = contentRating;
  if (encoder) out.encoder = encoder;
  if (copyright) out.copyright = copyright;
  return out;
}

/** Fill optional-tag inputs (e.g. after carrying values from a previous season step). */
export function applyCommonTagFields(root: ParentNode, prefix: string, fields: CommonTagFields): void {
  const p = prefix;
  const set = (suffix: string, v: string) => {
    const el = root.querySelector(`#${p}-${suffix}`) as HTMLInputElement | HTMLTextAreaElement | null;
    if (el) el.value = v;
  };
  if (fields.description !== undefined) set("desc", fields.description);
  if (fields.longDescription !== undefined) set("ldes", fields.longDescription);
  if (fields.genre !== undefined) set("genre", fields.genre);
  if (fields.releaseDate !== undefined) set("release", fields.releaseDate);
  if (fields.sortTitle !== undefined) set("sort-title", fields.sortTitle);
  if (fields.contentRating !== undefined) set("rating", fields.contentRating);
  if (fields.encoder !== undefined) set("encoder", fields.encoder);
  if (fields.copyright !== undefined) set("copyright", fields.copyright);
  if (fields.hdVideo !== undefined) {
    const hd = root.querySelector(`#${p}-hd`) as HTMLInputElement | null;
    if (hd) hd.checked = !!fields.hdVideo;
  }
}
