/** "Details location": where a photo's details appear in the gallery — the docked side panel,
 *  a card beside the photo, or nowhere. */
export type DetailsPlace = 'off' | 'card' | 'panel';
export const DETAILS_PLACES: readonly DetailsPlace[] = ['off', 'card', 'panel'];

/** "Details mode": Hover = the details follow the pointer (a click still holds a photo: it pins the card
 *  or keeps the side panel on it); Click = the details change only when a photo is clicked.
 *  One setting for the card and the panel alike; it is kept while the location is Off. */
export type DetailsTrigger = 'hover' | 'click';
export const DETAILS_TRIGGERS: readonly DetailsTrigger[] = ['hover', 'click'];

/** A stored mode as the gallery reads it. 'both' (Hover or click, offered until 2026-11-24) is what Hover
 *  now does, so it reads as Hover; anything else unknown is dropped. */
export function readDetailsTrigger(value: unknown): DetailsTrigger | undefined {
  if (value === 'both') return 'hover';
  return DETAILS_TRIGGERS.includes(value as DetailsTrigger) ? value as DetailsTrigger : undefined;
}

export interface DetailsGestures {
  hover: boolean;
  click: boolean;
  keyboard: boolean;
}

/** Which gestures open a photo's details for a location and mode. A click (and Space, the keyboard's
 *  click) always does while details are on: in Hover mode it holds the photo, in Click mode it is the
 *  only way. Pointing does only in Hover mode. */
export function detailsGestures(place: DetailsPlace, trigger: DetailsTrigger): DetailsGestures {
  if (place === 'off') return { hover: false, click: false, keyboard: false };
  return { hover: trigger === 'hover', click: true, keyboard: true };
}
