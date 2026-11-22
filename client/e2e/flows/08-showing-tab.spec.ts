import { test, expect, type Page } from '../fixtures';
import { captureForHuman } from '../helpers/human-review-reporter';
import { expectCleanUI } from '../helpers/ui-probe.helpers';
import { openAlbum, openShowing, showingPanel, showingStatement, showingTab, signInAsEditor, WIDTHS } from '../helpers/nav';

// The rail's Showing panel names what the grid holds, and the album's Set pull-down narrows it
// to one of the album's own sets (an album tag). Both belong to the album being looked at: after
// switching albums neither the chip nor the old name may remain (U7, I8). Album switches happen
// inside the app (Albums page, then the album), as a user does, so the gallery store carries over.

const PANEL = '[data-gallery-panel="filter"]';   // the panel is the pane whose scrollers are counted
const cards = (page: Page, pattern: RegExp) => page.getByRole('grid').getByRole('button', { name: pattern });

test('Showing names the album, the Set chip narrows it, and a new album starts clean', async ({ page }) => {
  await page.setViewportSize(WIDTHS.half);
  await signInAsEditor(page);

  await test.step('1. Open the tagged album and its Showing panel: the panel names the album', async () => {
    await openAlbum(page, 'E2E Tagged');
    await openShowing(page);
    await expect(showingStatement(page)).toHaveText('E2E Tagged');
    await expect(cards(page, /^TAG_0\d\.jpg$/)).toHaveCount(6);
    await expectCleanUI(page, { label: '08 album, Showing open', panes: [PANEL] });
  });

  await test.step('2. Set: lunch narrows the grid to its three photos and shows the chip', async () => {
    await showingPanel(page).getByRole('combobox', { name: 'Set' }).click();
    await page.getByRole('option', { name: 'lunch (3)' }).click();
    await expect(cards(page, /^TAG_0\d\.jpg$/)).toHaveCount(3);
    for (const n of [4, 5, 6]) await expect(cards(page, new RegExp(`^TAG_0${n}\\.jpg$`))).toHaveCount(1);
    await expect(showingPanel(page).getByRole('button', { name: 'Remove Set' })).toBeVisible();
    await expect(showingPanel(page).getByRole('group', { name: 'Active criteria' })).toContainText(/Set\s*lunch/);
    await expect(showingStatement(page)).toHaveText('E2E Tagged · 1 filter');
    await expectCleanUI(page, { label: '08 Set chip', panes: [PANEL] });
    await captureForHuman(page, '08-showing-set-chip', "Golden screen candidate: is this Facet's visual bar?",
      { url: page.url(), build: process.env['BUILD_HASH'] });
  });

  await test.step('3. Another album: no Set chip, Showing names the new album, only its photos', async () => {
    await page.getByRole('navigation', { name: 'Navigation' }).getByRole('link', { name: /Albums$/ }).click();
    await page.getByRole('link', { name: /E2E Album A/ }).click();
    await expect(page.getByRole('heading', { name: 'E2E Album A', level: 1 })).toBeVisible();
    // The rail keeps its open panel across the switch; open it only if it closed.
    if ((await showingTab(page).getAttribute('aria-selected')) !== 'true') await openShowing(page);
    await expect(showingStatement(page)).toHaveText('E2E Album A');
    await expect(cards(page, /^ALB_A_\d+\.jpg$/)).toHaveCount(6);
    await expect(page.getByRole('button', { name: 'Remove Set' }), 'the old Set chip is gone').toHaveCount(0);
    await expect(page.getByText('lunch'), 'the old Set value is gone').toHaveCount(0);
    await expect(showingPanel(page).getByText('E2E Tagged'), 'the old album name is gone').toHaveCount(0);
    await expect(showingPanel(page).getByText(/ · \d+ filters?$/), 'no filter is carried over').toHaveCount(0);
    await expectCleanUI(page, { label: '08 new album', panes: [PANEL] });
  });

  await test.step('4. A long folder chip truncates inside the panel (B48)', async () => {
    const folder = '//192.168.1.90/Photos and Videos/peter/' + 'first communion with a very long folder name '.repeat(3).trim();
    await page.goto(page.url().split('?')[0] + '?path_prefix=' + encodeURIComponent(folder));
    await expect(page.getByRole('heading', { name: 'E2E Album A', level: 1 })).toBeVisible();
    if ((await showingTab(page).getAttribute('aria-selected')) !== 'true') await openShowing(page);
    const chip = showingPanel(page).getByRole('group', { name: 'Active criteria' }).locator('> div', { hasText: 'first communion' });
    await expect(chip, 'the folder chip is listed').toContainText('first communion');
    const box = (await chip.boundingBox())!;
    const panel = (await showingPanel(page).boundingBox())!;
    expect(box.x + box.width, 'the chip ends inside the Showing panel').toBeLessThanOrEqual(panel.x + panel.width);
    await expectCleanUI(page, { label: '08 long folder chip', panes: [PANEL] });
  });
});
