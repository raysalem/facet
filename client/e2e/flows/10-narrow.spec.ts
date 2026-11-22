import { test, expect } from '../fixtures';
import { expectCleanUI } from '../helpers/ui-probe.helpers';
import {
  expectNoPageScroll, expectTagKindOrder, openAlbum, photoTabsLayout, photoUrl, recordContentWidth, signInAsEditor,
} from '../helpers/nav';

// Below lg (1024 px) the gallery has no rail: Filters opens as a drawer. On the photo page the panel
// tabs are a bar of icons in a row instead of a column, and the Content panel reads in the same
// order as when wide (U13). Nothing scrolls sideways (I3). lg is Tailwind's 1024 px, so 1024 itself
// is the first width WITH the rail; 1023 is the last without it.

const SIZES = [
  { name: '1024 (first width with the rail)', width: 1024, height: 768, rail: true },
  { name: '1023 (last width without it)', width: 1023, height: 768, rail: false },
  { name: '390 phone', width: 390, height: 844, rail: false },
];

for (const { name, width, height, rail } of SIZES) {
  test(`at ${name} the gallery and the photo page keep their content in order`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await signInAsEditor(page);
    const panels = page.getByRole('tablist', { name: 'Gallery panels' });

    await test.step('1. The album: the rail is there from lg and only then', async () => {
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

    await test.step('3. The photo page: tabs in a column from lg, in a row below; Content in the same order', async () => {
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

    await test.step('4. The panel closes to the side and opens again', async () => {
      const content = page.getByRole('tabpanel', { name: 'Content' });
      await page.getByRole('button', { name: 'Close panels' }).click();
      await expect(content).toBeHidden();
      await page.getByRole('tablist', { name: 'Photo panels' }).getByRole('tab', { name: 'Content' }).click();
      await expect(content).toBeVisible();
      await expectNoPageScroll(page, `reopened panel at ${width}`);
    });
  });
}
