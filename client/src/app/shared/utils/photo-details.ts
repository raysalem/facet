/** Where a photo's details appear in the gallery ("Photo details"): nowhere,
 *  in a card beside the photo, or in the docked side panel. */
export type DetailsPlace = 'off' | 'card' | 'panel';
export const DETAILS_PLACES: readonly DetailsPlace[] = ['off', 'card', 'panel'];

/** What opens them ("Open with"): pointing at a photo, clicking it, or either.
 *  One setting for the card and the panel alike; it is kept while the place is Off. */
export type DetailsTrigger = 'hover' | 'click' | 'both';
export const DETAILS_TRIGGERS: readonly DetailsTrigger[] = ['hover', 'click', 'both'];

export interface DetailsGestures {
  hover: boolean;
  click: boolean;
  keyboard: boolean;
}

/** Which gestures open a photo's details for a place and trigger. Keyboard
 *  selection (Space) always feeds the side panel, whatever the trigger: a
 *  keyboard user has no hover to fall back on. A hover-only card keeps Space
 *  for selecting, as the floating card never opened from the keyboard. */
export function detailsGestures(place: DetailsPlace, trigger: DetailsTrigger): DetailsGestures {
  if (place === 'off') return { hover: false, click: false, keyboard: false };
  return { hover: trigger !== 'click', click: trigger !== 'hover', keyboard: place === 'panel' || trigger !== 'hover' };
}
