import { Injectable, WritableSignal, signal } from '@angular/core';

const METRICS_TAB_KEY = 'facet_photo_detail_tab';
export const METRICS_TABS = ['exif', 'quality', 'composition', 'technical', 'histogram'] as const;
export type MetricsTab = typeof METRICS_TABS[number];
/** The Grade panel's metric tabs (scores to judge by) and the Camera panel's (how it was shot), on the photo page and the gallery rail. */
export const GRADE_METRICS: readonly MetricsTab[] = ['quality', 'composition'];
export const CAMERA_METRICS: readonly MetricsTab[] = ['exif', 'technical', 'histogram'];
/**
 * Which set of metric tabs: '' is the full set (the gallery's details), `grade` and `camera` are the
 * photo panels' halves (scores to judge by, and how the photo was shot). Each remembers its own tab.
 */
export type MetricsPanel = '' | 'grade' | 'camera';
const PANEL_DEFAULTS: Record<MetricsPanel, MetricsTab> = { '': 'exif', grade: 'quality', camera: 'exif' };

function storageKey(panel: MetricsPanel): string {
  return panel ? `${METRICS_TAB_KEY}_${panel}` : METRICS_TAB_KEY;
}

function storedMetricsTab(panel: MetricsPanel): MetricsTab {
  try {
    const stored = localStorage.getItem(storageKey(panel));
    return METRICS_TABS.find(tab => tab === stored) ?? PANEL_DEFAULTS[panel];
  } catch {
    return PANEL_DEFAULTS[panel];
  }
}

/**
 * The open metric tab, one per app (and per panel) rather than per component: the gallery is
 * kept alive behind photo detail, so a tab chosen there must reach the gallery's panel on Back,
 * not only the next component created.
 */
@Injectable({ providedIn: 'root' })
export class MetricsTabState {
  private readonly tabs = new Map<MetricsPanel, WritableSignal<MetricsTab>>();
  /** The full set's tab. */
  readonly tab = this.tabFor('');

  tabFor(panel: MetricsPanel): WritableSignal<MetricsTab> {
    let tab = this.tabs.get(panel);
    if (!tab) {
      tab = signal(storedMetricsTab(panel));
      this.tabs.set(panel, tab);
    }
    return tab;
  }

  select(tab: MetricsTab, panel: MetricsPanel = ''): void {
    this.tabFor(panel).set(tab);
    try {
      localStorage.setItem(storageKey(panel), tab);
    } catch {
      // Storage blocked: the tab still switches, it is just not remembered.
    }
  }
}
