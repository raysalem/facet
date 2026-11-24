/** Where the floating details card goes for a photo: beside it, never over it, and never above `minTop`
 *  (the bottom of the gallery's toolbar, so the card cannot cover the nav bar or the toolbar). */
export interface CardPlacement {
  x: number;
  y: number;
  /** The card sits left of the photo (its layout mirrors). */
  flipped: boolean;
}

export interface PlacementBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Right of the photo when it fits, else left of it, else (a wide card beside a photo near the middle of a
 * narrow window) below it, else above it; only when none fits is it clamped, preferring the larger free side.
 * Vertically beside the photo it is centred on it and kept between `minTop` and the bottom margin.
 */
export function placeCard(photo: PlacementBox, width: number, height: number, viewport: { width: number; height: number },
  minTop: number, margin = 16): CardPlacement {
  const top = Math.max(margin, minTop);
  const bottom = viewport.height - margin;
  const clampY = (y: number) => Math.max(top, Math.min(y, bottom - height));
  const besideY = clampY(photo.top + (photo.bottom - photo.top) / 2 - height / 2);
  if (photo.right + margin + width <= viewport.width - margin) return { x: photo.right + margin, y: besideY, flipped: false };
  if (photo.left - margin - width >= margin) return { x: photo.left - margin - width, y: besideY, flipped: true };
  const x = Math.max(margin, Math.min(photo.left + (photo.right - photo.left) / 2 - width / 2, viewport.width - margin - width));
  if (photo.bottom + margin + height <= bottom) return { x, y: photo.bottom + margin, flipped: false };
  if (photo.top - margin - height >= top) return { x, y: photo.top - margin - height, flipped: false };
  const roomBelow = bottom - photo.bottom, roomAbove = photo.top - top;
  return { x, y: roomBelow >= roomAbove ? clampY(photo.bottom + margin) : clampY(photo.top - margin - height), flipped: false };
}
