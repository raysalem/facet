/** Findings of ui-probe that expectCleanUI deliberately does not fail on. Each matches by EXACT
 *  rule + selector (never by measurement), so a new offender, or the same rule on another element,
 *  still fails. Keep one line of evidence per entry; delete an entry when its cause is fixed.
 *  - kind 'finding': a real app defect, waiting for triage.
 *  - kind 'false-positive': the probe misreads something that is not what its rule is about, and
 *    no `panes` choice can express that (ui-probe.js itself is never weakened). */
export interface KnownFinding {
  id: string;
  kind: 'finding' | 'false-positive';
  /** The invariant: I1 hidden-but-visible, I2 scrollers, I3 page overflow, I4 floating width, I5 i18n keys, I7 alerts. */
  rule: 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I7';
  /** The probe's selector string for the element, exactly as it reports it. */
  selector: string;
  note: string;
}

export const KNOWN_FINDINGS: KnownFinding[] = [
  {
    id: 'FP-photo-face-overlay',
    kind: 'false-positive',
    rule: 'I4',
    selector: 'svg',
    note: 'The photo page lays an absolutely placed <svg> (face boxes) over the image, as wide as the image; it is not a floating card.',
  },
  {
    id: 'FP-photo-collection-overlay',
    kind: 'false-positive',
    rule: 'I4',
    selector: 'div.pointer-events-none.absolute',
    note: 'On a photo opened from a collection, the previous/next arrows sit in a pointer-events-none absolute inset-0 overlay (photo-detail.component.ts, the collection group) as wide as the image; it is not a floating card.',
  },
  {
    id: 'F-filters-drawer-double-scroll',
    kind: 'finding',
    rule: 'I2',
    selector: 'mat-sidenav.mat-drawer.mat-sidenav',
    note: 'At 1023x768 the album Filters drawer itself scrolls (734 of 720 px) while its inner list also scrolls (560 of 530 px): two vertical scrollers in one pane.',
  },
];
