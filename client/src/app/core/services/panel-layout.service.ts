import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { SIDE_PANELS_MIN_WIDTH_PX } from '../../shared/utils/media-query';

/** Where a page's panels go on a phone (below sm): a sheet from the bottom (the phone layout) or at the side. */
export type PhonePanel = 'sheet' | 'side';
export const PHONE_PANELS: readonly PhonePanel[] = ['sheet', 'side'];
const STORAGE_KEY = 'facet_phone_panel';

/**
 * Where the side panels live: the gallery's rail with Showing and the photo details, the photo page's
 * inspector, and the add-on dock. From sm (640 px) they always sit at the side of the content, never below
 * it; when room is short the panel narrows to its minimum and the content gives way. Below sm the phone
 * setting decides: a bottom sheet (the default, the phone layout) or the side as on a wider screen.
 *
 * `side` is mirrored onto `<html data-side-panels>`, so templates lay out with the `in-data-[side-panels]:`
 * variant rather than a width breakpoint (a phone set to Side is narrower than sm).
 */
@Injectable({ providedIn: 'root' })
export class PanelLayoutService {
  private readonly document = inject(DOCUMENT);
  /** The viewport is sm or wider. Writable for tests, which drive it rather than stub matchMedia. */
  private readonly wide = signal(false);
  readonly phonePanel = signal<PhonePanel>(this.read());
  /** Whether the panels sit at the side of the content (sm and up, or a phone set to Side). */
  readonly side = computed(() => this.wide() || this.phonePanel() === 'side');
  /** Below sm: the phone setting applies (and Display offers it). */
  readonly phone = computed(() => !this.wide());

  constructor() {
    const view = this.document.defaultView;
    const query = view?.matchMedia?.(`(min-width: ${SIDE_PANELS_MIN_WIDTH_PX}px)`);
    if (query) {
      this.wide.set(!!query.matches);
      const listener = (event: MediaQueryListEvent) => this.wide.set(event.matches);
      query.addEventListener?.('change', listener);
      inject(DestroyRef).onDestroy(() => query.removeEventListener?.('change', listener));
    }
    effect(() => {
      const root = this.document.documentElement;
      if (this.side()) root.setAttribute('data-side-panels', '');
      else root.removeAttribute('data-side-panels');
    });
  }

  setPhonePanel(value: PhonePanel): void {
    this.phonePanel.set(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* browser storage unavailable: this visit only */ }
  }

  /** Tests: the viewport's side of sm. */
  setWide(wide: boolean): void {
    this.wide.set(wide);
  }

  private read(): PhonePanel {
    try { return localStorage.getItem(STORAGE_KEY) === 'side' ? 'side' : 'sheet'; } catch { return 'sheet'; }
  }
}
