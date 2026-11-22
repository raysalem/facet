import { test, expect, type Page } from '../fixtures';
import { expectCleanUI } from '../helpers/ui-probe.helpers';

// The gallery store is a root singleton. Opening an album kept the rows of the view shown last
// on screen, and clickable, until the album's config and album reads finished. Found by hand as
// B39 on a slow network; fails without the clear at the start of GalleryComponent's fresh visit.

/** Hold the visit's config and album reads (1.5 s each): the window in which the old rows showed. */
async function holdVisitReads(page: Page, id: string): Promise<() => boolean> {
  let hit = false;
  // The context, not the page, routes them: with the service worker on, the app's fetches leave
  // through the worker, which page.route does not see.
  await page.context().unrouteAll();
  await page.context().route(new RegExp(`/api/(config|albums/${id})(\\?.*)?$`), async (route) => {
    hit = true;
    await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });
  return () => hit;
}

/** While the URL is `path`, record each card whose name lacks `prefix`: on every DOM change, and
 *  every 25 ms (which also counts how long the URL has been the album's). */
async function watchForStrangers(page: Page, path: string, prefix: string, album: string): Promise<void> {
  await page.evaluate(([path, prefix, album]) => {
    const w = window as unknown as {
      __strangers: string[]; __ticks: number; __loadingBad: string[]; __skeleton: boolean; __loadingTicks: number;
    };
    w.__strangers = [];
    w.__ticks = 0;
    w.__loadingBad = [];
    w.__skeleton = false;
    w.__loadingTicks = 0;
    let loaded = false;
    const bad = (what: string) => { if (!w.__loadingBad.includes(what)) w.__loadingBad.push(what); };
    const look = () => {
      if (location.pathname !== path) return;
      const own = Array.from(document.querySelectorAll('app-photo-card [role="button"]'))
        .some((c) => (c.getAttribute('aria-label') ?? '').startsWith(prefix));
      if (own) loaded = true;
      // B46: until the album's first page is in, the page is loading: no empty state, no count of the
      // old view, a neutral or the new title, and a skeleton.
      if (!loaded) {
        w.__loadingTicks++;
        if (/No photos found/.test(document.body.innerText)) bad('empty state "No photos found"');
        const count = document.querySelector('[data-collection-header] p[role="status"]')?.textContent?.trim() ?? '';
        if (count) bad('count line "' + count + '"');
        const title = document.querySelector('[data-collection-header] h1')?.textContent?.trim();
        if (title && title !== 'Loading photos…' && title !== album) bad('title "' + title + '"');
        if (document.querySelector('[role="status"][aria-busy="true"]')) w.__skeleton = true;
      }
      for (const card of Array.from(document.querySelectorAll('app-photo-card [role="button"]'))) {
        const name = card.getAttribute('aria-label') ?? '';
        if (!name.startsWith(prefix) && !w.__strangers.includes(name)) w.__strangers.push(name);
      }
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true });
    setInterval(() => { if (location.pathname === path) w.__ticks++; look(); }, 25);
  }, [path, prefix, album]);
}

async function strangersSeen(page: Page): Promise<{
  strangers: string[]; ticks: number; loadingBad: string[]; skeleton: boolean; loadingTicks: number;
}> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __strangers: string[]; __ticks: number; __loadingBad: string[]; __skeleton: boolean; __loadingTicks: number;
    };
    return {
      strangers: w.__strangers, ticks: w.__ticks, loadingBad: w.__loadingBad, skeleton: w.__skeleton,
      loadingTicks: w.__loadingTicks,
    };
  });
}

test("opening an album never shows the previous view's photos", async ({ page }) => {
  const albumLink = (name: string) => page.getByRole('link', { name: new RegExp(name) });
  const cards = (prefix: string) => page.getByRole('button', { name: new RegExp(`^${prefix}_\\d+\\.jpg$`) });
  const idOf = async (name: string) => (await albumLink(name).getAttribute('href'))!.split('/').pop()!;

  /** Open the album by its card on the Albums page; only its own photos may ever be on screen. */
  async function openSlowly(name: string, prefix: string): Promise<void> {
    const id = await idOf(name);
    const held = await holdVisitReads(page, id);
    await watchForStrangers(page, `/album/${id}`, `${prefix}_`, name);
    await albumLink(name).click();
    await expect(page).toHaveURL(new RegExp(`/album/${id}$`));
    // Loaded = the album's title and exactly its six cards (a stale grid can hold them too).
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(page.getByRole('grid').getByRole('button', { name: /\.jpg$/ })).toHaveCount(6);
    await expect(cards(prefix)).toHaveCount(6);
    expect(held(), `${name}: the visit's reads were not held back`).toBe(true);
    const { strangers, ticks, loadingBad, skeleton, loadingTicks } = await strangersSeen(page);
    // At least 2 s watched (two held reads), so the window was really open.
    expect(ticks, `${name}: 25 ms ticks watched`).toBeGreaterThan(80);
    expect(strangers, `cards of another view seen under ${name}`).toEqual([]);
    // B46: while the reads were held the page was in a loading state, never an empty or stale one.
    expect(loadingTicks, `${name}: 25 ms ticks spent loading`).toBeGreaterThan(20);
    expect(loadingBad, `${name}: stale or empty-state content while the reads were held`).toEqual([]);
    expect(skeleton, `${name}: a loading skeleton was on screen`).toBe(true);
    await page.context().unrouteAll();
    await expectCleanUI(page, { label: `05 ${name} loaded` });
  }

  await test.step("1. The plain gallery shows every photo, the albums' included", async () => {
    // Wait for the gallery before moving on: entering an album while the app's startup config read
    // is still out can leave an empty grid (a separate startup race, not this flow's subject).
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'IMG_0001_agy_1.jpg', exact: true })).toBeVisible();
    await expect(cards('ALB_B')).toHaveCount(6);
    await page.getByRole('link', { name: /Albums$/ }).click();
    await expect(albumLink('E2E Album A')).toBeVisible();
  });

  await test.step("2. Album A on a slow network: never a card of the plain gallery", async () => {
    await openSlowly('E2E Album A', 'ALB_A');
  });

  await test.step('3. Back to the list, then album B on a slow network: never a card of album A', async () => {
    await page.goBack();
    await expect(albumLink('E2E Album B')).toBeVisible();
    await openSlowly('E2E Album B', 'ALB_B');
  });
});
