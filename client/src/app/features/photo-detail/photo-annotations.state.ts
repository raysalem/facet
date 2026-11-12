import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import type { components } from '../../core/api/schema';
import {
  ANNOTATION_LABEL_SCALE, AnnotationPayload, AnnotationSettings, DrawnAnnotation, defaultAnnotationSettings, filterAnnotationItems,
  isDrawablePayload, layoutAnnotations, readAnnotationSettings, readAnnotationsEnabled, writeAnnotationSettings,
  writeAnnotationsEnabled,
} from './annotations';

/** Marker and label colours per group, in payload group order: light tones that read on a dark sky and on blue twilight. */
export const ANNOTATION_PALETTE: readonly { stroke: string; fill: string; swatch: string }[] = [
  { stroke: 'stroke-amber-300', fill: 'fill-amber-300', swatch: 'bg-amber-300' },
  { stroke: 'stroke-sky-300', fill: 'fill-sky-300', swatch: 'bg-sky-300' },
  { stroke: 'stroke-fuchsia-300', fill: 'fill-fuchsia-300', swatch: 'bg-fuchsia-300' },
  { stroke: 'stroke-emerald-300', fill: 'fill-emerald-300', swatch: 'bg-emerald-300' },
  { stroke: 'stroke-orange-300', fill: 'fill-orange-300', swatch: 'bg-orange-300' },
  { stroke: 'stroke-lime-200', fill: 'fill-lime-200', swatch: 'bg-lime-200' },
  { stroke: 'stroke-rose-300', fill: 'fill-rose-300', swatch: 'bg-rose-300' },
  { stroke: 'stroke-white', fill: 'fill-white', swatch: 'bg-white' },
];

export interface DrawnAnnotationView extends DrawnAnnotation {
  key: string;
  strokeClass: string;
  fillClass: string;
}

export interface AnnotationSliderView {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

/** Everything the layer and the panel need for one source, recomputed when a setting changes. */
export interface AnnotationSourceView {
  source: string;
  title: string;
  legend: string;
  viewBox: string;
  fontSize: number;
  drawn: DrawnAnnotationView[];
  shown: number;
  total: number;
  groups: { id: string; label: string; on: boolean; swatch: string }[];
  score: AnnotationSliderView | null;
  metrics: AnnotationSliderView[];
  showScores: boolean;
  showMembers: boolean;
  hasMembers: boolean;
}

type AnnotationsResponse = components['schemas']['PhotoAnnotationsResponse'];

function sliderStep(min: number, max: number, step?: number): number {
  return step && step > 0 ? step : (max - min) / 100 || 1;
}

/**
 * The photo page's annotations: what the server stored for the open photo, whether
 * the overlay is on (remembered per browser), and each source's settings (remembered
 * per browser and source). Provided by the photo page so its overlay layer and its
 * control panel, which sit in different parts of the page, share one state.
 */
@Injectable()
export class PhotoAnnotationsState {
  private readonly api = inject(ApiService);
  private request = 0;

  readonly annotations = signal<{ source: string; payload: AnnotationPayload }[]>([]);
  readonly enabled = signal(readAnnotationsEnabled());
  readonly settings = signal<Record<string, AnnotationSettings>>({});
  /** ``source + '\n' + item id`` under the pointer or keyboard focus. */
  readonly hovered = signal<string | null>(null);
  readonly available = computed(() => this.annotations().length > 0);

  readonly views = computed<AnnotationSourceView[]>(() => {
    const settings = this.settings();
    return this.annotations().map(({ source, payload }) => {
      const s = settings[source] ?? defaultAnnotationSettings(payload);
      const groups = payload.groups ?? [];
      const order = groups.map((g) => g.id);
      for (const item of payload.items) if (!order.includes(item.group)) order.push(item.group);
      const color = (i: number) => ANNOTATION_PALETTE[i % ANNOTATION_PALETTE.length];
      const items = filterAnnotationItems(payload, s);
      const drawn = layoutAnnotations(items, payload, s, order).map((d) => ({
        ...d, key: `${source}\n${d.id}`, strokeClass: color(d.color).stroke, fillClass: color(d.color).fill,
      }));
      const { width, height } = payload.image;
      return {
        source,
        title: payload.title || source,
        legend: payload.legend ?? '',
        viewBox: `0 0 ${width} ${height}`,
        fontSize: Math.max(width, height) * ANNOTATION_LABEL_SCALE,
        drawn,
        shown: drawn.length,
        total: payload.items.length,
        groups: groups.map((g) => ({
          id: g.id, label: g.label || g.id, on: s.groups[g.id] !== false, swatch: color(order.indexOf(g.id)).swatch,
        })),
        score: payload.score && s.score !== null ? {
          key: 'score', label: payload.score.label || 'score', min: payload.score.min, max: payload.score.max,
          step: sliderStep(payload.score.min, payload.score.max), value: s.score,
        } : null,
        metrics: (payload.metrics ?? []).map((m) => ({
          key: m.key, label: m.label || m.key, min: m.min, max: m.max,
          step: sliderStep(m.min, m.max, m.step), value: s.metrics[m.key] ?? m.max,
        })),
        showScores: s.showScores,
        showMembers: s.showMembers,
        hasMembers: payload.items.some((i) => !!i.member_of),
      };
    });
  });

  /** Read the photo's annotations; a response for an earlier photo is dropped. */
  async load(path: string | null): Promise<void> {
    const request = ++this.request;
    this.annotations.set([]);
    this.hovered.set(null);
    if (!path) return;
    try {
      const res = await firstValueFrom(this.api.get<AnnotationsResponse>('/photo/annotations', { path }));
      if (request !== this.request) return;
      const list = (res?.annotations ?? [])
        .filter((a) => isDrawablePayload(a.payload))
        .map((a) => ({ source: a.source, payload: a.payload as unknown as AnnotationPayload }));
      const settings: Record<string, AnnotationSettings> = {};
      for (const a of list) settings[a.source] = readAnnotationSettings(a.source, a.payload);
      this.settings.set(settings);
      this.annotations.set(list);
    } catch {
      if (request === this.request) this.annotations.set([]);
    }
  }

  toggle(): void {
    const on = !this.enabled();
    this.enabled.set(on);
    writeAnnotationsEnabled(on);
  }

  private patch(source: string, change: (s: AnnotationSettings) => AnnotationSettings): void {
    const entry = this.annotations().find((a) => a.source === source);
    if (!entry) return;
    const current = this.settings()[source] ?? defaultAnnotationSettings(entry.payload);
    const next = change(current);
    this.settings.update((all) => ({ ...all, [source]: next }));
    writeAnnotationSettings(source, next);
  }

  setGroup(source: string, id: string, on: boolean): void {
    this.patch(source, (s) => ({ ...s, groups: { ...s.groups, [id]: on } }));
  }

  setScore(source: string, value: number): void {
    if (Number.isFinite(value)) this.patch(source, (s) => ({ ...s, score: value }));
  }

  setMetric(source: string, key: string, value: number): void {
    if (Number.isFinite(value)) this.patch(source, (s) => ({ ...s, metrics: { ...s.metrics, [key]: value } }));
  }

  setShowScores(source: string, on: boolean): void {
    this.patch(source, (s) => ({ ...s, showScores: on }));
  }

  setShowMembers(source: string, on: boolean): void {
    this.patch(source, (s) => ({ ...s, showMembers: on }));
  }

  /** Back to the payload's own defaults (and forget what this browser stored). */
  reset(source: string): void {
    const entry = this.annotations().find((a) => a.source === source);
    if (entry) this.patch(source, () => defaultAnnotationSettings(entry.payload));
  }
}
