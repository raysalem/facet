/**
 * Plugin-written photo annotations (payload v1): the types, the live filter, label
 * placement and the per-source settings remembered by this browser.
 *
 * A plugin (astro-id's plate solve, for example) stores its result once; everything
 * here runs client-side on that stored payload, so moving a slider never re-fetches
 * or recomputes on the server. All functions are pure apart from the storage pair.
 */

export interface AnnotationGroup {
  id: string;
  label?: string;
  default?: boolean;
}

export interface AnnotationMetric {
  key: string;
  label?: string;
  min: number;
  max: number;
  step?: number;
  default?: number;
  /** ``max``: an item shows while its value is at most the slider; ``min``: at least. */
  direction?: 'max' | 'min';
}

export interface AnnotationScore {
  label?: string;
  min: number;
  max: number;
  default?: number;
}

export type AnnotationPoint = [number, number];

export interface AnnotationItem {
  id: string;
  label: string;
  group: string;
  score?: number;
  shape: 'point' | 'circle' | 'lines';
  x?: number;
  y?: number;
  r?: number;
  segments?: [AnnotationPoint, AnnotationPoint][];
  label_at?: AnnotationPoint;
  values?: Record<string, number>;
  /** Id of the item this one belongs to (a star of an asterism); hidden while that item shows. */
  member_of?: string;
}

export interface AnnotationPayload {
  version: number;
  source?: string;
  title?: string;
  image: { width: number; height: number };
  legend?: string;
  groups?: AnnotationGroup[];
  metrics?: AnnotationMetric[];
  score?: AnnotationScore;
  items: AnnotationItem[];
}

/** What the user chose for one source: group toggles, score and metric thresholds, label options. */
export interface AnnotationSettings {
  groups: Record<string, boolean>;
  score: number | null;
  metrics: Record<string, number>;
  showScores: boolean;
  showMembers: boolean;
}

/** One item as drawn, in the payload's pixel frame (the SVG viewBox). */
export interface DrawnAnnotation {
  id: string;
  shape: AnnotationItem['shape'];
  x: number;
  y: number;
  r: number;
  /** SVG path data for a ``lines`` item. */
  d: string;
  /** Index into the colour palette, one per group. */
  color: number;
  /** Plain label, or label plus score when "Show scores" is on. */
  text: string;
  /** Label, score and values: the hover/focus tooltip. */
  tooltip: string;
  /** Label baseline start; used for the tooltip even when the label itself was skipped. */
  labelX: number;
  labelY: number;
  /** False when the label collided with a higher-scored one: only hover or focus shows it. */
  labelPlaced: boolean;
}

export const ANNOTATION_SETTINGS_KEY = 'facet_annotations:';
export const ANNOTATIONS_ENABLED_KEY = 'facet_annotations_enabled';
/** Label size as a fraction of the frame's longer edge, so it reads the same at any resolution. */
export const ANNOTATION_LABEL_SCALE = 0.013;
/** Smallest marker radius, as a fraction of the longer edge, so a 1-pixel star is still visible. */
export const ANNOTATION_MARKER_SCALE = 0.004;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The payload's own defaults: declared group defaults (an undeclared group is on), slider defaults, labels plain. */
export function defaultAnnotationSettings(p: AnnotationPayload): AnnotationSettings {
  const groups: Record<string, boolean> = {};
  for (const g of p.groups ?? []) groups[g.id] = g.default !== false;
  const metrics: Record<string, number> = {};
  for (const m of p.metrics ?? []) metrics[m.key] = finite(m.default) ? m.default : m.max;
  return {
    groups,
    score: p.score ? (finite(p.score.default) ? p.score.default : p.score.min) : null,
    metrics,
    showScores: false,
    showMembers: false,
  };
}

/**
 * Stored settings laid over the defaults, field by field: anything missing, mistyped
 * or out of range (the plugin narrowed a slider since) falls back to the default,
 * and a group or metric the payload no longer declares is dropped.
 */
export function mergeAnnotationSettings(p: AnnotationPayload, stored: unknown): AnnotationSettings {
  const out = defaultAnnotationSettings(p);
  if (!stored || typeof stored !== 'object') return out;
  const s = stored as Partial<Record<keyof AnnotationSettings, unknown>>;
  const groups = s.groups as Record<string, unknown> | undefined;
  if (groups && typeof groups === 'object') {
    for (const id of Object.keys(out.groups)) if (typeof groups[id] === 'boolean') out.groups[id] = groups[id] as boolean;
  }
  if (p.score && finite(s.score)) out.score = clamp(s.score, p.score.min, p.score.max);
  const metrics = s.metrics as Record<string, unknown> | undefined;
  if (metrics && typeof metrics === 'object') {
    for (const m of p.metrics ?? []) {
      const v = metrics[m.key];
      if (finite(v)) out.metrics[m.key] = clamp(v, m.min, m.max);
    }
  }
  if (typeof s.showScores === 'boolean') out.showScores = s.showScores;
  if (typeof s.showMembers === 'boolean') out.showMembers = s.showMembers;
  return out;
}

/**
 * The items the settings let through: group on, ``score >= slider``, each metric
 * within its slider (an item without that value is not filtered by it), and, unless
 * "Show members" is on, no member of an item that is itself shown.
 */
export function filterAnnotationItems(p: AnnotationPayload, s: AnnotationSettings): AnnotationItem[] {
  const metrics = p.metrics ?? [];
  const passed = p.items.filter((item) => {
    if (s.groups[item.group] === false) return false;
    if (s.score !== null && finite(item.score) && item.score < s.score) return false;
    for (const m of metrics) {
      const v = item.values?.[m.key];
      const limit = s.metrics[m.key];
      if (!finite(v) || !finite(limit)) continue;
      if (m.direction === 'min' ? v < limit : v > limit) return false;
    }
    return true;
  });
  if (s.showMembers) return passed;
  const shown = new Set(passed.map((i) => i.id));
  return passed.filter((i) => !i.member_of || !shown.has(i.member_of));
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

/** ``Uranus · Confidence 100 · mag 5.6``: the label, the score under the payload's score label, then each value. */
export function annotationTooltip(item: AnnotationItem, p: AnnotationPayload): string {
  const parts = [item.label];
  if (finite(item.score)) parts.push(`${p.score?.label ?? 'score'} ${fmt(item.score)}`);
  for (const [k, v] of Object.entries(item.values ?? {})) if (finite(v)) parts.push(`${k} ${fmt(v)}`);
  return parts.join(' · ');
}

/** Where an item's label is anchored: right of a marker, or at ``label_at`` / the first segment's middle. */
function labelAnchor(item: AnnotationItem, marker: number, fontSize: number): [number, number] {
  if (item.shape === 'lines') {
    if (item.label_at) return item.label_at;
    const [[x1, y1], [x2, y2]] = item.segments![0];
    return [(x1 + x2) / 2, (y1 + y2) / 2];
  }
  const r = item.shape === 'circle' ? item.r! : Math.max(item.r ?? 0, marker);
  return [item.x! + r + fontSize * 0.3, item.y! + fontSize * 0.35];
}

/** Rough text width: enough to keep two labels from overprinting, no font metrics needed. */
export function estimateLabelWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.58;
}

interface Box { x1: number; y1: number; x2: number; y2: number }

const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

/**
 * Turn the filtered items into drawable ones and place their labels: highest score
 * first, and a label that would overlap one already placed is skipped (its marker
 * still draws, and hovering or focusing it shows the tooltip).
 */
export function layoutAnnotations(
  items: AnnotationItem[], p: AnnotationPayload, s: AnnotationSettings, groupOrder: string[],
): DrawnAnnotation[] {
  const edge = Math.max(p.image.width, p.image.height);
  const fontSize = edge * ANNOTATION_LABEL_SCALE;
  const marker = edge * ANNOTATION_MARKER_SCALE;
  const placed: Box[] = [];
  const byScore = [...items].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  const labels = new Map<AnnotationItem, { x: number; y: number; placed: boolean }>();
  const textOf = (item: AnnotationItem) =>
    s.showScores && finite(item.score) ? `${item.label} ${fmt(item.score)}` : item.label;
  for (const item of byScore) {
    const [x, y] = labelAnchor(item, marker, fontSize);
    const centred = item.shape === 'lines';
    const w = estimateLabelWidth(textOf(item), fontSize);
    const box = { x1: centred ? x - w / 2 : x, y1: y - fontSize, x2: centred ? x + w / 2 : x + w, y2: y + fontSize * 0.25 };
    const free = !placed.some((b) => overlaps(b, box));
    if (free) placed.push(box);
    labels.set(item, { x: box.x1, y, placed: free });
  }
  return items.map((item) => {
    const label = labels.get(item)!;
    const group = groupOrder.indexOf(item.group);
    return {
      id: item.id,
      shape: item.shape,
      x: item.x ?? 0,
      y: item.y ?? 0,
      r: item.shape === 'circle' ? item.r! : Math.max(item.r ?? 0, marker),
      d: item.shape === 'lines'
        ? item.segments!.map(([[x1, y1], [x2, y2]]) => `M${x1} ${y1}L${x2} ${y2}`).join('')
        : '',
      color: group < 0 ? 0 : group,
      text: textOf(item),
      tooltip: annotationTooltip(item, p),
      labelX: label.x,
      labelY: label.y,
      labelPlaced: label.placed,
    };
  });
}

/** A payload the layer can draw: version 1, a positive image frame and an item list. */
export function isDrawablePayload(p: unknown): p is AnnotationPayload {
  const v = p as AnnotationPayload | null;
  return !!v && v.version === 1 && Array.isArray(v.items) && !!v.image
    && finite(v.image.width) && v.image.width > 0 && finite(v.image.height) && v.image.height > 0;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** This browser's settings for ``source``, merged over the payload's defaults. */
export function readAnnotationSettings(source: string, p: AnnotationPayload, store: Storage | null = storage()): AnnotationSettings {
  try {
    const raw = store?.getItem(ANNOTATION_SETTINGS_KEY + source);
    return mergeAnnotationSettings(p, raw ? JSON.parse(raw) : null);
  } catch {
    return defaultAnnotationSettings(p);
  }
}

export function writeAnnotationSettings(source: string, s: AnnotationSettings, store: Storage | null = storage()): void {
  try {
    store?.setItem(ANNOTATION_SETTINGS_KEY + source, JSON.stringify(s));
  } catch {
    // private window or blocked storage: the settings last for this page only
  }
}

export function readAnnotationsEnabled(store: Storage | null = storage()): boolean {
  try {
    return store?.getItem(ANNOTATIONS_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeAnnotationsEnabled(on: boolean, store: Storage | null = storage()): void {
  try {
    store?.setItem(ANNOTATIONS_ENABLED_KEY, on ? '1' : '0');
  } catch {
    // as above
  }
}
