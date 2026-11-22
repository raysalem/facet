/* Copy next to ui-probe.js in the repo's e2e/helpers. See UI-STANDARD.md.
 *
 * Use at every key state, at 1440x900, 1280x720, 390x844 and dark where available:
 *   await expectCleanUI(page, { label: 'loaded-1280', panes: ['aside', 'main'] });
 *
 * DIRTY-PROFILE PASS (once per build, service worker ON, one persistent context):
 *   1. Load the PREVIOUS build first and let the service worker install.
 *   2. Serve the new build, reload (F5 only, no hard reload). The version badge must show the new hash (I10).
 *   3. Close the panel and reopen it. What was loaded must still be loaded (I9).
 *   4. Switch view A -> B fast (throttle the API ~1.5 s). No rows from A may show in B (I8).
 *   5. Plain login: no unlock, no stored state. Same data, or a stated reason (I13).
 *   Call expectCleanUI after each step.
 */
import { expect, type Page } from '@playwright/test';
import * as path from 'path';
import { KNOWN_FINDINGS } from './known-findings';

export interface ProbeOpts {
  label?: string;
  maxFloat?: number;
  /** Pane selectors; each may hold at most 1 vertical scroller. Default: whole page. */
  panes?: string[];
  /** Enforce the design census (D1, D2, D6, D9, D11, D12). Default false: always returned, not failed. */
  design?: boolean;
  /** Allowed font sizes / spacing handled by the probe; max filled primary buttons per view (D6). */
  maxPrimary?: number;
  maxFontSizes?: number;
  maxToolbarControls?: number;
}

export async function expectCleanUI(page: Page, opts: ProbeOpts = {}) {
  await page.addScriptTag({ path: path.join(__dirname, 'ui-probe.js') });
  const r: any = await page.evaluate((o) => (window as any).uiProbe(o), { maxFloat: opts.maxFloat ?? 640 });
  // Local change: skip what KNOWN_FINDINGS lists, by exact rule + selector (known-findings.ts).
  const known = (rule: string, selector: string) => KNOWN_FINDINGS.some((k) => k.rule === rule && k.selector === selector);
  r.scrollers = r.scrollers.filter((x: any) => !known('I2', x.selector));
  r.offscreenAlerts = r.offscreenAlerts.filter((x: any) => !known('I7', x.selector));
  r.wideFloating = r.wideFloating.filter((x: any) => !known('I4', x.selector));
  r.hiddenButVisible = r.hiddenButVisible.filter((x: any) => !known('I1', x.selector));
  r.rawI18nKeys = r.rawI18nKeys.filter((x: any) => !known('I5', x.selector));
  if (known('I3', 'page')) r.horizontalOverflow = { overflow: false, px: 0 };
  const tag = opts.label ? `[${opts.label}] ` : '';
  const fail = (m: string, d: unknown) => expect(false, `${tag}${m}: ${JSON.stringify(d)}`).toBe(true);

  if (opts.panes?.length) {
    for (const p of opts.panes) {
      const n: number = await page.locator(p).first().evaluate((el, scrollers: any[]) =>
        scrollers.filter((s) => {
          try { const t = document.querySelector(s.selector); return !!t && (el === t || el.contains(t)); } catch { return false; }
        }).length, r.scrollers).catch(() => 0);
      if (n > 1) fail(`I2 pane ${p} has ${n} vertical scrollers`, r.scrollers);
    }
  } else if (r.scrollers.length > 1) {
    fail('I2 more than 1 vertical scroller', r.scrollers);
  }
  if (r.horizontalOverflow.overflow) fail('I3 horizontal overflow', r.horizontalOverflow);
  if (r.offscreenAlerts.length) fail('I7 alert outside viewport', r.offscreenAlerts);
  if (r.wideFloating.length) fail('I4 floating card too wide', r.wideFloating);
  if (r.hiddenButVisible.length) fail('I1 hidden but visible', r.hiddenButVisible);
  if (r.rawI18nKeys.length) fail('I5 raw i18n keys', r.rawI18nKeys);
  if (opts.design) {
    if (r.rawTechTerms.length) fail('D11 raw technical terms on screen', r.rawTechTerms);
    if (r.truncated.length) fail('D12 truncated without title', r.truncated);
    const np = r.style.filledPrimaryButtons.count;
    if (np > (opts.maxPrimary ?? 1)) fail('D6 more than one filled primary button', r.style.filledPrimaryButtons);
    if (r.style.fontSizes.length > (opts.maxFontSizes ?? 5)) fail('D2 too many font sizes', r.style.fontSizes);
    if (r.style.fontWeights.length > 2) fail('D3 more than two font weights', r.style.fontWeights);
    if (Object.keys(r.style.offScaleSpacing).length > 0) fail('D1 off-scale spacing', r.style.offScaleSpacing);
    const big = r.toolbars.filter((t: any) => t.controls > (opts.maxToolbarControls ?? 5));
    if (big.length) fail('D9 toolbar over budget', big);
  }
  return r;
}

/** Network gate (I6). Fails on 5xx and on 4xx not in allow4xx (expected 401/404 flows pass).
 *  Call once per test: const gate = attachNetworkGate(page, { allow4xx: [401, 404] }); ... gate.assertClean(); */
export function attachNetworkGate(page: Page, o: { allow4xx?: number[] } = {}) {
  const allow = new Set(o.allow4xx ?? []);
  const bad: string[] = [];
  page.on('response', (res) => {
    const st = res.status();
    if (st >= 500 || (st >= 400 && !allow.has(st))) bad.push(`${st} ${res.request().method()} ${res.url()}`);
  });
  return { bad, assertClean: () => expect(bad, `HTTP failures: ${bad.join(' | ')}`).toEqual([]) };
}

/** Flow metrics (F4, F5). Call installFlowMetrics(page) BEFORE page.goto (addInitScript), then
 *  flowMetrics(page) after each action, or measureClick(page, locator) around a click. */
export async function installFlowMetrics(page: Page) {
  await page.addInitScript(() => {
    (window as any).__cls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    } catch { /* unsupported: cls stays 0 */ }
  });
}

/** Click, then time until the first DOM mutation (ack). F5: <= 150 ms. */
export async function measureClick(page: Page, target: string) {
  await page.evaluate(() => {
    const w = window as any; w.__ack = null;
    w.__t0 = performance.now();
    new MutationObserver((_m, obs) => { w.__ack = performance.now() - w.__t0; obs.disconnect(); })
      .observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.locator(target).first().click();
  await page.waitForFunction(() => (window as any).__ack !== null, null, { timeout: 5000 }).catch(() => {});
  return page.evaluate(() => (window as any).__ack as number | null);
}

/** Share of the viewport grid (12x8 cells) that has no visible content: no text, image, canvas, input or colored box.
 *  Sample during a wait (F5): a ratio that stays high for over 300 ms is a blank region. */
export async function blankAreaRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const cols = 12, rows = 8; let blank = 0;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const x = (i + 0.5) * innerWidth / cols, y = (j + 0.5) * innerHeight / rows;
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      let has = false;
      if (el && el !== document.body && el !== document.documentElement) {
        const s = getComputedStyle(el);
        const bg = /rgba?\(.*?,\s*0\)$|transparent/.test(s.backgroundColor);
        has = /^(IMG|CANVAS|SVG|VIDEO|INPUT|SELECT|TEXTAREA|BUTTON)$/i.test(el.tagName)
          || !!(el.textContent || '').trim() && !el.children.length
          || (!bg && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && !!el.closest('[class*=skeleton],[aria-busy],button,input'));
      }
      if (!has) blank++;
    }
    return blank / (cols * rows);
  });
}

/** Bundle for flow-metrics.json: { cls, ackMs, blankRatio }. F4 cls < 0.05; F5 ackMs <= 150. */
export async function flowMetrics(page: Page, clickTarget?: string) {
  const ackMs = clickTarget ? await measureClick(page, clickTarget) : null;
  const blankRatio = await blankAreaRatio(page);
  const cls: number = await page.evaluate(() => (window as any).__cls ?? 0);
  return { cls, ackMs, blankRatio };
}
// The fixture that fails on console.error / pageerror / 5xx (I6) lives in fixtures.ts, see GUI-TESTING.md.
