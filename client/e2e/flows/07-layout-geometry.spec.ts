import { test, expect, type Page } from '../fixtures';

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
});
