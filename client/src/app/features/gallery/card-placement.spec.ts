import { fullCardSize, placeCard } from './card-placement';

describe('placeCard', () => {
  // The grid's part of a 1180 x 880 window: below the toolbar (117), left of a 364 px rail and panel, above a
  // selection bar at 800.
  const area = { left: 0, top: 117, right: 816, bottom: 800 };
  const box = (left: number, top: number, width = 214, height = 140) => ({ left, top, right: left + width, bottom: top + height });
  const covers = (photo: ReturnType<typeof box>, at: { x: number; y: number }, w: number, h: number) =>
    at.x < photo.right && at.x + w > photo.left && at.y < photo.bottom && at.y + h > photo.top;
  const inside = (at: { x: number; y: number }, w: number, h: number) =>
    at.x >= area.left && at.x + w <= area.right && at.y >= area.top && at.y + h <= area.bottom;

  it('goes right of the photo when it fits, left when it does not', () => {
    expect(placeCard(box(16, 125), 395, 416, area)).toMatchObject({ x: 246, flipped: false });
    expect(placeCard(box(586, 125), 395, 416, area)).toMatchObject({ x: 586 - 16 - 395, flipped: true });
  });

  it('stays inside the grid area: below the toolbar, left of the rail and panel, above the selection bar', () => {
    for (const photo of [box(16, 125), box(586, 125), box(16, 650), box(586, 650), box(300, 400)]) {
      const at = placeCard(photo, 395, 416, area);
      expect(inside(at, 395, 416)).toBe(true);
    }
  });

  it('a card too wide for either side goes below or above the photo, never over it', () => {
    for (const photo of [box(300, 125), box(300, 575), box(250, 300, 300, 120)]) {
      const at = placeCard(photo, 600, 250, area);
      expect(covers(photo, at, 600, 250)).toBe(false);
      expect(inside(at, 600, 250)).toBe(true);
    }
  });

  it('its height cap never lets a taller card cover its photo or leave the area', () => {
    for (const photo of [box(16, 125), box(586, 125), box(300, 125), box(300, 575), box(300, 400)]) {
      const at = placeCard(photo, 600, 250, area);
      // A card as tall as its cap still keeps off its photo and inside the area.
      expect(covers(photo, at, 600, at.maxHeight)).toBe(false);
      expect(at.y + at.maxHeight).toBeLessThanOrEqual(area.bottom);
    }
  });

  it('is a pure function of the window: the same inputs give the same place (K3)', () => {
    const photo = box(300, 400);
    expect(placeCard(photo, 395, 416, area)).toEqual(placeCard(photo, 395, 416, area));
    expect(fullCardSize(true, 1.5, 880, 800)).toEqual(fullCardSize(true, 1.5, 880, 800));
    expect(fullCardSize(true, 1.5, 880, 200).width).toBe(200);
  });
});
