import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import type { components } from '../../core/api/schema';
import { AnnotationViewService } from '../../core/addons/annotation-view.service';
import {
  ANNOTATION_LABEL_SCALE, AnnotationPayload, DrawnAnnotation, filterAnnotationItems, isDrawablePayload, layoutAnnotations,
  settingsFromView,
} from './annotations';

/** Marker and label colours per group, in payload group order: light tones that read on a dark sky and on blue twilight. */
export const ANNOTATION_PALETTE: readonly { stroke: string; fill: string }[] = [
  { stroke: 'stroke-amber-300', fill: 'fill-amber-300' },
  { stroke: 'stroke-sky-300', fill: 'fill-sky-300' },
  { stroke: 'stroke-fuchsia-300', fill: 'fill-fuchsia-300' },
  { stroke: 'stroke-emerald-300', fill: 'fill-emerald-300' },
  { stroke: 'stroke-orange-300', fill: 'fill-orange-300' },
  { stroke: 'stroke-lime-200', fill: 'fill-lime-200' },
  { stroke: 'stroke-rose-300', fill: 'fill-rose-300' },
  { stroke: 'stroke-white', fill: 'fill-white' },
];

export interface DrawnAnnotationView extends DrawnAnnotation {
  key: string;
  strokeClass: string;
  fillClass: string;
}

/** Everything the layer needs for one source: the SVG frame and what to draw, recomputed when the add-on's view changes. */
export interface AnnotationSourceView {
  source: string;
  title: string;
  viewBox: string;
  fontSize: number;
  drawn: DrawnAnnotationView[];
}

type AnnotationsResponse = components['schemas']['PhotoAnnotationsResponse'];

/**
 * The photo page's annotations: what the server stored for the open photo, and what to
 * draw of it. Facet has no controls of its own: a source is drawn only while its add-on
 * panel has set a visible view in {@link AnnotationViewService}, and that view (mapped
 * over the payload's defaults) decides the groups, thresholds and label options.
 * Provided by the photo page so the overlay layer shares one state.
 */
@Injectable()
export class PhotoAnnotationsState {
  private readonly api = inject(ApiService);
  private readonly viewService = inject(AnnotationViewService);
  private request = 0;

  readonly annotations = signal<{ source: string; payload: AnnotationPayload }[]>([]);
  /** ``source + '\n' + item id`` under the pointer or keyboard focus. */
  readonly hovered = signal<string | null>(null);

  readonly views = computed<AnnotationSourceView[]>(() => {
    const requested = this.viewService.views();
    const out: AnnotationSourceView[] = [];
    for (const { source, payload } of this.annotations()) {
      const view = requested[source];
      if (!view?.visible) continue;
      const s = settingsFromView(payload, view);
      const order = (payload.groups ?? []).map((g) => g.id);
      for (const item of payload.items) if (!order.includes(item.group)) order.push(item.group);
      const color = (i: number) => ANNOTATION_PALETTE[i % ANNOTATION_PALETTE.length];
      const drawn = layoutAnnotations(filterAnnotationItems(payload, s), payload, s, order).map((d) => ({
        ...d, key: `${source}
${d.id}`, strokeClass: color(d.color).stroke, fillClass: color(d.color).fill,
      }));
      const { width, height } = payload.image;
      out.push({
        source,
        title: payload.title || source,
        viewBox: `0 0 ${width} ${height}`,
        fontSize: Math.max(width, height) * ANNOTATION_LABEL_SCALE,
        drawn,
      });
    }
    return out;
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
      this.annotations.set(list);
    } catch {
      if (request === this.request) this.annotations.set([]);
    }
  }
}
