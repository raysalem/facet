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
/** The floating card's width, height cap and form, decided with its place and handed to the card. */
export interface CardFrame {
  width: number;
  maxHeight: number;
  /** No room for the whole card: the name and key facts, no picture. */
  compact: boolean;
}

/** The compact card's size: the name and date, category and score, stars, key scores and the EXIF line. */
export const COMPACT_CARD = { width: 272, height: 230 } as const;

/**
 * The size the whole card needs at this window height: a landscape photo's picture above the facts, a portrait
 * one's beside them. A fixed function of the photo's shape and the window, never of the rendered card.
 */
export function fullCardSize(landscape: boolean, aspect: number, windowHeight: number, maxWidth: number): { width: number; height: number } {
  const naturalHeight = aspect > 1 ? 640 / aspect : 640;
  if (landscape) {
    const imageHeight = Math.min(naturalHeight, windowHeight * 0.35);
    // 260 = scores (~160) + EXIF line (~60) + tags (~40)
    return { width: Math.min(maxWidth, Math.ceil(imageHeight * aspect) + 24), height: Math.ceil(imageHeight) + 260 };
  }
  const imageHeight = Math.min(naturalHeight, windowHeight * 0.5);
  // 260 + 12 + 24: the facts column beside the picture, the gap and the padding; 100 = EXIF line + tags
  return { width: Math.min(maxWidth, Math.ceil(imageHeight * aspect) + 296), height: Math.max(Math.ceil(imageHeight), 300) + 100 };
}

export function placeCard(photo: PlacementBox, width: number, height: number, area: PlacementBox, margin = 16): CardPlacement {
  const left = area.left + margin, right = area.right - margin, top = area.top, bottom = area.bottom - margin;
  const clampX = (x: number) => Math.max(left, Math.min(x, right - width));
  const besideHeight = Math.max(0, bottom - top);
  const besideY = Math.max(top, Math.min(photo.top + (photo.bottom - photo.top) / 2 - height / 2, bottom - height));
  // maxHeight is the room from the card's top to the edge it must not cross (the area's bottom, or its photo
  // when it sits above it), so a card that turns out taller than `height` still never covers either.
  const besideMax = Math.min(besideHeight, bottom - besideY);
  if (photo.right + margin + width <= right) return { x: photo.right + margin, y: besideY, flipped: false, maxHeight: besideMax };
  if (photo.left - margin - width >= left) return { x: photo.left - margin - width, y: besideY, flipped: true, maxHeight: besideMax };
  const x = clampX(photo.left + (photo.right - photo.left) / 2 - width / 2);
  const roomBelow = Math.max(0, bottom - (photo.bottom + margin));
  const roomAbove = Math.max(0, photo.top - margin - top);
  if (height <= roomBelow) return { x, y: photo.bottom + margin, flipped: false, maxHeight: roomBelow };
  if (height <= roomAbove) return { x, y: photo.top - margin - height, flipped: false, maxHeight: height };
  return roomBelow >= roomAbove
    ? { x, y: photo.bottom + margin, flipped: false, maxHeight: roomBelow }
    : { x, y: top, flipped: false, maxHeight: roomAbove };
}
