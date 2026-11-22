import { test, expect, type Page } from '../fixtures';
import { expectCleanUI } from '../helpers/ui-probe.helpers';
import { openAlbum, photoUrl, recordContentWidth, useTheme, WIDTHS } from '../helpers/nav';

// Geometry, not class names: the unit specs for B44 (three scrollbars in an album) and B38/B43
// (a 1397 px hover card whose tags wrapped over many lines) pin Tailwind classes, so a parent or
// utility change could bring either bug back unseen. These checks measure the rendered page.

/** Every element that scrolls vertically right now, the document's own scroller included, named
 *  by what it holds: the photo grid, the open rail panel, or anything else. */
function scrollers(page: Page): Promise<{ kind: 'grid' | 'panel' | 'other'; what: string }[]> {
  return page.evaluate(() => {
    const found: { kind: 'grid' | 'panel' | 'other'; what: string }[] = [];
    const doc = document.scrollingElement!;
    const canScroll = (el: Element) => /auto|scroll/.test(getComputedStyle(el).overflowY);
    // The grid's own scroller is its nearest scrollable ancestor; an outer one (the shell's <main>,
    // B44's third bar) also holds the grid but is a stray.
    let gridScroller = document.querySelector('[role="grid"]')?.parentElement ?? null;
    while (gridScroller && !canScroll(gridScroller)) gridScroller = gridScroller.parentElement;
    for (const el of [doc, ...Array.from(document.querySelectorAll<HTMLElement>('body *'))]) {
      if (!(el === doc || canScroll(el)) || el.scrollHeight <= el.clientHeight + 1) continue;
      const kind = el === gridScroller ? 'grid' : el !== doc && el.closest('[role="tabpanel"]') ? 'panel' : 'other';
      const label = el === doc ? 'document' : `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`;
      found.push({ kind, what: `${label} ${el.scrollHeight}/${el.clientHeight}` });
    }
    return found;
  });
}

async function openLayoutAlbum(page: Page): Promise<void> {
  // The Albums link joins the nav once the app's startup config is in; entering a gallery before
  // that can leave an empty grid (a separate startup race, not this flow's subject).
  await page.goto('/albums');
  await page.getByRole('navigation', { name: 'Navigation' }).getByRole('link', { name: /Albums$/ }).click();
  await page.getByRole('link', { name: /E2E Layout/ }).click();
  await expect(page.getByRole('heading', { name: 'E2E Layout', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'LAY_001.jpg' })).toBeVisible();
}

for (const width of [1280, 1600]) {
  test(`album page with Showing open at ${width} px: one scroller per pane`, async ({ page }) => {
    // 720 px high: the Showing panel's list overflows, the condition under which an escaped
    // absolutely placed label stretched <main> into a third scrollbar (B44).
    await page.setViewportSize({ width, height: 720 });

    await test.step('1. Open the 80-photo album and the Showing panel', async () => {
      await openLayoutAlbum(page);
      const showing = page.getByRole('tablist', { name: 'Gallery panels' }).getByRole('tab', { name: 'Showing' });
      await showing.click();
      await expect(showing).toHaveAttribute('aria-selected', 'true');
    });

    await test.step("2. Exactly two scrollers: the grid and the panel's own list; not <main>, not the page", async () => {
      // Layout settles over a few frames (drawer margins, card heights): poll the measurement.
      await expect.poll(async () => (await scrollers(page)).filter((s) => s.kind === 'grid').length).toBe(1);
      const found = await scrollers(page);
      const describe = found.map((s) => `${s.kind}: ${s.what}`).join(' ; ');
      expect(found.filter((s) => s.kind === 'other'), `stray scrollers (${describe})`).toEqual([]);
      expect(found.filter((s) => s.kind === 'panel').length, `panel scrollers (${describe})`).toBe(1);
      // The same rule through the shared probe (I2 per pane), plus the page-wide checks (I3-I7).
      await expectCleanUI(page, { label: `07 Showing open ${width}`, panes: ['[data-gallery-panel="filter"]'] });
    });
  });
}

test('the hover card stays compact: at most 640 px, tags on one line with a +N', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });

  await test.step('1. Open the album and switch the photo tooltip to Hover', async () => {
    await openLayoutAlbum(page);
    await page.getByRole('button', { name: 'Display' }).click();
    await page.getByRole('button', { name: /^Tooltip:/ }).click();
    await page.getByRole('menuitemradio', { name: /Hover/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitemradio')).toHaveCount(0);
  });

  await test.step('2. Hover the photo with 20 tags: the floating card is at most 640 px wide', async () => {
    await page.getByRole('button', { name: 'LAY_001.jpg' }).hover();
    const card = page.locator('app-photo-tooltip > div').filter({ has: page.locator('[data-tags-row]') });
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    expect(box.width, 'hover card width').toBeLessThanOrEqual(640);
    await expectCleanUI(page, { label: '07 hover card' });
  });

  await test.step('3. Its tags row is one line, cut off with a +N', async () => {
    const row = page.locator('app-photo-tooltip [data-tags-row]');
    const lines = await row.evaluate((el) => {
      const tops = Array.from(el.children).map((c) => Math.round(c.getBoundingClientRect().top));
      return { rows: new Set(tops).size, chips: el.children.length, overflowY: el.scrollHeight - el.clientHeight };
    });
    expect(lines.rows, `tag chips laid out on ${lines.rows} lines`).toBe(1);
    expect(lines.overflowY, 'tags row hides a second line').toBeLessThanOrEqual(1);
    const more = row.locator('[data-tags-more]');
    await expect(more).toHaveText(/^\+\d+$/);
    const hidden = Number((await more.textContent())!.slice(1));
    expect(hidden + lines.chips - 1, 'shown chips + hidden count').toBe(20);
  });

  await test.step('4. Its 7 people are one line too, cut off with a +N', async () => {
    const row = page.locator('app-photo-tooltip [data-people-row]');
    const lines = await row.evaluate((el) => {
      // Items are centred in the row (avatars are taller than the +N): compare centres, not tops.
      const centres = Array.from(el.children).map((c) => { const r = c.getBoundingClientRect(); return Math.round(r.top + r.height / 2); });
      return { rows: new Set(centres).size, shown: el.querySelectorAll('img').length };
    });
    expect(lines.rows, `people laid out on ${lines.rows} lines`).toBe(1);
    const more = row.locator('[data-people-more]');
    await expect(more).toHaveText(/^\+\d+$/);
    expect(Number((await more.textContent())!.slice(1)) + lines.shown, 'shown people + hidden count').toBe(7);
  });

  await test.step('5. No line is wider than the picture: the long capture line and caption cannot stretch the card (U5)', async () => {
    const card = page.locator('app-photo-tooltip > div').filter({ has: page.locator('[data-tags-row]') });
    const widths = await card.evaluate((el) => {
      const w = (e: Element | null) => (e ? e.getBoundingClientRect().width : 0);
      return {
        card: w(el), picture: w(el.querySelector('img')), tags: w(el.querySelector('[data-tags-row]')),
        people: w(el.querySelector('[data-people-row]')), capture: w(el.querySelector('[data-capture-line]')),
        captureText: el.querySelector('[data-capture-line]')?.textContent?.trim().length ?? 0,
      };
    });
    expect(widths.captureText, 'the seeded capture line is on the card').toBeGreaterThan(60);
    const slack = 1;
    for (const key of ['tags', 'people', 'capture'] as const) {
      expect(widths[key], `${key} line (${JSON.stringify(widths)})`).toBeLessThanOrEqual(widths.picture + slack);
    }
    expect(widths.card - widths.picture, `card minus picture, the card's own padding (${JSON.stringify(widths)})`).toBeLessThanOrEqual(40);
  });
});

// The photo page's Showing panel holds the collection's photo list: from lg that list is the panel's one
// scroller (a second bar beside it came from `h-full` overflowing the panel by its header's height).
for (const width of [1280, 1600]) {
  test(`photo page with Showing open at ${width} px: the collection list is the one scroller`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });

    await test.step('1. Open a photo of the 80-photo album and its Showing panel', async () => {
      await openLayoutAlbum(page);
      await page.getByRole('button', { name: 'LAY_002.jpg' }).dblclick();
      const showing = page.getByRole('tablist', { name: 'Photo panels' }).getByRole('tab', { name: 'Showing' });
      await showing.click();
      await expect(showing).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel', { name: 'Showing' }).getByRole('button', { name: 'LAY_001.jpg' })).toBeVisible();
    });

    await test.step('2. The panel does not scroll itself; one list inside it does; the page does not', async () => {
      await expect.poll(async () => (await scrollers(page)).filter((s) => s.kind === 'panel').length).toBe(1);
      const found = await scrollers(page);
      const describe = found.map((s) => `${s.kind}: ${s.what}`).join(' ; ');
      expect(found.filter((s) => s.kind === 'other'), `stray scrollers (${describe})`).toEqual([]);
      const aside = await page.locator('[data-photo-inspector]').evaluate((el) => ({ scrolls: el.scrollHeight - el.clientHeight, y: getComputedStyle(el).overflowY }));
      expect(aside.scrolls, `the panel container itself overflows (overflow-y ${aside.y})`).toBeLessThanOrEqual(1);
      await expectCleanUI(page, { label: `07 photo Showing ${width}`, panes: ['[data-photo-inspector]'] });
    });
  });
}

// The probe's page-wide checks (no sideways scroll, floating cards within the cap and the viewport, alerts
// inside the viewport, no raw keys) at the widths of the UI standard, light and dark, on the album and the
// photo page. Content widths are recorded in the report (annotation "content-width"), not asserted: at 2950
// the question is whether anything stretches edge to edge, which a person judges from the numbers.
const LAYOUTS = [
  ...Object.entries(WIDTHS).map(([name, size]) => ({ name, size, theme: 'light' as const })),
  { name: 'half', size: WIDTHS.half, theme: 'dark' as const },
  { name: 'phone', size: WIDTHS.phone, theme: 'dark' as const },
];

for (const { name, size, theme } of LAYOUTS) {
  test(`album and photo page are clean at ${name} ${size.width}x${size.height}, ${theme}`, async ({ page }) => {
    await page.setViewportSize(size);
    await useTheme(page, theme);
    const label = `07 ${name} ${size.width} ${theme}`;
    const lg = size.width >= 1024;

    await test.step('1. The 80-photo album, with the Showing panel open where there is a rail', async () => {
      await openAlbum(page, 'E2E Layout');   // the nav link is a drawer at phone width: enter from the Albums page
      await expect(page.getByRole('button', { name: 'LAY_001.jpg' })).toBeVisible();
      // The theme really is the one asked for (light adds a class to <html>).
      if (theme === 'dark') await expect(page.locator('html')).not.toHaveClass(/light-mode/);
      else await expect(page.locator('html')).toHaveClass(/light-mode/);
      if (lg) {
        const showing = page.getByRole('tablist', { name: 'Gallery panels' }).getByRole('tab', { name: 'Showing' });
        await showing.click();
        await expect(showing).toHaveAttribute('aria-selected', 'true');
      }
      await expectCleanUI(page, { label: `${label} album`, panes: lg ? ['[data-gallery-panel="filter"]'] : undefined });
      await recordContentWidth(page, `${label} album`);
    });

    await test.step('2. The photo page with the Content panel', async () => {
      await page.goto(photoUrl('layout', 'LAY_001.jpg'));
      await page.getByRole('tablist', { name: 'Photo panels' }).getByRole('tab', { name: 'Content' }).click();
      await expect(page.getByRole('tabpanel', { name: 'Content' })).toBeVisible();
      await expectCleanUI(page, { label: `${label} photo`});
      await recordContentWidth(page, `${label} photo`);
    });
  });
}
