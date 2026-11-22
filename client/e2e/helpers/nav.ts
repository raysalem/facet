import { expect, test, type Locator, type Page } from '@playwright/test';
import { editionToken, libraryPath } from '../fixtures';

/** The widths the UI standard names (UI-STANDARD.md, Viewports). Heights as measured on Ray's display. */
export const WIDTHS = {
  window: { width: 1180, height: 880 },
  half: { width: 1480, height: 1100 },
  maximised: { width: 2950, height: 1100 },
  phone: { width: 390, height: 844 },
} as const;

/** Sign in to edition mode before the first page load: the way Ray uses Facet (Add-on names, tag editing). */
export async function signInAsEditor(page: Page): Promise<void> {
  const token = await editionToken(page);
  // Runs in every frame, a sandboxed add-on frame included, where localStorage throws.
  await page.addInitScript((t) => { try { localStorage.setItem('facet_token', t); } catch { /* sandboxed frame */ } }, token);
}

/** Pick the theme before the first page load. */
export async function useTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((dark) => { try { localStorage.setItem('facet_dark_mode', String(dark)); } catch { /* sandboxed frame */ } }, theme === 'dark');
}

export const photoUrl = (folder: string, name: string) => '/photo?path=' + encodeURIComponent(libraryPath(folder, name));

/** Open an album from the Albums page, as a user does. */
export async function openAlbum(page: Page, name: string): Promise<void> {
  await page.goto('/albums');
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

/** The rail's Showing tab and the panel it opens (from lg up). */
export function showingTab(page: Page): Locator {
  return page.getByRole('tablist', { name: 'Gallery panels' }).getByRole('tab', { name: 'Showing' });
}
export const showingPanel = (page: Page) => page.getByRole('tabpanel', { name: 'Showing' });
/** The line under the panel's title: what the grid holds (the album, then the filter count). */
export const showingStatement = (page: Page) => showingPanel(page).getByRole('paragraph').first();

export async function openShowing(page: Page): Promise<void> {
  await showingTab(page).click();
  await expect(showingTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(showingPanel(page).getByRole('combobox', { name: 'Tag' })).toBeVisible();
}

/** Switch the photo tooltip to the floating hover card. */
export async function useHoverCard(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByRole('button', { name: /^Tooltip:/ }).click();
  await page.getByRole('menuitemradio', { name: /Hover/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitemradio')).toHaveCount(0);
}

/** Widths of the page's content, recorded (not asserted) so a stretched layout shows in the report. */
export async function recordContentWidth(page: Page, label: string): Promise<void> {
  const m = await page.evaluate(() => {
    const w = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().width) : 0);
    return { viewport: window.innerWidth, main: w(document.querySelector('main')), grid: w(document.querySelector('[role="grid"]')) };
  });
  test.info().annotations.push({ type: 'content-width', description: `${label}: viewport ${m.viewport}, main ${m.main}, grid ${m.grid}` });
}

/** No horizontal page scroll (I3), asserted outright for the narrow flow. */
export async function expectNoPageScroll(page: Page, label: string): Promise<void> {
  const over = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  expect(over, `${label}: horizontal page scroll (px)`).toBeLessThanOrEqual(1);
}

/** The four tag kinds on a photo Content panel, in the order the UI standard fixes (U4): Tags, People tags,
 *  Object tags (folded), Album tags (folded, last). Their labels, top to bottom; fails if one is missing. */
export async function tagKindPositions(page: Page): Promise<{ kind: string; top: number }[]> {
  const panel = page.getByRole('tabpanel', { name: 'Content' });
  const marks: [string, Locator][] = [
    ['Tags', panel.getByText('Tags', { exact: true })],
    ['People tags', panel.getByRole('heading', { name: 'People tags' })],
    ['Object tags', panel.getByRole('button', { name: /^Object tags from / })],
    ['Album tags', panel.getByRole('button', { name: /^Album tags: / })],
  ];
  const found: { kind: string; top: number }[] = [];
  for (const [kind, locator] of marks) {
    await expect(locator, `the ${kind} group is on the Content panel`).toBeVisible();
    found.push({ kind, top: (await locator.boundingBox())!.y });
  }
  return found;
}

export async function expectTagKindOrder(page: Page, label: string): Promise<void> {
  const found = await tagKindPositions(page);
  const tops = found.map((f) => f.top);
  expect(tops, `${label}: ${found.map((f) => `${f.kind} @${Math.round(f.top)}`).join(', ')}`).toEqual([...tops].sort((a, b) => a - b));
  expect(new Set(tops).size, `${label}: each kind on its own row`).toBe(4);
}

/** The photo page tabs: a rail (icons stacked) from lg, a bar (icons in a row) below it, told by where the tabs sit. */
export async function photoTabsLayout(page: Page): Promise<'column' | 'row'> {
  const tabs = page.getByRole('tablist', { name: 'Photo panels' }).getByRole('tab');
  const boxes = await Promise.all((await tabs.all()).map((t) => t.boundingBox()));
  const xs = new Set(boxes.map((b) => Math.round(b!.x)));
  const ys = new Set(boxes.map((b) => Math.round(b!.y)));
  if (xs.size === 1 && ys.size === boxes.length) return 'column';
  if (ys.size === 1 && xs.size === boxes.length) return 'row';
  throw new Error(`photo panel tabs are neither a column nor a row: ${JSON.stringify(boxes)}`);
}
