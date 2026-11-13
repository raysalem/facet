import { Injectable, signal } from '@angular/core';

/**
 * What an add-on panel asks Facet to draw of its overlay (bridge message `annotation_view`).
 * `visible` false, or no view at all, draws nothing; a missing key means the payload's own default.
 */
export interface AnnotationView {
  visible: boolean;
  groups?: Record<string, boolean>;
  /** Minimum score shown; `null` turns the score filter off. */
  score?: number | null;
  /** Maximum value shown per metric (the metric's own direction applies). */
  metrics?: Record<string, number>;
  show_scores?: boolean;
  show_members?: boolean;
}

/**
 * The app-wide store of annotation views, one per add-on (the key is always the add-on's id).
 * The add-on sidebar writes it; the photo page's overlay reads it. Hidden by default: a source
 * with no view is not drawn.
 */
@Injectable({ providedIn: 'root' })
export class AnnotationViewService {
  readonly views = signal<Record<string, AnnotationView>>({});

  set(source: string, view: AnnotationView): void {
    this.views.update(all => ({ ...all, [source]: view }));
  }

  clear(source: string): void {
    this.views.update(all => {
      if (!(source in all)) return all;
      const rest = { ...all };
      delete rest[source];
      return rest;
    });
  }
}
