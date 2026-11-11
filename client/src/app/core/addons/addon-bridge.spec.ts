import { MAX_CONTEXT_PATHS, albumIdOf, buildContext, photoOf, readPanelMessage, routeOf } from './addon-bridge';

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
