import { test, expect, type Locator, type Page } from '../fixtures';
import { expectNoPageScroll, photoUrl, showingPanel, showingTab, signInAsEditor } from '../helpers/nav';

// Ray, 2026-11-24: "this whole hover card is a mess, clicking a few times and now I can't see the side
// display!" (B53, B54). Every click here is a hand's: the pointer travels to coordinates read BEFORE it
// moves, then presses and releases there, with no re-find and no retry. Playwright's own click() re-finds a
// target that moved and retries, which hid the bugs a moving grid causes (B54: a hover opened the panel on
// the way, the grid reflowed and the click fell on the panel).
// B53: a click with Showing open changed nothing; the panel opening rebuilt the clicked card and the card
// that slid under the pointer took the panel over. B54: hover opened (and reopened) the panel; a tooltip
// took the click meant for the control under it; a double click opened another photo; the pinned card sat
// over the toolbar and would not go away.

const PHOTOS = ['IMG_0400.jpg', 'IMG_0500.jpg', 'IMG_0401.jpg', 'IMG_0800.jpg', 'IMG_0900.jpg', 'IMG_0300.jpg', 'IMG_0600.jpg', 'IMG_0801.jpg'];
const LOCATIONS = { panel: 'Side panel', card: 'Card', off: 'Off' } as const;
const MODES = { hover: 'Hover', click: 'Click' } as const;

const photoButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const detailsPanel = (page: Page) => page.locator('[data-details-rail]');
const owner = (page: Page) => detailsPanel(page).locator('[data-inspector-owner]');
const floatingCard = (page: Page) => page.locator('app-photo-tooltip:not([docked]) > div');
const hidePanel = (page: Page) => page.getByRole('button', { name: 'Hide panel' });
const showPanel = (page: Page) => page.getByRole('button', { name: 'Show panel' });

/** mulberry32: the same seed gives the same sequence, so a failure names a sequence that can be replayed. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where a control is now: its centre, read once, before the hand moves. */
async function centre(target: Locator): Promise<{ x: number; y: number }> {
  // The grid can re-render the card between the check and the read (a reload, a panel narrowing it): read again.
  let box: Awaited<ReturnType<Locator['boundingBox']>> = null;
  await expect.poll(async () => {
    await expect(target).toBeVisible();
    box = await target.boundingBox();
    return box !== null;
  }, { message: 'the target has a box on screen' }).toBe(true);
  const { x, y, width, height } = box!;
  return { x: x + width / 2, y: y + height / 2 };
}

/** A hand's click: travel at about hand speed (16 ms per step) to where the target was, press, release. */
async function hand(page: Page, target: Locator, steps = 12): Promise<void> {
  const { x, y } = await centre(target);
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x, y, { steps: 1 });
    if (i < steps) await page.waitForTimeout(16);
  }
  await page.mouse.down();
  await page.mouse.up();
}

/** Travel from a point to a target's centre along a straight line at hand speed, then press and release. */
async function travelAndClick(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 30): Promise<void> {
  await page.mouse.move(from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.down();
  await page.mouse.up();
}

async function setting(page: Page, row: 'Details location' | 'Details mode', choice: string): Promise<void> {
  const display = page.getByRole('button', { name: 'Display', exact: true });
  await hand(page, display);
  const from = await centre(display);
  await travelAndClick(page, from, await centre(page.getByRole('button', { name: new RegExp(`^${row}:`) })), 25);
  await hand(page, page.getByRole('menuitemradio', { name: choice, exact: true }));
  await expect(page.getByRole('menuitemradio')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Display' })).toHaveCount(0);
}

async function freshGallery(page: Page, width: number, query = 'details_place=panel&details_trigger=hover', height = 1100): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  // Display settings live in storage and in the gallery's own URL, which a later visit restores.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(`/?${query}`);
  await expect(photoButton(page, 'IMG_0300.jpg')).toBeVisible();
}

async function expectPanelHolds(page: Page, name: string, context: string): Promise<void> {
  await expect(detailsPanel(page), `${context}: the side panel is on screen`).toBeVisible();
  await expect(owner(page), `${context}: the side panel holds the clicked photo`).toHaveText(name);
}

/** Sweep the pointer across the given photos at hand speed (a hover over each). */
async function sweep(page: Page, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const { x, y } = await centre(photoButton(page, name));
    await page.mouse.move(x, y, { steps: 8 });
    await page.waitForTimeout(80);
  }
}

test('the side panel always shows the photo just clicked, whatever was clicked or changed before', async ({ page }) => {
  test.setTimeout(300_000);
  await freshGallery(page, 1480);

  await test.step('1. A click whose card the opening panel moves away still shows that photo', async () => {
    await hand(page, photoButton(page, 'IMG_0600.jpg'));
    await expectPanelHolds(page, 'IMG_0600.jpg', 'first click');
  });

  await test.step('2. With Showing open (Filters), a click shows the details in its place, also after a reload', async () => {
    await page.keyboard.press('Escape');
    // Escape hides the panel; the toolbar widens with the grid, so let it settle before aiming at Filters.
    await expect(detailsPanel(page)).toHaveCount(0);
    await page.waitForTimeout(400);
    await hand(page, page.getByRole('button', { name: 'Filters', exact: true }));
    await expect(showingPanel(page)).toBeVisible();
    // A hover crossing the grid never takes Showing over.
    await sweep(page, ['IMG_0400.jpg']);
    await expect(showingPanel(page)).toBeVisible();
    await hand(page, photoButton(page, 'IMG_0300.jpg'));
    await expectPanelHolds(page, 'IMG_0300.jpg', 'click with Showing open');
    await hand(page, showingTab(page));
    await page.reload();
    await expect(showingPanel(page)).toBeVisible();
    await hand(page, photoButton(page, 'IMG_0300.jpg'));
    await expectPanelHolds(page, 'IMG_0300.jpg', 'click after a reload with Showing open');
  });

  for (const seed of [3, 5, 9, 12, 21]) {
    await test.step(`3. Seed ${seed}: 30 random settings changes, clicks, hovers, Escape, Hide/Show panel, Filters and reloads`, async () => {
      await freshGallery(page, 1480);
      const next = random(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
      let location: keyof typeof LOCATIONS = 'panel';
      const log: string[] = [];
      for (let step = 0; step < 30; step++) {
        const roll = next();
        if (roll < 0.1) {
          location = pick(Object.keys(LOCATIONS) as (keyof typeof LOCATIONS)[]);
          log.push(`location ${location}`);
          await setting(page, 'Details location', LOCATIONS[location]);
        } else if (roll < 0.18 && location !== 'off') {
          const mode = pick(Object.keys(MODES) as (keyof typeof MODES)[]);
          log.push(`mode ${mode}`);
          await setting(page, 'Details mode', MODES[mode]);
        } else if (roll < 0.25) {
          log.push('Escape');
          await page.keyboard.press('Escape');
        } else if (roll < 0.31) {
          log.push('Hide panel');
          if (await hidePanel(page).isVisible()) await hand(page, hidePanel(page));
        } else if (roll < 0.34) {
          log.push('Show panel');
          if (await showPanel(page).isVisible()) await hand(page, showPanel(page));
        } else if (roll < 0.38) {
          log.push('Filters');
          await hand(page, page.getByRole('button', { name: 'Filters', exact: true }));
        } else if (roll < 0.41) {
          log.push('reload');
          await page.reload();
          await expect(photoButton(page, 'IMG_0300.jpg')).toBeVisible();
        } else if (roll < 0.47) {
          const name = pick(PHOTOS);
          log.push(`hover ${name}`);
          if (location === 'card') await page.keyboard.press('Escape');
          await sweep(page, [name]);
        } else {
          const name = pick(PHOTOS);
          log.push(`click ${name}`);
          // A pinned card may cover the photo; Escape closes it at any time, as a person would.
          if (location === 'card') await page.keyboard.press('Escape');
          await hand(page, photoButton(page, name));
          if (location === 'panel') await expectPanelHolds(page, name, `seed ${seed}, step ${step}: ${log.join(' > ')}`);
        }
      }
    });
  }
});

// B54 fixed scenarios: each fails without its fix.
test.describe('hand clicks on a moving gallery (B54)', () => {
  for (const width of [1180, 1480]) {
    test(`D1/D7 at ${width}: a tooltip never takes the click meant for the control under it`, async ({ page }) => {
      await freshGallery(page, width, undefined, 880);
      await test.step('1. Display, then straight down to Details location at hand speed: the menu opens', async () => {
        const display = page.getByRole('button', { name: 'Display', exact: true });
        await hand(page, display);
        const row = page.getByRole('button', { name: /^Details location:/ });
        await travelAndClick(page, await centre(display), await centre(row), 25);
        await expect(page.getByRole('menuitemradio', { name: 'Side panel', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
      });
      await test.step('2. The Showing tab, then left to Display: Display opens', async () => {
        await hand(page, showingTab(page));
        await expect(showingPanel(page)).toBeVisible();
        const display = page.getByRole('button', { name: 'Display', exact: true });
        await travelAndClick(page, await centre(showingTab(page)), await centre(display), 20);
        await expect(page.getByRole('dialog', { name: 'Display' })).toBeVisible();
      });
    });
  }

  test('D2: in the default Hover mode a hand travelling to a right-hand photo clicks that photo', async ({ page }) => {
    await freshGallery(page, 1180, undefined, 880);
    const cells = await page.getByRole('gridcell').evaluateAll(all => all.map(cell => {
      const button = cell.querySelector('[role=button]')!; const r = button.getBoundingClientRect();
      return { name: button.getAttribute('aria-label')!.split(',')[0], x: r.x + r.width / 2, y: r.y + r.height / 2, right: r.right, top: r.y };
    }).filter(cell => cell.top > 110 && cell.y < innerHeight - 60));
    const right = Math.max(...cells.map(cell => cell.right));
    const target = cells.filter(cell => cell.right > right - 5)[1];
    // From the nav bar, across the grid: before the fix the first photo crossed opened the panel, the grid
    // lost 320 px and the click fell on the panel, naming a photo the hand only crossed.
    await travelAndClick(page, { x: 60, y: 24 }, { x: target.x, y: target.y }, 38);
    await expectPanelHolds(page, target.name, 'hand click on the right-hand column');
    await expect(photoButton(page, target.name)).toHaveAttribute('aria-pressed', 'true');
  });

  test('D8: in Hover mode Hide panel stays hidden while the pointer crosses photos, also after a reload, until a click', async ({ page }) => {
    await freshGallery(page, 1180, undefined, 880);
    await hand(page, photoButton(page, 'IMG_0300.jpg'));
    await expectPanelHolds(page, 'IMG_0300.jpg', 'first click');
    await hand(page, hidePanel(page));
    await expect(detailsPanel(page)).toHaveCount(0);
    await expect(showPanel(page), 'the focus goes to Show panel').toBeFocused();
    await sweep(page, ['IMG_0400.jpg', 'IMG_0500.jpg', 'IMG_0401.jpg']);
    await expect(detailsPanel(page), 'hover does not reopen a hidden panel').toHaveCount(0);
    await page.reload();
    await expect(photoButton(page, 'IMG_0300.jpg')).toBeVisible();
    await sweep(page, ['IMG_0400.jpg', 'IMG_0500.jpg']);
    await expect(detailsPanel(page), 'nor after a reload').toHaveCount(0);
    await hand(page, photoButton(page, 'IMG_0500.jpg'));
    await expectPanelHolds(page, 'IMG_0500.jpg', 'a click opens it again');
    // Hover changes what an open panel shows (the click's photo stays held while it is selected).
    await hand(page, photoButton(page, 'IMG_0500.jpg'));
    await sweep(page, ['IMG_0400.jpg']);
    await expectPanelHolds(page, 'IMG_0400.jpg', 'hover over an open panel');
    // Escape hides it too.
    await page.keyboard.press('Escape');
    await expect(detailsPanel(page)).toHaveCount(0);
  });

  for (const query of ['details_place=panel&details_trigger=click', 'details_place=off', 'details_place=card&details_trigger=hover']) {
    test(`D4 (${query}): a double click opens the photo its first click hit, also in the last row`, async ({ page }) => {
      await freshGallery(page, 1180, query, 880);
      for (const which of ['IMG_0800.jpg', 'last row'] as const) {
        await page.goto(`/?${query}`);
        await expect(photoButton(page, 'IMG_0300.jpg')).toBeVisible();
        // Read where the photos are now (a panel left open is remembered across the reload).
        const read = () => page.getByRole('gridcell').evaluateAll(all => all.map(cell => {
          const button = cell.querySelector('[role=button]')!; const r = button.getBoundingClientRect();
          // Only a photo whose centre is really on screen (not under a notice card or the selection bar).
          const x = r.x + r.width / 2, y = r.y + r.height / 2;
          const onTop = button.contains(document.elementFromPoint(x, y));
          return { name: button.getAttribute('aria-label')!.split(',')[0], x, y, bottom: r.bottom, top: r.y, onTop };
        }).filter(cell => cell.onTop && cell.top > 110 && cell.bottom < innerHeight - 4));
        // The grid may still be laying out right after the reload: wait until it shows a few rows.
        await expect.poll(async () => (await read()).length, { message: 'photos laid out' }).toBeGreaterThan(5);
        const cells = await read();
        const lastRow = Math.max(...cells.map(cell => cell.top));
        const target = which === 'last row' ? cells.filter(cell => cell.top === lastRow).at(-1)! : cells.find(cell => cell.name === which) ?? cells[3];
        await page.mouse.move(target.x, target.y, { steps: 10 });
        await page.mouse.dblclick(target.x, target.y);
        await expect(page, `double click on ${target.name}`).toHaveURL(new RegExp(encodeURIComponent(target.name).replace('.', '\\.')));
      }
    });
  }

  test('D6: the pinned card stays below the toolbar, off its own photo, and closes on a click outside, Escape or Clear', async ({ page }) => {
    await freshGallery(page, 1180, 'details_place=card&details_trigger=hover', 880);
    const header = page.locator('[data-collection-header]').first();
    const pin = async (name: string) => {
      await hand(page, photoButton(page, name));
      await expect(floatingCard(page)).toBeVisible();
      await page.mouse.move(5, 870, { steps: 6 });
    };
    await pin('IMG_0001_agy_1.jpg');
    const headerBottom = (await header.boundingBox())!.y + (await header.boundingBox())!.height;
    expect((await floatingCard(page).boundingBox())!.y, 'the card starts below the toolbar').toBeGreaterThanOrEqual(headerBottom);
    await test.step('1. A click on the page title closes it', async () => {
      await hand(page, page.getByRole('heading', { name: 'All Photos' }));
      await expect(floatingCard(page)).toHaveCount(0);
    });
    await test.step('2. Escape closes it, also once the focus has moved on', async () => {
      await pin('IMG_0001_agy_1.jpg');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Escape');
      await expect(floatingCard(page)).toHaveCount(0);
    });
    await test.step('3. Clear in the selection bar closes it', async () => {
      await pin('IMG_0400.jpg');
      await hand(page, page.getByRole('button', { name: 'Clear', exact: true }));
      await expect(floatingCard(page)).toHaveCount(0);
    });
    await test.step('4. Card + Click: the card never covers its own photo', async () => {
      await setting(page, 'Details mode', 'Click');
      for (const name of ['IMG_0001_agy_1.jpg', 'IMG_0300.jpg', 'IMG_0800.jpg']) {
        await page.keyboard.press('Escape');
        await pin(name);
        const card = (await floatingCard(page).boundingBox())!;
        const photo = (await photoButton(page, name).boundingBox())!;
        const overlaps = card.x < photo.x + photo.width && card.x + card.width > photo.x && card.y < photo.y + photo.height && card.y + card.height > photo.y;
        expect(overlaps, `the card for ${name} covers its photo`).toBe(false);
        expect(card.y, 'below the toolbar').toBeGreaterThanOrEqual(headerBottom);
      }
    });
  });
});

/** The photos on screen now, with the part of each that shows (the bottom row is cut by the window's edge). */
const onScreen = (page: Page) => page.getByRole('gridcell').evaluateAll(all => all.map(cell => {
  const button = cell.querySelector('[role=button]')!; const r = button.getBoundingClientRect();
  const shown = Math.min(r.bottom, innerHeight - 70) - r.y;
  return { name: button.getAttribute('aria-label')!.split(',')[0], x: r.x + r.width / 2, y: r.y + Math.max(8, Math.min(r.height / 2, shown / 2)), top: r.y, bottom: r.bottom };
}).filter(cell => cell.top > 115 && cell.top < innerHeight - 70));
const pressAt = async (page: Page, x: number, y: number) => {
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.down();
  await page.mouse.up();
};


// B55 fixed scenarios: each fails without its fix.
test.describe('round 3 (B55)', () => {
  test('R1: in Hover mode a click holds the panel on its photo while the grid scrolls under the still pointer', async ({ page }) => {
    await freshGallery(page, 1180, undefined, 880);
    await hand(page, photoButton(page, 'IMG_0300.jpg'));
    await expectPanelHolds(page, 'IMG_0300.jpg', 'panel open');
    const cells = await onScreen(page);
    const lowest = Math.max(...cells.map(cell => cell.top));
    const target = cells.filter(cell => cell.top === lowest)[1];
    // First visit selects it; the grid scrolls it clear of the selection bar.
    await pressAt(page, target.x, target.y);
    await expectPanelHolds(page, target.name, 'first visit');
    const moved = (await photoButton(page, target.name).boundingBox())!.y - target.top;
    const other = (await onScreen(page)).find(cell => cell.name !== target.name)!;
    await pressAt(page, other.x, other.y);
    await page.mouse.wheel(0, moved);
    await page.waitForTimeout(800);
    const again = (await onScreen(page)).find(cell => cell.name === target.name)!;
    // The second click deselects it and scrolls the grid again; the photo sliding under the still pointer
    // must not take the panel over.
    await pressAt(page, again.x, again.y);
    await page.waitForTimeout(900);
    await expectPanelHolds(page, target.name, 'clicked again (deselected), grid scrolled under the pointer');
  });

  test('R3: Escape in the filter box of the Showing panel leaves the box, not the panel', async ({ page }) => {
    await freshGallery(page, 1180, undefined, 880);
    await hand(page, showingTab(page));
    const box = showingPanel(page).getByPlaceholder(/Find a filter/);
    await hand(page, box);
    await page.keyboard.type('per');
    await page.keyboard.press('Escape');
    await expect(showingPanel(page)).toBeVisible();
    await expect(box).not.toBeFocused();
    // A second Escape, outside the field, hides the panel as everywhere.
    await page.keyboard.press('Escape');
    await expect(showingPanel(page)).toBeHidden();
  });

  test('C2: a pinned card is placed again when the window narrows, and stays in the grid area', async ({ page }) => {
    await freshGallery(page, 1180, 'details_place=card&details_trigger=click', 880);
    const top = (await onScreen(page)).filter(cell => cell.top < 300).at(-1)!;
    await pressAt(page, top.x, top.y);
    await expect(floatingCard(page)).toBeVisible();
    await page.mouse.move(5, 870, { steps: 4 });
    await page.setViewportSize({ width: 800, height: 880 });
    await expect.poll(async () => {
      const card = (await floatingCard(page).boundingBox())!;
      const grid = (await page.locator('[data-photo-collection], [role="grid"]').first().boundingBox())!;
      return card.x >= 0 && card.x + card.width <= Math.min(800, grid.x + grid.width) + 1;
    }, { message: 'the card inside the window and the grid area' }).toBe(true);
    const card = (await floatingCard(page).boundingBox())!;
    const photo = (await photoButton(page, top.name).boundingBox())!;
    const overlaps = card.x < photo.x + photo.width && card.x + card.width > photo.x && card.y < photo.y + photo.height && card.y + card.height > photo.y;
    expect(overlaps, 'the card covers its own photo').toBe(false);
  });

  test('K1: ten keyboard hide/show pairs in a row, on the gallery and on the photo page', async ({ page }) => {
    await freshGallery(page, 1180, undefined, 880);
    await hand(page, photoButton(page, 'IMG_0300.jpg'));
    await expectPanelHolds(page, 'IMG_0300.jpg', 'panel open');
    await hidePanel(page).focus();
    for (let pair = 1; pair <= 10; pair++) {
      await page.keyboard.press('Enter');
      await expect(detailsPanel(page), `pair ${pair}: hidden`).toHaveCount(0);
      await expect(showPanel(page), `pair ${pair}: focus on Show panel`).toBeFocused();
      await page.keyboard.press('Enter');
      await expectPanelHolds(page, 'IMG_0300.jpg', `pair ${pair}: back`);
      await expect(hidePanel(page), `pair ${pair}: focus on Hide panel`).toBeFocused();
    }
    await page.goto(photoUrl('review', 'IMG_0300.jpg'));
    const inspector = page.locator('[data-photo-inspector]');
    await expect(inspector).toBeVisible();
    await hidePanel(page).focus();
    for (let pair = 1; pair <= 10; pair++) {
      await page.keyboard.press('Enter');
      await expect(inspector, `photo page pair ${pair}: hidden`).toBeHidden();
      await expect(showPanel(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(inspector, `photo page pair ${pair}: back`).toBeVisible();
      await expect(hidePanel(page)).toBeFocused();
    }
  });

  test('E2: one Escape after a click on Show panel hides the panel, with its tooltip up', async ({ page }) => {
    await freshGallery(page, 1180, undefined, 880);
    await hand(page, photoButton(page, 'IMG_0300.jpg'));
    await hand(page, hidePanel(page));
    await hand(page, showPanel(page));
    await expectPanelHolds(page, 'IMG_0300.jpg', 'back');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await expect(detailsPanel(page)).toHaveCount(0);
  });
});

// B55 round 4: each fails without its fix.
test.describe('round 4 (B55)', () => {
  /** The photo whose card is at a point of the screen. */
  const photoAt = (page: Page, x: number, y: number) => page.evaluate(([px, py]) =>
    document.elementFromPoint(px, py)?.closest('[role=gridcell]')?.querySelector('[role=button]')?.getAttribute('aria-label')?.split(',')[0] ?? null, [x, y]);
  /** A photo in the middle of the screen, and a point inside it. */
  const middlePhoto = async (page: Page) => {
    const name = await photoAt(page, 400, 450);
    const box = (await photoButton(page, name!).boundingBox())!;
    return { name: name!, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const cardName = (page: Page) => floatingCard(page).locator('.truncate > span.truncate').first();

  for (const [place, how] of [['card', 'wheel'], ['panel', 'PageDown']] as const) {
    test(`V1c: after a scroll under a still pointer, a small real move shows the photo now under it (${place}, ${how})`, async ({ page }) => {
      await freshGallery(page, 1180, `details_place=${place}&details_trigger=hover`, 880);
      const start = await middlePhoto(page);
      if (place === 'panel') {
        // Click it twice: the panel is open and holds nothing, so it follows the hover.
        await pressAt(page, start.x, start.y);
        await expectPanelHolds(page, start.name, 'opened');
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(700);
      } else {
        await page.mouse.move(start.x, start.y, { steps: 12 });
        await expect(cardName(page)).toHaveText(start.name);
      }
      if (how === 'wheel') await page.mouse.wheel(0, 260);
      else {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('PageDown');
      }
      await page.waitForTimeout(900);
      const now = await photoAt(page, start.x, start.y);
      expect(now, 'another photo under the pointer after the scroll').not.toBe(start.name);
      // The hand moves 6 px, staying inside that photo.
      await page.mouse.move(start.x + 5, start.y + 3, { steps: 6 });
      expect(await photoAt(page, start.x + 5, start.y + 3)).toBe(now);
      if (place === 'panel') await expect(owner(page), 'the panel names the photo under the pointer').toHaveText(now!);
      else await expect(cardName(page), 'the card names the photo under the pointer').toHaveText(now!);
    });
  }

  test('N1: a pinned card with no room for all of it is made smaller, never cut, and shows the file name', async ({ page }) => {
    await freshGallery(page, 800, 'details_place=card&details_trigger=click', 900);
    const cells = (await onScreen(page)).filter(cell => cell.bottom < 880);
    for (const cell of cells) {
      await pressAt(page, cell.x, cell.y);
      await expect(floatingCard(page)).toBeVisible();
      await page.waitForTimeout(250);
      const cut = await floatingCard(page).evaluate(el => el.scrollHeight - el.clientHeight);
      expect(cut, `${cell.name}: the card is cut by ${cut} px`).toBeLessThanOrEqual(2);
      await expect(cardName(page), `${cell.name}: the file name shows`).toBeInViewport({ ratio: 1 });
      await pressAt(page, cell.x, cell.y);
      await expect(floatingCard(page)).toHaveCount(0);
    }
  });

  test('a click shows the card in a narrow window with a mouse (640 to 767 px)', async ({ page }) => {
    for (const width of [640, 700, 767]) {
      await freshGallery(page, width, 'details_place=card&details_trigger=click', 880);
      const cell = (await onScreen(page))[0];
      await pressAt(page, cell.x, cell.y);
      await expect(cardName(page), `${width} px`).toHaveText(cell.name);
    }
  });
});

// B57 (round 5): each fails without its fix.
test.describe('round 5 (B57)', () => {
  /** The pinned card's box, sampled every 50 ms for 3 s with nothing touched: every distinct box seen. */
  const boxesWhileStill = async (page: Page) => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const box = await floatingCard(page).boundingBox();
      seen.add(box ? [box.x, box.y, box.width, box.height].map(Math.round).join(',') : 'none');
      await page.waitForTimeout(50);
    }
    return [...seen];
  };

  for (const [width, showing] of [[640, false], [1180, true]] as const) {
    test(`K1: a pinned card does not change while nothing moves (${width} px, ${showing ? 'Showing open' : 'no panel'})`, async ({ page }) => {
      // Every photo on screen, about 4.5 s each.
      test.setTimeout(180_000);
      await freshGallery(page, width, 'details_place=card&details_trigger=click', 880);
      if (showing) {
        await hand(page, page.getByRole('button', { name: 'Filters', exact: true }));
        await expect(showingPanel(page)).toBeVisible();
      }
      const cells = (await onScreen(page)).filter(cell => cell.bottom < 860);
      for (const cell of cells) {
        await page.keyboard.press('Escape');
        if (showing && !(await showingPanel(page).isVisible())) await hand(page, page.getByRole('button', { name: 'Filters', exact: true }));
        await pressAt(page, cell.x, cell.y);
        if (!(await floatingCard(page).isVisible())) continue;
        await page.mouse.move(2, 870, { steps: 4 });
        await page.waitForTimeout(600);
        const boxes = await boxesWhileStill(page);
        expect(boxes, `${cell.name}: the card's box over 3 s`).toHaveLength(1);
      }
    });
  }

  test('K2: Card and Hover in a 700 px window with a mouse: a hover shows the card, a click pins it', async ({ page }) => {
    await freshGallery(page, 700, 'details_place=card&details_trigger=hover', 880);
    const [first, second] = await onScreen(page);
    await page.mouse.move(first.x, first.y, { steps: 12 });
    await expect(floatingCard(page).locator('.truncate > span.truncate').first(), 'hover').toHaveText(first.name);
    await pressAt(page, second.x, second.y);
    await expect(floatingCard(page).locator('.truncate > span.truncate').first(), 'click').toHaveText(second.name);
  });
});

test('every side panel hides to the rail with one click and comes back with one, remembered', async ({ page }) => {
  await freshGallery(page, 1180);

  await test.step('1. Showing hides to the rail; Show panel brings it back', async () => {
    await hand(page, showingTab(page));
    await expect(showingPanel(page)).toBeVisible();
    await hand(page, hidePanel(page));
    await expect(showingPanel(page)).toBeHidden();
    await expect(showPanel(page)).toBeVisible();
    await hand(page, showPanel(page));
    await expect(showingPanel(page)).toBeVisible();
  });

  await test.step('2. The photo details panel hides and comes back on the same photo; a reload keeps it hidden', async () => {
    await hand(page, photoButton(page, 'IMG_0300.jpg'));
    await expectPanelHolds(page, 'IMG_0300.jpg', 'details panel');
    await hand(page, hidePanel(page));
    await expect(detailsPanel(page)).toHaveCount(0);
    await hand(page, showPanel(page));
    await expectPanelHolds(page, 'IMG_0300.jpg', 'details panel back');
    await hand(page, hidePanel(page));
    await page.reload();
    await expect(photoButton(page, 'IMG_0300.jpg')).toBeVisible();
    await expect(detailsPanel(page)).toHaveCount(0);
    await expect(showPanel(page)).toBeVisible();
  });

  await test.step('3. Open across a reload, the details panel comes back on the photo it showed', async () => {
    await hand(page, showPanel(page));
    await expectPanelHolds(page, 'IMG_0300.jpg', 'Show panel after a reload');
    await page.reload();
    await expectPanelHolds(page, 'IMG_0300.jpg', 'open across a reload');
  });

  await test.step('4. Narrowing below 640 and back keeps it open on its photo', async () => {
    await page.setViewportSize({ width: 600, height: 1100 });
    await expect(detailsPanel(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1180, height: 1100 });
    await expectPanelHolds(page, 'IMG_0300.jpg', 'back from a narrow window');
  });

  await test.step('5. The photo page inspector hides and comes back', async () => {
    await page.goto(photoUrl('review', 'IMG_0300.jpg'));
    const inspector = page.locator('[data-photo-inspector]');
    await expect(inspector).toBeVisible();
    await hand(page, hidePanel(page));
    await expect(inspector).toBeHidden();
    await expect(showPanel(page), 'the focus goes to Show panel').toBeFocused();
    await hand(page, showPanel(page));
    await expect(inspector).toBeVisible();
  });
});

/** The panel sits beside the content (its left edge at or right of the content's right edge), never below it. */
async function expectBeside(content: Locator, panel: Locator, label: string): Promise<void> {
  const c = (await content.boundingBox())!;
  const p = (await panel.boundingBox())!;
  expect(p.x, `${label}: the panel starts right of the content`).toBeGreaterThanOrEqual(c.x + c.width - 1);
  expect(p.y, `${label}: the panel starts at the content's top, not under it`).toBeLessThan(c.y + c.height / 2);
}

async function expectNoPageScrollbar(page: Page, label: string): Promise<void> {
  await expectNoPageScroll(page, label);
  const over = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(over, `${label}: vertical page scroll (px)`).toBeLessThanOrEqual(1);
}

for (const width of [640, 800, 1024, 1180, 1480, 2950]) {
  test(`at ${width} px the panels sit at the side, never below the content, with no page scrollbar`, async ({ page }) => {
    await freshGallery(page, width);
    await page.setViewportSize({ width, height: 900 });

    await test.step('1. Gallery: the details panel beside the grid, its handle announcing the width on screen', async () => {
      await hand(page, photoButton(page, 'IMG_0300.jpg'));
      await expectPanelHolds(page, 'IMG_0300.jpg', `gallery at ${width}`);
      await expectBeside(page.locator('[data-photo-collection], [role="grid"]').first(), detailsPanel(page), `details at ${width}`);
      await expectNoPageScrollbar(page, `gallery details at ${width}`);
      const shown = Math.round((await detailsPanel(page).boundingBox())!.width);
      await expect.poll(async () => Number(await detailsPanel(page).getByRole('separator').getAttribute('aria-valuenow'))).toBe(shown);
    });

    await test.step('2. Gallery: Showing beside the grid', async () => {
      await hand(page, showingTab(page));
      await expectBeside(page.locator('[data-photo-collection], [role="grid"]').first(), showingPanel(page), `Showing at ${width}`);
      await expectNoPageScrollbar(page, `gallery Showing at ${width}`);
    });

    await test.step('3. Photo page: the inspector beside the photo', async () => {
      await page.goto(photoUrl('review', 'IMG_0300.jpg'));
      const inspector = page.locator('[data-photo-inspector]');
      await expect(inspector).toBeVisible();
      await expectBeside(page.locator('[data-photo-canvas]'), inspector, `inspector at ${width}`);
      await expectNoPageScrollbar(page, `photo page at ${width}`);
    });
  });
}

test('a phone keeps the bottom sheet by default, and Panel on phone: Side puts the panels at the side', async ({ page }) => {
  await signInAsEditor(page);
  await freshGallery(page, 390, undefined, 844);
  const rail = page.getByRole('tablist', { name: 'Gallery panels' });

  await test.step('1. Bottom sheet: no rail; Display offers Panel on phone', async () => {
    await expect(rail).toHaveCount(0);
    await hand(page, page.getByRole('button', { name: 'Display', exact: true }));
    await expect(page.getByRole('button', { name: 'Panel on phone: Bottom sheet' })).toBeVisible();
  });

  await test.step('2. Side: the rail and the details panel sit beside the grid, nothing scrolls sideways', async () => {
    await hand(page, page.getByRole('button', { name: /^Panel on phone:/ }));
    await hand(page, page.getByRole('menuitemradio', { name: 'Side', exact: true }));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(rail).toBeVisible();
    await hand(page, photoButton(page, 'IMG_0300.jpg'));
    await expectPanelHolds(page, 'IMG_0300.jpg', 'phone side');
    await expectBeside(page.locator('[data-photo-collection], [role="grid"]').first(), detailsPanel(page), 'phone side');
    await expectNoPageScroll(page, 'phone side');
  });

  await test.step('3. Side: Showing comes back after a reload (D10)', async () => {
    await hand(page, showingTab(page));
    await expect(showingPanel(page)).toBeVisible();
    await page.reload();
    await expect(showingPanel(page)).toBeVisible();
  });

  await test.step('4. Side, photo page: the inspector header fits, Hide panel inside the screen (D9)', async () => {
    await page.goto(photoUrl('review', 'IMG_0300.jpg'));
    const inspector = page.locator('[data-photo-inspector]');
    await expect(inspector).toBeVisible();
    const hide = (await hidePanel(page).boundingBox())!;
    expect(hide.x + hide.width, 'Hide panel ends inside the screen').toBeLessThanOrEqual(390);
    await expect(inspector.locator('[data-panel-header] h2')).toBeVisible();
    await hand(page, hidePanel(page));
    await expect(inspector).toBeHidden();
    await expectNoPageScroll(page, 'phone side photo page');
  });

  await test.step('5. The add-on dock is still a drawer over the page at 390 (#391)', async () => {
    await page.evaluate(() => localStorage.setItem('facet_phone_panel', 'sheet'));
    await page.reload();
    await hand(page, page.getByRole('button', { name: 'E2E Add-on' }));
    const dock = page.locator('#addon-dock');
    await expect(dock.getByRole('heading', { name: 'E2E Add-on', level: 2 })).toBeVisible();
    const box = (await dock.boundingBox())!;
    expect(box.width, 'the drawer leaves a strip of the page in view').toBeLessThanOrEqual(390 - 40);
    expect(await dock.evaluate(el => getComputedStyle(el).position)).toBe('absolute');
    await expectNoPageScroll(page, 'add-on drawer at 390');
  });
});
