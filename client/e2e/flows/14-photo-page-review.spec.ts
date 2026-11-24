import { test, expect, seedTool, unlockEdition, libraryPath } from '../fixtures';

// Review edits on the photo page persist: a star rating, the favourite flag and a Keep decision
// are still set after a reload, which reads them back from the server.
test('rating, favouriting and keeping a photo survive a reload', async ({ page }) => {
  seedTool('reset', 'edit');
  await unlockEdition(page);
  const url = `/photo?path=${encodeURIComponent(libraryPath('edit', 'IMG_0600.jpg'))}`;
  const review = () => page.getByRole('region', { name: 'Review' });

  await test.step('1. The photo starts unrated, not favourite and undecided', async () => {
    await page.goto(url);
    await expect(review().getByRole('button', { name: 'Undecided' })).toHaveAttribute('aria-pressed', 'true');
    await expect(review().getByRole('button', { name: 'Favorite' })).not.toHaveAttribute('aria-pressed', 'true');
  });

  await test.step('2. Four stars, Favorite and Keep are set', async () => {
    await review().getByRole('button', { name: 'Set rating: 4' }).click();
    await review().getByRole('button', { name: 'Favorite' }).click();
    await review().getByRole('button', { name: 'Keep', exact: true }).click();
    await expect(review().getByRole('button', { name: 'Keep', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  await test.step('3. After a reload the three values are read back', async () => {
    await page.reload();
    await expect(review().getByRole('button', { name: 'Keep', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(review().getByRole('button', { name: 'Favorite' })).toHaveAttribute('aria-pressed', 'true');
    await expect(review().getByRole('button', { name: 'Set rating: 4' })).toHaveAttribute('aria-pressed', 'true');
  });
});

// B52: from lg up the review strip sticks to the top of the panel. It once pulled itself 16 px up over the
// panel's header row, so with editing unlocked the lower half of "Grade", the collection's previous / next
// and the X were drawn over and a click on them landed on the strip. Every header control must take its
// own clicks, the strip must start below the header, and Next must step to the next photo.
test('the Grade panel header stays clear of the review strip', async ({ page }) => {
  await unlockEdition(page);
  const header = page.locator('[data-panel-header]');
  const strip = page.locator('section[data-photo-review]');

  await test.step('1. A gallery card opens its photo page on the Grade panel, with the review strip', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'IMG_0300.jpg', exact: true }).dblclick();
    await expect(page.getByRole('heading', { name: 'IMG_0300.jpg', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Grade', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(strip).toBeVisible();
    await expect(header.locator('[data-panel-next]')).toBeEnabled();
  });

  for (const width of [1180, 1480, 2950]) {
    await test.step(`2. At ${width} px the header's Previous, Next and Hide panel take their own clicks`, async () => {
      await page.setViewportSize({ width, height: 1100 });
      await expect.poll(() => page.evaluate(() => {
        const misses: string[] = [];
        for (const name of ['data-panel-previous', 'data-panel-next', 'data-collapse-panel']) {
          const button = document.querySelector(`[${name}]`);
          if (!button) { misses.push(`${name} absent`); continue; }
          const box = button.getBoundingClientRect();
          // The centre and a point 2 px above the bottom edge: the strip covered the lower half.
          for (const y of [box.top + box.height / 2, box.bottom - 2]) {
            const hit = document.elementFromPoint(box.left + box.width / 2, y);
            if (!button.contains(hit)) misses.push(`${name} at y=${Math.round(y)}: ${hit?.closest('[data-photo-review]') ? 'review strip' : hit?.tagName}`);
          }
        }
        const headerBottom = document.querySelector('[data-panel-header]')!.getBoundingClientRect().bottom;
        const stripTop = document.querySelector('section[data-photo-review]')!.getBoundingClientRect().top;
        if (stripTop < headerBottom - 0.5) misses.push(`strip top ${stripTop} above header bottom ${headerBottom}`);
        return misses;
      }), { message: `header controls covered at ${width} px` }).toEqual([]);
    });
  }

  await test.step('3. A real click on Next steps to the next photo and stays on Grade', async () => {
    const position = header.locator('[data-panel-position]');
    const before = await position.textContent();
    const url = page.url();
    await header.locator('[data-panel-next]').click({ timeout: 5_000 });
    await expect(page).not.toHaveURL(url);
    await expect(position).not.toHaveText(before ?? '');
    await expect(page.getByRole('tab', { name: 'Grade', exact: true })).toHaveAttribute('aria-selected', 'true');
  });
});
