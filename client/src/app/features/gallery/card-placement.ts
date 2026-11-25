/** Where the floating details card goes for a photo: beside it, never over it, and inside `area`, the part of
 *  the screen the grid owns (below the toolbar, left of the rail and any side panel, above the selection bar),
 *  so it covers neither the nav bar, the toolbar, a panel nor the selection bar. */
export interface CardPlacement {
  x: number;
  y: number;
  /** The card sits left of the photo (its layout mirrors). */
  flipped: boolean;
  /** The tallest the card may be there (it scrolls inside beyond it), so it never runs over its photo. */
  maxHeight: number;
}

export interface PlacementBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Right of the photo when it fits, else left of it, else (a wide card beside a photo near the middle of a
 * narrow area) below it, else above it. When it fits nowhere whole it goes to the side of the photo with more
 * room and is capped to that room (it scrolls inside), rather than clamped over its own photo.
 * Beside the photo it is centred on it vertically and kept inside the area.
 */
export function placeCard(photo: PlacementBox, width: number, height: number, area: PlacementBox, margin = 16): CardPlacement {
  const left = area.left + margin, right = area.right - margin, top = area.top, bottom = area.bottom - margin;
  const clampX = (x: number) => Math.max(left, Math.min(x, right - width));
  const besideHeight = Math.max(0, bottom - top);
  const besideY = Math.max(top, Math.min(photo.top + (photo.bottom - photo.top) / 2 - height / 2, bottom - height));
  if (photo.right + margin + width <= right) return { x: photo.right + margin, y: besideY, flipped: false, maxHeight: besideHeight };
  if (photo.left - margin - width >= left) return { x: photo.left - margin - width, y: besideY, flipped: true, maxHeight: besideHeight };
  const x = clampX(photo.left + (photo.right - photo.left) / 2 - width / 2);
  const roomBelow = Math.max(0, bottom - (photo.bottom + margin));
  const roomAbove = Math.max(0, photo.top - margin - top);
  if (height <= roomBelow) return { x, y: photo.bottom + margin, flipped: false, maxHeight: roomBelow };
  if (height <= roomAbove) return { x, y: photo.top - margin - height, flipped: false, maxHeight: roomAbove };
  return roomBelow >= roomAbove
    ? { x, y: photo.bottom + margin, flipped: false, maxHeight: roomBelow }
    : { x, y: top, flipped: false, maxHeight: roomAbove };
}
