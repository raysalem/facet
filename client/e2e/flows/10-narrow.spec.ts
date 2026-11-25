import { test, expect } from '../fixtures';
import { expectCleanUI } from '../helpers/ui-probe.helpers';
import {
  expectNoPageScroll, expectTagKindOrder, openAlbum, photoTabsLayout, photoUrl, recordContentWidth, signInAsEditor,
} from '../helpers/nav';

// From sm (640 px) the side panels sit at the side at every width: the gallery's rail and the photo page's
// panel tabs in a column beside the content. Below sm (a phone, Panel on phone: Bottom sheet, the default) the
// gallery has no rail and Filters opens as a drawer; on the photo page the panel tabs are a bar of icons in a
// row instead of a column, and the Content panel reads in the same order as when wide (U13). Nothing scrolls
// sideways (I3). sm is Tailwind's 640 px, so 640 itself is the first width WITH the rail; 639 the last without.

const SIZES = [
  { name: '1023 (below lg, still the side rail)', width: 1023, height: 768, rail: true },
  { name: '640 (first width with the rail)', width: 640, height: 768, rail: true },
  { name: '639 (last width without it)', width: 639, height: 768, rail: false },
  { name: '390 phone', width: 390, height: 844, rail: false },
];

for (const { name, width, height, rail } of SIZES) {
  test(`at ${name} the gallery and the photo page keep their content in order`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await signInAsEditor(page);
    const panels = page.getByRole('tablist', { name: 'Gallery panels' });

    await test.step('1. The album: the rail is there from sm and only then', async () => {
      await openAlbum(page, 'E2E Tagged');
      await expect(page.getByRole('grid').getByRole('button', { name: /^TAG_0\d\.jpg$/ })).toHaveCount(6);
      if (rail) await expect(panels).toBeVisible();
      else await expect(panels).toHaveCount(0);
      await expectNoPageScroll(page, `album at ${width}`);
      await expectCleanUI(page, { label: `10 album ${width}` });
      await recordContentWidth(page, `10 album ${width}`);
    });

    if (!rail) {
      await test.step('2. Filters opens as a drawer and closes again', async () => {
        const filters = page.getByRole('button', { name: 'Filters', exact: true });
        await filters.click();
        await expect(filters).toHaveAttribute('aria-expanded', 'true');
        const find = page.getByRole('tabpanel', { name: 'Find' });
        await expect(find.getByRole('combobox', { name: 'Set' })).toBeVisible();
        await expectNoPageScroll(page, `filters drawer at ${width}`);
        await expectCleanUI(page, { label: `10 filters drawer ${width}` });
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(filters).toHaveAttribute('aria-expanded', 'false');
        await expect(find).toHaveCount(0);
      });
    }

    await test.step('3. The photo page: tabs in a column from sm, in a row below; Content in the same order', async () => {
      await page.goto(photoUrl('tagged', 'TAG_01.jpg'));
      await page.getByRole('tablist', { name: 'Photo panels' }).getByRole('tab', { name: 'Content' }).click();
      expect(await photoTabsLayout(page), `photo tabs at ${width}`).toBe(rail ? 'column' : 'row');
      if (!rail) {
        const bar = (await page.getByRole('tablist', { name: 'Photo panels' }).boundingBox())!;
        expect(bar.x, 'the tab bar starts inside the viewport').toBeGreaterThanOrEqual(0);
        expect(bar.x + bar.width, 'the tab bar ends inside the viewport').toBeLessThanOrEqual(width + 1);
      }
      await expectTagKindOrder(page, `Content at ${width}`);
      await expectNoPageScroll(page, `photo page at ${width}`);
      await expectCleanUI(page, { label: `10 photo page ${width}` });
      await recordContentWidth(page, `10 photo ${width}`);
    });

    await test.step('4. The panel hides to the side and opens again', async () => {
      const content = page.getByRole('tabpanel', { name: 'Content' });
      await page.getByRole('button', { name: 'Hide panel' }).click();
      await expect(content).toBeHidden();
      await page.getByRole('tablist', { name: 'Photo panels' }).getByRole('tab', { name: 'Content' }).click();
      await expect(content).toBeVisible();
      await expectNoPageScroll(page, `reopened panel at ${width}`);
    });
  });
}
