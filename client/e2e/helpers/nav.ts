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
