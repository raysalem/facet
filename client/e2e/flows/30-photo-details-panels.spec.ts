import { test, expect, type Locator, type Page } from '../fixtures';
import { openShowing, photoUrl, showingPanel, showingTab } from '../helpers/nav';

// Photo details are two independent settings, Details location (where) and Details mode (how), and the
// gallery's two side panels and the photo page's inspector are resized by dragging their inner edge.

const card = (page: Page) => page.locator('app-photo-tooltip > div').first();
const photo = (page: Page) => page.getByRole('button', { name: 'IMG_0300.jpg', exact: true });
const width = async (locator: Locator) => Math.round((await locator.boundingBox())!.width);

/** Drag a resize handle's grip horizontally by `dx` pixels (negative = left, which widens a right-side panel). */
async function dragHandle(page: Page, handle: Locator, dx: number): Promise<void> {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test('a setting saved before the split keeps its behaviour, shown as Details location + Details mode', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });

  await test.step('1. A browser that saved the old Click tooltip reloads the gallery', async () => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('facet_display_options', JSON.stringify({ tooltip_mode: 'click' })));
    await page.reload();
    await expect(photo(page)).toBeVisible();
  });

  await test.step('2. Display shows it as Details location: Card, Details mode: Click', async () => {
    await page.getByRole('button', { name: 'Display' }).click();
    await expect(page.getByRole('button', { name: 'Details location: Card' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Details mode: Click' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  await test.step('3. Hovering a photo opens nothing; clicking it opens the card, Escape closes it', async () => {
    await photo(page).hover();
    await expect(card(page)).toBeHidden();
    await photo(page).click();
    await expect(card(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card(page)).toBeHidden();
  });

  await test.step('4. Off hides Details mode; the saved mode comes back with a location', async () => {
    await page.getByRole('button', { name: 'Display' }).click();
    await page.getByRole('button', { name: /^Details location:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Off', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Details mode:/ })).toHaveCount(0);
    await page.getByRole('button', { name: /^Details location:/ }).click();
    await expect(page.getByRole('menuitemradio')).toHaveText([/Side panel/, /Card/, /Off/]);
    await page.getByRole('menuitemradio', { name: 'Side panel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Details mode: Click' })).toBeVisible();
    await page.getByRole('button', { name: /^Details mode:/ }).click();
    // Two modes: Hover or click is gone (a saved one reads as Hover).
    await expect(page.getByRole('menuitemradio')).toHaveText([/Hover/, /Click/]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('facet_display_options') ?? '{}'));
    expect(saved).toMatchObject({ details_place: 'panel', details_trigger: 'click' });
    expect(saved).not.toHaveProperty('tooltip_mode');
  });
});

test('the Showing and photo details panels widen by dragging their inner edge, and keep the width', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.removeItem('facet_gallery_showing_width');
    localStorage.removeItem('facet_gallery_details_width');
    localStorage.removeItem('facet_display_options');
    localStorage.removeItem('facet_gallery_rail_tab');
  });
  await page.reload();

  await test.step('1. The Showing panel starts at 320 px with a visible handle on its left edge', async () => {
    await openShowing(page);
    expect(await width(showingPanel(page))).toBe(320);
    const handle = showingPanel(page).getByRole('separator', { name: 'Resize the Showing panel' });
    await expect(handle).toBeVisible();
    await expect(handle).toHaveCSS('cursor', 'col-resize');
  });

  await test.step('2. Dragging the handle 120 px left widens it to 440 px, and a reload keeps it', async () => {
    await dragHandle(page, showingPanel(page).getByRole('separator'), -120);
    expect(await width(showingPanel(page))).toBe(440);
    await page.reload();
    // The rail remembers Showing was open.
    await expect(showingTab(page)).toHaveAttribute('aria-selected', 'true');
    await expect(showingPanel(page)).toBeVisible();
    expect(await width(showingPanel(page))).toBe(440);
  });

  await test.step('3. The arrow keys move it too', async () => {
    const handle = showingPanel(page).getByRole('separator');
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    expect(await width(showingPanel(page))).toBe(456);
    await expect(handle).toHaveAttribute('aria-valuenow', '456');
  });

  await test.step('4. The photo details panel (Side panel, the default) has its own handle and width', async () => {
    // A click on a photo shows its details in place of Showing (a hover would not).
    await photo(page).click();
    await expect(showingTab(page)).toHaveAttribute('aria-selected', 'false');
    const rail = page.locator('[data-details-rail]');
    await expect(rail).toBeVisible();
    expect(await width(rail)).toBe(320);
    await dragHandle(page, rail.getByRole('separator', { name: 'Resize photo details panel' }), -80);
    expect(await width(rail)).toBe(400);
    expect(await page.evaluate(() => localStorage.getItem('facet_gallery_details_width'))).toBe('400');
  });
});

test('the photo page inspector shows a draggable edge and resizes with it', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(photoUrl('review', 'IMG_0300.jpg'));
  await page.evaluate(() => localStorage.removeItem('facet_photo_inspector_width'));
  await page.reload();
  const inspector = page.locator('[data-photo-inspector]');
  const handle = page.getByRole('separator', { name: 'Resize photo details panel' });

  await test.step('1. The handle is visible, with a resize cursor and a how-to tooltip', async () => {
    await expect(inspector).toBeVisible();
    await expect(handle).toBeVisible();
    await expect(handle).toHaveCSS('cursor', 'col-resize');
    await expect(handle).toHaveAttribute('title', /Drag to resize/);
    expect(await width(inspector)).toBe(320);
  });

  await test.step('2. Dragging it 100 px left widens the inspector to 420 px', async () => {
    await dragHandle(page, handle, -100);
    expect(await width(inspector)).toBe(420);
    expect(await page.evaluate(() => localStorage.getItem('facet_photo_inspector_width'))).toBe('420');
  });
});
