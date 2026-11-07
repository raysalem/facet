/** One album tag inside the current view, as `GET /api/album_tags/facets` returns it. */
export interface AlbumTagCount {
  tag: string;
  count: number;
}

export interface AlbumTagChip {
  tag: string;
  label: string;
  count: number;
}

export interface AlbumTagChipGroups {
  sets: AlbumTagChip[];
  by: AlbumTagChip[];
}

const PHOTOGRAPHER = /^photographer\[([^\]]+)\]$/;

/**
 * Split an album's tags into the two chip rows.
 *
 * - **By**: `photographer[<name>]`, labelled with the name. A child under it
 *   (`photographer[ray]/dslr`) is a detail of that photographer, not a chip.
 * - **Sets**: every other tag that is a leaf, labelled with its last `/` segment.
 *   A tag that is the `/` parent of another one in the view is dropped: it is the
 *   event (`peter/communion`), which the album itself already is.
 *
 * A row with a single chip says nothing the album does not, so it is left empty.
 */
export function albumTagChipGroups(tags: readonly AlbumTagCount[]): AlbumTagChipGroups {
  const names = tags.map(t => t.tag);
  const isParent = (tag: string) => names.some(other => other.startsWith(tag + '/'));
  const by: AlbumTagChip[] = [];
  const sets: AlbumTagChip[] = [];
  for (const t of tags) {
    if (t.tag.startsWith('photographer[')) {
      const m = PHOTOGRAPHER.exec(t.tag);
      if (m) by.push({ tag: t.tag, label: m[1], count: t.count });
      continue;
    }
    if (isParent(t.tag)) continue;
    sets.push({ tag: t.tag, label: t.tag.slice(t.tag.lastIndexOf('/') + 1), count: t.count });
  }
  return { sets: sets.length > 1 ? sets : [], by: by.length > 1 ? by : [] };
}
