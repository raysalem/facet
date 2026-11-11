/**
 * postMessage v1 between Facet and an add-on panel (docs/CONFIGURATION.md, Add-ons).
 *
 * The panel lives in `<iframe sandbox="allow-scripts">`, an opaque origin, so `event.origin` is
 * `"null"` and says nothing. A message counts only when it comes from that iframe's own window
 * (`event.source`) AND carries the nonce Facet issued for this open; before a verified `ready`
 * everything else is ignored, and every iframe `load` requires a new `ready`.
 */

export const BRIDGE_VERSION = 1;
/** The most selection paths one `context` message carries. */
export const MAX_CONTEXT_PATHS = 500;
/** The most paths one `show_photos` / `refresh` message may name (the ui_show_photos cap). */
export const MAX_PANEL_PATHS = 200;

export type PanelScope =
  | { kind: 'import'; run_id: string; path_prefix?: string }
  | { kind: 'view'; query?: string; path_prefix?: string }
  | { kind: 'selection'; path_prefix?: string };

export interface PanelContext {
  type: 'context';
  v: number;
  nonce: string;
  route: string;
  album_id: number | null;
  photo: string | null;
  selection: string[];
  scope: PanelScope;
}

export type PanelRequest =
  | { type: 'ready' }
  | { type: 'show_photos'; paths: string[] }
  | { type: 'open_photo'; path: string }
  | { type: 'refresh'; paths: string[] }
  | { type: 'open_map'; site: MapSite }
  | { type: 'close' };

/**
 * `open_map`: the panel asks Facet to open a map site in a new tab (the sandbox forbids popups). Only these
 * fixed URLs ever open; the panel names a key, never a URL, so it cannot steer the tab anywhere else.
 */
export const MAP_SITES = {
  earth: 'https://earth.google.com/web/',
  maps: 'https://www.google.com/maps/',
} as const;
export type MapSite = keyof typeof MAP_SITES;

/** A string list of 1..`max` non-empty strings, or null. */
function pathList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
  return value.every(p => typeof p === 'string' && p.length > 0 && p.length <= 4096) ? value as string[] : null;
}

/**
 * The panel's message as a typed request, or null when it must be ignored: the wrong window, the
 * wrong nonce or version, an unknown type, or a malformed body.
 */
export function readPanelMessage(event: Pick<MessageEvent, 'source' | 'data'>, frame: Window | null,
  nonce: string): PanelRequest | null {
  if (!frame || event.source !== frame) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || data['v'] !== BRIDGE_VERSION || data['nonce'] !== nonce) return null;
  switch (data['type']) {
    case 'ready':
    case 'close':
      return { type: data['type'] };
    case 'show_photos':
    case 'refresh': {
      const paths = pathList(data['paths'], MAX_PANEL_PATHS);
      return paths ? { type: data['type'], paths } : null;
    }
    case 'open_map': {
      const site = data['site'];
      return typeof site === 'string' && Object.prototype.hasOwnProperty.call(MAP_SITES, site)
        ? { type: 'open_map', site: site as MapSite } : null;
    }
    case 'open_photo':
      return typeof data['path'] === 'string' && data['path'].length > 0 && data['path'].length <= 4096
        ? { type: 'open_photo', path: data['path'] } : null;
    default:
      return null;
  }
}

/** The route part of a router URL (no query or fragment). */
export function routeOf(url: string): string {
  return url.split(/[?#]/, 1)[0] || '/';
}

/** The album id of an `/album/<id>` route, else null. */
export function albumIdOf(url: string): number | null {
  const match = /^\/album\/(\d+)(?:\/|$)/.exec(routeOf(url));
  return match ? Number(match[1]) : null;
}

/** The `path` query parameter of a `/photo` route, else null. */
export function photoOf(url: string): string | null {
  if (routeOf(url) !== '/photo') return null;
  const query = url.split('?', 2)[1]?.split('#', 1)[0] ?? '';
  return new URLSearchParams(query).get('path');
}

/** The `context` message for the tab as it stands. Only what the tab shows; never more than 500 paths. */
export function buildContext(nonce: string, url: string, selection: Iterable<string>, scope: PanelScope): PanelContext {
  const paths: string[] = [];
  for (const path of selection) {
    if (paths.length >= MAX_CONTEXT_PATHS) break;
    paths.push(path);
  }
  return {
    type: 'context', v: BRIDGE_VERSION, nonce,
    route: routeOf(url), album_id: albumIdOf(url), photo: photoOf(url),
    selection: paths, scope,
  };
}
