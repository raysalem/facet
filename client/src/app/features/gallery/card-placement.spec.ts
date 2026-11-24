import { placeCard } from './card-placement';

describe('placeCard', () => {
  const viewport = { width: 1180, height: 880 };
  const box = (left: number, top: number, width = 214, height = 140) => ({ left, top, right: left + width, bottom: top + height });
  const covers = (photo: ReturnType<typeof box>, at: { x: number; y: number }, w: number, h: number) =>
    at.x < photo.right && at.x + w > photo.left && at.y < photo.bottom && at.y + h > photo.top;

  it('goes right of the photo when it fits, left when it does not', () => {
    expect(placeCard(box(16, 125), 395, 416, viewport, 117)).toMatchObject({ x: 246, flipped: false });
    expect(placeCard(box(904, 125), 395, 416, viewport, 117)).toMatchObject({ x: 904 - 16 - 395, flipped: true });
  });

  it('never goes above the toolbar (minTop), nor over the bottom margin', () => {
    const at = placeCard(box(16, 125), 395, 416, viewport, 117);
    expect(at.y).toBeGreaterThanOrEqual(117);
    expect(placeCard(box(16, 700), 395, 416, viewport, 117).y).toBe(880 - 16 - 416);
  });

  it('a card too wide for either side goes below or above the photo, never over it', () => {
    for (const photo of [box(460, 125), box(460, 575), box(400, 300, 380, 200)]) {
      const at = placeCard(photo, 600, 300, viewport, 117);
      expect(covers(photo, at, 600, 300)).toBe(false);
      expect(at.y).toBeGreaterThanOrEqual(117);
    }
  });
});
