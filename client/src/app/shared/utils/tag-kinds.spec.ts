import { tagKinds } from './tag-kinds';

describe('tagKinds', () => {
  it('splits a photo into Tags (AI + own), Object tags per add-on and Album tags', () => {
    const kinds = tagKinds(
      { tags_list: ['sky'], manual_tags: ['m42', 'peter/communion', 'trip', 'x'], album_tags: ['peter/communion'] },
      { m42: 'astro-id', x: 'other-addon' },
    );
    expect(kinds).toEqual({
      ai: ['sky'],
      own: ['trip'],
      objects: [{ source: 'astro-id', tags: ['m42'] }, { source: 'other-addon', tags: ['x'] }],
      album: ['peter/communion'],
    });
  });

  it('keeps every manual tag as a Tag when nothing names its kind (a server without the album registry)', () => {
    expect(tagKinds({ tags_list: [], manual_tags: ['peter/communion', 'trip'] })).toEqual({
      ai: [], own: ['peter/communion', 'trip'], objects: [], album: [],
    });
  });

  it('is empty for no photo', () => {
    expect(tagKinds(null)).toEqual({ ai: [], own: [], objects: [], album: [] });
  });
});
