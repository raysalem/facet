import type { Photo } from '../models/photo.model';

/** One add-on's object tags: what it found in the image. */
export interface ObjectTagGroup {
  /** The add-on's id. */
  source: string;
  tags: string[];
}

/**
 * A photo's tags in the four kinds the UI names, never mixed:
 * - **Tags** describe the image: the AI's (`ai`) and the ones the user typed or imported (`own`).
 * - **Object tags**: what an add-on found (`objects`, one group per add-on).
 * - **Album tags**: filing only (`album`), never shown as description.
 * - **People tags** are the photo's `persons`, which need no splitting.
 */
export interface TagKinds {
  ai: readonly string[];
  own: string[];
  objects: ObjectTagGroup[];
  album: string[];
}

type TaggedPhoto = Pick<Photo, 'tags_list' | 'manual_tags'> & Partial<Pick<Photo, 'album_tags'>>;

/**
 * Split a photo's tags by kind. `sources` maps a manual tag to the add-on that wrote it (`manual_tag_sources`,
 * plus Model D's `plugin_tags`). A server with the album-tag registry sends album tags apart in `album_tags`; one
 * without it cannot tell them from typed tags, so they stay in `own`.
 */
export function tagKinds(photo: TaggedPhoto | null | undefined, sources: Readonly<Record<string, string>> = {}): TagKinds {
  const album = [...(photo?.album_tags ?? [])];
  const albumSet = new Set(album);
  const own: string[] = [];
  const bySource = new Map<string, string[]>();
  for (const tag of photo?.manual_tags ?? []) {
    if (albumSet.has(tag)) continue;
    const source = sources[tag];
    if (!source) own.push(tag);
    else bySource.set(source, [...(bySource.get(source) ?? []), tag]);
  }
  return {
    ai: photo?.tags_list ?? [],
    own,
    objects: [...bySource].map(([source, tags]) => ({ source, tags })),
    album,
  };
}
