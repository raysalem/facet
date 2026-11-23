import { test, expect, type Page } from '../fixtures';
import { signInAsEditor } from '../helpers/nav';

// Every top-level page loads on a seeded library without a page error, a console error or a 5xx
// answer (the `gate` fixture fails the flow on any of them) and stays on its own URL: a route that
// bounces to /login or to the 404 catch-all is a regression the unit tests cannot see.
const ROUTES = [
  '/albums',
  '/capsules',
  '/compare',
  '/culling',
  '/folders',
  '/junk',
  '/map',
  '/persons',
  '/scenes',
  '/stats',
  '/timeline',
];

for (const route of ROUTES) {
  test(`${route} loads without an error`, async ({ page }) => {
    await test.step(`1. Open ${route}`, async () => {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(`${route}(\\?.*)?$`));
    });

    await test.step('2. The page renders something and the network settles', async () => {
      await expect(page.locator('app-root')).not.toBeEmpty();
      await page.waitForLoadState('networkidle');
    });
  });
}

// B51: a direct load (or F5) of a page that is not the gallery must show the same top tabs as the
// gallery. The tabs past Gallery / Persons / Stats come from the viewer config's `features`; the app
// shell's own config load raced the auth status and dropped its answer, so these pages kept 3 to 5
// of the 12 tabs until a gallery page loaded the config again (fails without the fix in App.ngOnInit).
const DIRECT_LOAD_ROUTES = ['/addons', '/stats', '/persons', '/albums', '/timeline'];
const destinationTabs = (page: Page) => page.getByRole('navigation', { name: 'Navigation' }).getByRole('link');

for (const editor of [false, true]) {
  test(`a direct load keeps every top tab (${editor ? 'unlocked' : 'locked'})`, async ({ page }) => {
    if (editor) await signInAsEditor(page);
    let expected: string[] = [];

    await test.step('1. The gallery, loaded directly, names the reference tabs', async () => {
      await page.goto('/');
      await expect(destinationTabs(page).and(page.getByRole('link', { name: 'Albums', exact: true }))).toHaveCount(1);
      await page.waitForLoadState('networkidle');
      expected = await tabNames(page);
      // Albums, Capsules, Timeline, Folders and Scenes are the config-gated ones this guards.
      for (const name of ['Albums', 'Capsules', 'Timeline', 'Folders', 'Scenes']) expect(expected).toContain(name);
    });

    for (const [i, route] of DIRECT_LOAD_ROUTES.entries()) {
      await test.step(`${i + 2}. ${route} loaded directly shows the same ${expected.length} tabs`, async () => {
        await page.goto(route);
        await page.waitForLoadState('networkidle');
        await expect.poll(() => tabNames(page),
          { message: `top tabs after a direct load of ${route}` }).toEqual(expected);
      });
    }
  });
}

/** The top tabs' labels, without their (xl-only) icon ligatures. */
async function tabNames(page: Page): Promise<string[]> {
  return (await destinationTabs(page).allTextContents())
    .map(text => text.replace(/\s+/g, ' ').trim().replace(/^[a-z_]+ ?(?=[A-Z])/, ''));
}
