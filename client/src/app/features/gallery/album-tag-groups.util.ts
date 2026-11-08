/** One album tag inside the current view, as `GET /api/album_tags/facets` returns it. */
export interface AlbumTagCount {
  tag: string;
  count: number;
}

export interface AlbumTagOption {
  tag: string;
  label: string;
  count: number;
}

export interface AlbumTagGroups {
  sets: AlbumTagOption[];
  by: AlbumTagOption[];
}

const PHOTOGRAPHER = /^photographer\[([^\]]+)\]$/;

/** How an album tag reads in a pull-down or filter chip: `robin` for `photographer[robin]`, `church` for `peter/communion/church`. */
export function albumTagLabel(tag: string): string {
  const m = PHOTOGRAPHER.exec(tag);
  return m ? m[1] : tag.slice(tag.lastIndexOf('/') + 1);
}

/**
 * Split an album's tags into its two filter pull-downs.
 *
 * - **By**: `photographer[<name>]`, labelled with the name. A child under it
 *   (`photographer[ray]/dslr`) is a detail of that photographer, not an option.
 * - **Sets**: every other tag that is a leaf, labelled with its last `/` segment.
 *   A tag that is the `/` parent of another one in the view is dropped: it is the
 *   event (`peter/communion`), which the album itself already is.
 *
 * A pull-down with a single option says nothing the album does not, so it is left empty.
 */
export function albumTagGroups(tags: readonly AlbumTagCount[]): AlbumTagGroups {
  const names = tags.map(t => t.tag);
  const isParent = (tag: string) => names.some(other => other.startsWith(tag + '/'));
  const by: AlbumTagOption[] = [];
  const sets: AlbumTagOption[] = [];
  for (const t of tags) {
    if (t.tag.startsWith('photographer[')) {
      if (PHOTOGRAPHER.test(t.tag)) by.push({ tag: t.tag, label: albumTagLabel(t.tag), count: t.count });
      continue;
    }
    if (isParent(t.tag)) continue;
    sets.push({ tag: t.tag, label: albumTagLabel(t.tag), count: t.count });
  }
  return { sets: sets.length > 1 ? sets : [], by: by.length > 1 ? by : [] };
}
