import { MAP_SITES, MAX_CONTEXT_PATHS, albumIdOf, buildContext, photoOf, readPanelMessage, routeOf } from './addon-bridge';

describe('add-on bridge v1', () => {
  const frame = {} as Window;
  const other = {} as Window;
  const msg = (data: unknown, source: Window = frame) => ({ source, data }) as MessageEvent;

  it('accepts only the panel window with the issued nonce and version', () => {
    expect(readPanelMessage(msg({ type: 'ready', v: 1, nonce: 'n' }), frame, 'n')).toEqual({ type: 'ready' });
    expect(readPanelMessage(msg({ type: 'ready', v: 1, nonce: 'n' }, other), frame, 'n')).toBeNull();
    expect(readPanelMessage(msg({ type: 'ready', v: 1, nonce: 'x' }), frame, 'n')).toBeNull();
    expect(readPanelMessage(msg({ type: 'ready', v: 2, nonce: 'n' }), frame, 'n')).toBeNull();
    expect(readPanelMessage(msg({ type: 'ready', v: 1, nonce: 'n' }), null, 'n')).toBeNull();
    expect(readPanelMessage(msg('ready'), frame, 'n')).toBeNull();
  });

  it('types the panel requests and ignores unknown or malformed ones', () => {
    const base = { v: 1, nonce: 'n' };
    expect(readPanelMessage(msg({ ...base, type: 'show_photos', paths: ['/a.jpg'] }), frame, 'n'))
      .toEqual({ type: 'show_photos', paths: ['/a.jpg'] });
    expect(readPanelMessage(msg({ ...base, type: 'refresh', paths: ['/a.jpg'] }), frame, 'n'))
      .toEqual({ type: 'refresh', paths: ['/a.jpg'] });
    expect(readPanelMessage(msg({ ...base, type: 'open_photo', path: '/a.jpg' }), frame, 'n'))
      .toEqual({ type: 'open_photo', path: '/a.jpg' });
    expect(readPanelMessage(msg({ ...base, type: 'close' }), frame, 'n')).toEqual({ type: 'close' });
    expect(readPanelMessage(msg({ ...base, type: 'show_photos', paths: [] }), frame, 'n')).toBeNull();
    expect(readPanelMessage(msg({ ...base, type: 'show_photos', paths: Array(201).fill('/a') }), frame, 'n')).toBeNull();
    expect(readPanelMessage(msg({ ...base, type: 'show_photos', paths: [1] }), frame, 'n')).toBeNull();
    expect(readPanelMessage(msg({ ...base, type: 'open_photo' }), frame, 'n')).toBeNull();
    expect(readPanelMessage(msg({ ...base, type: 'delete_everything' }), frame, 'n')).toBeNull();
  });

  it('opens only the two fixed map sites, by key', () => {
    const base = { v: 1, nonce: 'n' };
    expect(readPanelMessage(msg({ ...base, type: 'open_map', site: 'earth' }), frame, 'n'))
      .toEqual({ type: 'open_map', site: 'earth' });
    expect(readPanelMessage(msg({ ...base, type: 'open_map', site: 'maps' }), frame, 'n'))
      .toEqual({ type: 'open_map', site: 'maps' });
    for (const site of ['https://evil.example/', 'toString', '__proto__', '', 1, undefined]) {
      expect(readPanelMessage(msg({ ...base, type: 'open_map', site }), frame, 'n')).toBeNull();
    }
    expect(readPanelMessage(msg({ ...base, type: 'open_map', site: 'maps', url: 'https://x/' }), frame, 'n'))
      .toEqual({ type: 'open_map', site: 'maps' });
    expect(Object.values(MAP_SITES).every(u => u.startsWith('https://earth.google.com/') || u.startsWith('https://www.google.com/maps/')))
      .toBe(true);
  });

  it('accepts an annotation_view, drops unknown keys and keeps only what it validated', () => {
    const base = { v: 1, nonce: 'n', type: 'annotation_view' };
    expect(readPanelMessage(msg({ ...base, view: { visible: false } }), frame, 'n'))
      .toEqual({ type: 'annotation_view', view: { visible: false } });
    const full = {
      visible: true, groups: { star: true, planet: false }, score: 80, metrics: { mag: 6.5 },
      show_scores: true, show_members: false, extra: 'dropped', source: 'evil-addon',
    };
    expect(readPanelMessage(msg({ ...base, view: full, source: 'evil-addon' }), frame, 'n')).toEqual({
      type: 'annotation_view',
      view: { visible: true, groups: { star: true, planet: false }, score: 80, metrics: { mag: 6.5 }, show_scores: true, show_members: false },
    });
    expect(readPanelMessage(msg({ ...base, view: { visible: true, score: null } }), frame, 'n'))
      .toEqual({ type: 'annotation_view', view: { visible: true, score: null } });
  });

  it('rejects a malformed annotation_view', () => {
    const base = { v: 1, nonce: 'n', type: 'annotation_view' };
    const bad: unknown[] = [
      undefined, null, 'x', [], {}, { visible: 'yes' }, { visible: 1 },
      { visible: true, groups: { a: 'on' } }, { visible: true, groups: [true] }, { visible: true, groups: null },
      { visible: true, metrics: { m: '5' } }, { visible: true, metrics: { m: Infinity } }, { visible: true, metrics: { m: NaN } },
      { visible: true, score: '80' }, { visible: true, score: NaN }, { visible: true, score: Infinity },
      { visible: true, show_scores: 1 }, { visible: true, show_members: 'true' },
      { visible: true, groups: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`g${i}`, true])) },
      { visible: true, metrics: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`m${i}`, 1])) },
    ];
    for (const view of bad) expect(readPanelMessage(msg({ ...base, view }), frame, 'n')).toBeNull();
    const atCap = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`g${i}`, true]));
    expect(readPanelMessage(msg({ ...base, view: { visible: true, groups: atCap } }), frame, 'n')).not.toBeNull();
    expect(readPanelMessage(msg({ ...base, view: { visible: true }, nonce: 'wrong' }), frame, 'n')).toBeNull();
    expect(readPanelMessage(msg({ ...base, view: { visible: true }, v: 2 }), frame, 'n')).toBeNull();
  });

  it('reads the route, album and photo out of the router URL', () => {
    expect(routeOf('/album/12?x=1')).toBe('/album/12');
    expect(albumIdOf('/album/12?x=1')).toBe(12);
    expect(albumIdOf('/')).toBeNull();
    expect(photoOf('/photo?path=%2Fp%2Fa.jpg')).toBe('/p/a.jpg');
    expect(photoOf('/?path=/a.jpg')).toBeNull();
  });

  it('builds a capped context with the scope', () => {
    const selection = Array.from({ length: 600 }, (_, i) => `/p/${i}.jpg`);
    const context = buildContext('n', '/photo?path=%2Fp%2F1.jpg', selection, { kind: 'import', run_id: 'abc' });
    expect(context).toMatchObject({ type: 'context', v: 1, nonce: 'n', route: '/photo', album_id: null,
      photo: '/p/1.jpg', scope: { kind: 'import', run_id: 'abc' } });
    expect(context.selection).toHaveLength(MAX_CONTEXT_PATHS);
  });
});
