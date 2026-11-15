import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from '../fixtures';

// After a server upgrade the service worker kept serving the old build until the user clicked
// the "new version" snackbar, and that old bundle ran against the new server (B41/B42). The app
// now applies a new build on its own, unless the user is busy, in which case it waits.
//
// A second `ng build` is not needed to make "build 2": the service worker identifies a build by
// its ngsw.json, so the flow rewrites the served index.html with a marker and updates its hash in
// ngsw.json, exactly as a rebuild that changed the shell would. Both files are put back afterwards.
const DIST = path.resolve(__dirname, '..', '..', 'dist', 'client', 'browser');
const INDEX = path.join(DIST, 'index.html');
const MANIFEST = path.join(DIST, 'ngsw.json');
const MARKER = 'facet-e2e-build';

/** Serve "build N": the original shell with a marker, and a manifest whose hash agrees with it. */
function serveBuild(n: number, index: Buffer, manifest: Buffer): void {
  const html = Buffer.from(index.toString('utf8').replace('<head>', `<head><meta name="${MARKER}" content="${n}">`));
  if (html.equals(index)) throw new Error('index.html has no <head> to mark');
  const ngsw = JSON.parse(manifest.toString('utf8'));
  ngsw.hashTable['/index.html'] = createHash('sha1').update(html).digest('hex');
  fs.writeFileSync(INDEX, html);
  fs.writeFileSync(MANIFEST, JSON.stringify(ngsw, null, 2));
}

const shownBuild = (page: Page) => page.locator(`meta[name="${MARKER}"]`).getAttribute('content', { timeout: 1_000 })
  .catch(() => null);

/** A flag on `window` survives everything but a reload: it tells "reloaded" from "re-rendered". */
const plant = (page: Page) => page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
const planted = (page: Page) => page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload === true)
  .catch(() => false);

/** What the app does when the tab becomes visible again: ask the worker for a newer build. */
const tabShown = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('a new app build is applied without a click, and waits while the user is typing', async ({ page }) => {
  test.setTimeout(120_000);
  const index = fs.readFileSync(INDEX);
  const manifest = fs.readFileSync(MANIFEST);
  try {
    await test.step('1. Load build 1 and let the service worker take the page', async () => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'IMG_0001_agy_1.jpg', exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(async () => {
        if (!navigator.serviceWorker.controller) return 'no controller';
        return (await (await fetch('/ngsw/state')).text()).match(/Latest manifest hash: (\S+)/)?.[1] ?? 'no state';
      }), { timeout: 30_000 }).toMatch(/^[0-9a-f]{40}$/);
      expect(await shownBuild(page)).toBeNull();
    });

    await test.step('2. Build 2 is deployed; the tab is shown again; the page reloads onto it by itself', async () => {
      await plant(page);
      serveBuild(2, index, manifest);
      await tabShown(page);
      await expect.poll(() => shownBuild(page), { timeout: 30_000 }).toBe('2');
      expect(await planted(page), 'the page was reloaded, not patched').toBe(false);
      await expect(page.getByRole('button', { name: 'IMG_0001_agy_1.jpg', exact: true })).toBeVisible();
    });

    const search = page.getByRole('searchbox', { name: /^Search/ });

    await test.step('3. With text typed in a focused field, build 3 waits behind the banner', async () => {
      await search.click();
      await search.pressSequentially('sunset');
      await plant(page);
      serveBuild(3, index, manifest);
      await tabShown(page);
      await expect(page.getByText('Facet will reload when you are done')).toBeVisible({ timeout: 30_000 });
      // Proving that something does NOT happen needs a wait: past one idle re-check (5 s).
      await page.waitForTimeout(6_500);
      expect(await planted(page), 'reloaded while the field had focus').toBe(true);
      expect(await shownBuild(page)).toBe('2');
      await expect(search).toHaveValue('sunset');
    });

    await test.step('4. Focus leaves the field: the deferred reload lands on build 3, the search kept', async () => {
      // The gallery search applies as it is typed (it is in the URL), so leaving the field ends
      // the work: nothing typed is lost by the reload.
      await expect(page).toHaveURL(/[?&]search=sunset/);
      await search.blur();
      await expect.poll(() => shownBuild(page), { timeout: 20_000 }).toBe('3');
      expect(await planted(page), 'the page was reloaded').toBe(false);
      await expect(page).toHaveURL(/[?&]search=sunset/);
      await expect(search).toHaveValue('sunset');
    });

    await test.step('5. Text left in an unfocused field that nothing has used holds build 4 back', async () => {
      // No gallery field keeps text without applying it (search and filters go to the URL at once),
      // so the flow adds a plain note field to the page. The service watches every field through
      // document-level input events, which a real keystroke here fires as on any field.
      await page.evaluate(() => {
        const note = document.createElement('textarea');
        note.setAttribute('aria-label', 'e2e note');
        document.body.prepend(note);
      });
      const note = page.getByRole('textbox', { name: 'e2e note' });
      await note.click();
      await note.pressSequentially('half a thought');
      await note.blur();
      await plant(page);
      serveBuild(4, index, manifest);
      await tabShown(page);
      await expect(page.getByText('Facet will reload when you are done')).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(6_500);
      expect(await planted(page), 'reloaded over typed text in an unfocused field').toBe(true);
      expect(await shownBuild(page)).toBe('3');
    });

    await test.step('6. The note is emptied: the deferred reload lands on build 4', async () => {
      const note = page.getByRole('textbox', { name: 'e2e note' });
      await note.fill('');
      await note.blur();
      await expect.poll(() => shownBuild(page), { timeout: 20_000 }).toBe('4');
      expect(await planted(page)).toBe(false);
    });
  } finally {
    fs.writeFileSync(INDEX, index);
    fs.writeFileSync(MANIFEST, manifest);
  }
});
