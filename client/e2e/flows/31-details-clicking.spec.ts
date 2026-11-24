import { test, expect, type Locator, type Page } from '../fixtures';
import { expectNoPageScroll, photoUrl, showingPanel, showingTab, signInAsEditor } from '../helpers/nav';

// Ray, 2026-11-24: "this whole hover card is a mess, clicking a few times and now I can't see the side
// display!" Two causes, both older than the details split (they reproduce on its parent, bfb76d12c):
//  - a click with Showing open (opened by Filters, the Showing tab, or restored on reload) changed nothing:
//    a photo never took the place of an open panel, so the details panel seemed gone for good;
//  - the details panel opening narrows the grid, the virtual rows are rebuilt and the clicked card destroyed
//    under the focus; that blur cleared the cursor, and the card that slid under the pointer took the panel
//    over by hover: the clicked photo was never the one shown.
// The first test clicks the way Ray does, a seeded random mix of setting changes, clicks on the same and
// other photos, hovers, Escape, Hide panel / Show panel, Filters and reloads, and after every click with
// the side panel on asserts the panel is on screen and holds the clicked photo.

const PHOTOS = ['IMG_0400.jpg', 'IMG_0500.jpg', 'IMG_0401.jpg', 'IMG_0800.jpg', 'IMG_0900.jpg', 'IMG_0300.jpg', 'IMG_0600.jpg', 'IMG_0801.jpg'];
const LOCATIONS = { panel: 'Side panel', card: 'Card', off: 'Off' } as const;
const MODES = { hover: 'Hover', click: 'Click' } as const;

const photoButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const detailsPanel = (page: Page) => page.locator('[data-details-rail]');
const owner = (page: Page) => detailsPanel(page).locator('[data-inspector-owner]');

/** mulberry32: the same seed gives the same sequence, so a failure names a sequence that can be replayed. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Move the pointer onto a control first, as a hand does: a tooltip left open by the last control pointed at
 *  (the rail's Show panel, beside Display) closes once the pointer leaves it. */
async function clickByHand(page: Page, target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  // The grid may rebuild the card while the pointer travels (a panel opening reflows it): click() re-finds it.
  const box = await target.boundingBox().catch(() => null);
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await target.click();
}

async function setting(page: Page, row: 'Details location' | 'Details mode', choice: string): Promise<void> {
  await clickByHand(page, page.getByRole('button', { name: 'Display' }));
  await page.getByRole('button', { name: new RegExp(`^${row}:`) }).click();
  await page.getByRole('menuitemradio', { name: choice, exact: true }).click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitemradio')).toHaveCount(0);
}

async function freshGallery(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 1100 });
  await page.goto('/');
  // Display settings live in storage and in the gallery's own URL, which a later visit restores.
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto('/?details_place=panel&details_trigger=hover');
  await expect(photoButton(page, 'IMG_0300.jpg')).toBeVisible();
}

async function expectPanelHolds(page: Page, name: string, context: string): Promise<void> {
  await expect(detailsPanel(page), `${context}: the side panel is on screen`).toBeVisible();
  await expect(owner(page), `${context}: the side panel holds the clicked photo`).toHaveText(name);
}

test('the side panel always shows the photo just clicked, whatever was clicked or changed before', async ({ page }) => {
  test.setTimeout(300_000);
  await freshGallery(page, 1480);

  await test.step('1. A click whose card the opening panel moves away still shows that photo', async () => {
    await photoButton(page, 'IMG_0600.jpg').click();
    await expectPanelHolds(page, 'IMG_0600.jpg', 'first click');
  });

  await test.step('2. With Showing open (Filters), a click shows the details in its place, also after a reload', async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await expect(showingPanel(page)).toBeVisible();
    // A hover crossing the grid never takes Showing over.
    await photoButton(page, 'IMG_0400.jpg').hover();
    await expect(showingPanel(page)).toBeVisible();
    await photoButton(page, 'IMG_0300.jpg').click();
    await expectPanelHolds(page, 'IMG_0300.jpg', 'click with Showing open');
    await showingTab(page).click();
    await page.reload();
    await expect(showingPanel(page)).toBeVisible();
    await photoButton(page, 'IMG_0300.jpg').click();
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
          const hide = page.getByRole('button', { name: 'Hide panel' });
          if (await hide.isVisible()) await hide.click();
        } else if (roll < 0.34) {
          log.push('Show panel');
          const show = page.getByRole('button', { name: 'Show panel' });
          if (await show.isVisible()) await show.click();
        } else if (roll < 0.38) {
          log.push('Filters');
          await clickByHand(page, page.getByRole('button', { name: 'Filters', exact: true }));
        } else if (roll < 0.41) {
          log.push('reload');
          await page.reload();
          await expect(photoButton(page, 'IMG_0300.jpg')).toBeVisible();
        } else if (roll < 0.47) {
          const name = pick(PHOTOS);
          log.push(`hover ${name}`);
          // A pinned card may cover a photo, as it does for a person: point at what is on top there.
          await photoButton(page, name).hover({ force: true });
        } else {
          const name = pick(PHOTOS);
          log.push(`click ${name}`);
          // A pinned card may cover the photo; a person would click the card away first, as Escape does.
          if (location === 'card') await page.keyboard.press('Escape');
          await clickByHand(page, photoButton(page, name));
          if (location === 'panel') await expectPanelHolds(page, name, `seed ${seed}, step ${step}: ${log.join(' > ')}`);
        }
      }
    });
  }
});

/** The collapse control of whichever panel is open, and the rail's way back. */
const hidePanel = (page: Page) => page.getByRole('button', { name: 'Hide panel' });
const showPanel = (page: Page) => page.getByRole('button', { name: 'Show panel' });

test('every side panel hides to the rail with one click and comes back with one, remembered', async ({ page }) => {
  await freshGallery(page, 1180);

  await test.step('1. Showing hides to the rail; Show panel brings it back', async () => {
    await showingTab(page).click();
    await expect(showingPanel(page)).toBeVisible();
    await hidePanel(page).click();
    await expect(showingPanel(page)).toBeHidden();
    await expect(showPanel(page)).toBeVisible();
    await showPanel(page).click();
    await expect(showingPanel(page)).toBeVisible();
  });

  await test.step('2. The photo details panel hides and comes back on the same photo; a reload keeps it hidden', async () => {
    await photoButton(page, 'IMG_0300.jpg').click();
    await expectPanelHolds(page, 'IMG_0300.jpg', 'details panel');
    await hidePanel(page).click();
    await expect(detailsPanel(page)).toHaveCount(0);
    await showPanel(page).click();
    await expectPanelHolds(page, 'IMG_0300.jpg', 'details panel back');
    await hidePanel(page).click();
    await page.reload();
    await expect(photoButton(page, 'IMG_0300.jpg')).toBeVisible();
    await expect(detailsPanel(page)).toHaveCount(0);
    await expect(showPanel(page)).toBeVisible();
  });

  await test.step('3. The photo page inspector hides and comes back', async () => {
    await page.goto(photoUrl('review', 'IMG_0300.jpg'));
    const inspector = page.locator('[data-photo-inspector]');
    await expect(inspector).toBeVisible();
    await hidePanel(page).click();
    await expect(inspector).toBeHidden();
    await showPanel(page).click();
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

    await test.step('1. Gallery: the details panel beside the grid', async () => {
      await photoButton(page, 'IMG_0300.jpg').click();
      await expectPanelHolds(page, 'IMG_0300.jpg', `gallery at ${width}`);
      await expectBeside(page.locator('[data-photo-collection], [role="grid"]').first(), detailsPanel(page), `details at ${width}`);
      await expectNoPageScrollbar(page, `gallery details at ${width}`);
    });

    await test.step('2. Gallery: Showing beside the grid', async () => {
      await showingTab(page).click();
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
  await freshGallery(page, 390);
  await page.setViewportSize({ width: 390, height: 844 });
  const rail = page.getByRole('tablist', { name: 'Gallery panels' });

  await test.step('1. Bottom sheet: no rail; Display offers Panel on phone', async () => {
    await expect(rail).toHaveCount(0);
    await page.getByRole('button', { name: 'Display' }).click();
    await expect(page.getByRole('button', { name: 'Panel on phone: Bottom sheet' })).toBeVisible();
  });

  await test.step('2. Side: the rail and the details panel sit beside the grid, nothing scrolls sideways', async () => {
    await page.getByRole('button', { name: /^Panel on phone:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Side', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(rail).toBeVisible();
    await photoButton(page, 'IMG_0300.jpg').click();
    await expectPanelHolds(page, 'IMG_0300.jpg', 'phone side');
    await expectBeside(page.locator('[data-photo-collection], [role="grid"]').first(), detailsPanel(page), 'phone side');
    await expectNoPageScroll(page, 'phone side');
  });

  await test.step('3. The add-on dock is still a drawer over the page at 390 (#391)', async () => {
    await page.evaluate(() => localStorage.setItem('facet_phone_panel', 'sheet'));
    await page.reload();
    await expect(rail).toHaveCount(0);
    await page.goto(photoUrl('review', 'IMG_0300.jpg'));
    await page.getByRole('button', { name: 'E2E Add-on' }).click();
    const dock = page.locator('#addon-dock');
    await expect(dock.getByRole('heading', { name: 'E2E Add-on', level: 2 })).toBeVisible();
    const box = (await dock.boundingBox())!;
    expect(box.width, 'the drawer leaves a strip of the page in view').toBeLessThanOrEqual(390 - 40);
    expect(await dock.evaluate(el => getComputedStyle(el).position)).toBe('absolute');
    await expectNoPageScroll(page, 'add-on drawer at 390');
  });
});
