import { test, expect } from '../fixtures';
import { captureForHuman } from '../helpers/human-review-reporter';
import { expectCleanUI } from '../helpers/ui-probe.helpers';
import { expectTagKindOrder, openAlbum, photoUrl, signInAsEditor, useHoverCard, WIDTHS } from '../helpers/nav';

// A photo carries four kinds of tag, never mixed (U4): Tags (the AI's and the user's own), People
// tags (named faces), Object tags (what an add-on found, folded) and Album tags (filing, folded,
// last). TAG_01 of the seeded 'E2E Tagged' album has one of each plus an album tag from its set.

test('the four tag kinds read in order, and the hover card shows them one line each without album tags', async ({ page }) => {
  await page.setViewportSize(WIDTHS.half);
  await signInAsEditor(page);   // the add-on's name is known to an editor; an anonymous page shows its id

  await test.step('1. Photo page, Content: Tags, People tags, Object tags, Album tags, in that order', async () => {
    await page.goto(photoUrl('tagged', 'TAG_01.jpg'));
    await page.getByRole('tablist', { name: 'Photo panels' }).getByRole('tab', { name: 'Content' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Content' });
    await expectTagKindOrder(page, 'Content panel');
    await expect(panel.getByRole('button', { name: 'Object tags from E2E Add-on: 1' })).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.getByRole('button', { name: 'Album tags: 1' })).toHaveAttribute('aria-expanded', 'false');
    await expectCleanUI(page, { label: '09 photo page Content' });
    await captureForHuman(page, '09-photo-content-tag-kinds', 'Do the four tag-kind names read right?',
      { url: page.url(), build: process.env['BUILD_HASH'] });
  });

  await test.step('2. Album tags never sit among Tags; each kind holds only its own', async () => {
    const panel = page.getByRole('tabpanel', { name: 'Content' });
    const tags = panel.getByTestId('tags-section');
    for (const own of ['sunset', 'beach', 'Manual tag: family']) await expect(tags.getByRole('button', { name: own, exact: true })).toBeVisible();
    for (const other of ['cup', 'e2e/church', 'Alex Example']) {
      await expect(tags.getByText(other), `"${other}" is not a Tag`).toHaveCount(0);
    }
    await panel.getByRole('button', { name: 'Album tags: 1' }).click();
    await expect(panel.getByRole('button', { name: 'e2e/church' })).toBeVisible();
    await expect(tags.getByText('e2e/church'), 'the album tag is not among Tags').toHaveCount(0);
    await panel.getByRole('button', { name: 'Object tags from E2E Add-on: 1' }).click();
    await expect(panel.getByRole('button', { name: 'Manual tag: cup', exact: true })).toBeVisible();
    await expect(tags.getByText('cup')).toHaveCount(0);
    await expectTagKindOrder(page, 'Content panel, kinds opened');
    await expectCleanUI(page, { label: '09 Content, kinds opened' });
  });

  await test.step('3. Hover card: tags, people and object tags on one line each; no album tags', async () => {
    await openAlbum(page, 'E2E Tagged');
    await useHoverCard(page);
    await page.getByRole('button', { name: 'TAG_01.jpg' }).hover();
    const card = page.locator('app-photo-tooltip > div').filter({ has: page.locator('[data-tags-row]') });
    await expect(card).toBeVisible();
    await expect(card.locator('[data-people-row]').getByRole('img', { name: 'Alex Example' })).toBeVisible();
    await expect(card.locator('[data-object-tag-count]')).toHaveText(/E2E Add-on/);
    const oneLine = (rowSelector: string) => card.locator(rowSelector).evaluate((row) => {
      // Items are centred in the row: compare centres, not tops.
      const centres = Array.from(row.children).map((c) => { const r = c.getBoundingClientRect(); return Math.round(r.top + r.height / 2); });
      return { lines: new Set(centres).size, children: centres.length };
    });
    const tagsRow = await oneLine('[data-tags-row]');
    expect(tagsRow.children, 'the three tags are on the card').toBeGreaterThanOrEqual(3);
    expect(tagsRow.lines, 'tags on one line').toBe(1);
    expect((await oneLine('[data-people-row]')).lines, 'people on one line').toBe(1);
    const objectLine = await card.locator('[data-object-tag-count]').boundingBox();
    expect(objectLine!.height, 'object tags are one text line').toBeLessThanOrEqual(20);
    const tops = await Promise.all(['[data-tags-row]', '[data-people-row]', '[data-object-tag-count]']
      .map(async (s) => (await card.locator(s).boundingBox())!.y));
    expect(tops, 'order: tags, people, object tags').toEqual([...tops].sort((a, b) => a - b));
    await expect(card.locator('[data-album-tags]'), 'no album tags row on the hover card').toHaveCount(0);
    await expect(card.getByText('e2e/church'), 'no album tag text on the hover card').toHaveCount(0);
    await expectCleanUI(page, { label: '09 hover card' });
    await captureForHuman(page, '09-hover-card', 'Is the hover card clutter-free enough?',
      { url: page.url(), build: process.env['BUILD_HASH'] });
  });
});
