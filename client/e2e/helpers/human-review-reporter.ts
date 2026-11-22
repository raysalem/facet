/* Generic Playwright reporter + captureForHuman helper. No app-specific code.
 * Copy into <repo>/e2e/helpers/. Config:
 *   reporter: [['list'], ['./helpers/human-review-reporter.ts', { maxCards: 3, build: process.env.BUILD_HASH }]]
 * In a flow:
 *   await captureForHuman(page, 'hover-card', 'Is the hover card one line per tag kind?', { url: page.url(), build });
 * Writes test-results/human-review/<id>.png + <id>.json; the reporter builds test-results/human-review.html.
 * Max cards default 3 (Ray's rule). More than that: all are listed, a warning is printed and shown on the page. */
import type { Page } from '@playwright/test';
import type { Reporter } from '@playwright/test/reporter';
import * as fs from 'fs';
import * as path from 'path';

const OUT = 'test-results';
const DIR = path.join(OUT, 'human-review');

export interface CaptureOpts { url?: string; build?: string; fullPage?: boolean; selector?: string; }

export async function captureForHuman(page: Page, id: string, question: string, opts: CaptureOpts = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const safe = id.replace(/[^\w.-]+/g, '_');
  const file = `${safe}.png`;
  if (opts.selector) await page.locator(opts.selector).first().screenshot({ path: path.join(DIR, file) });
  else await page.screenshot({ path: path.join(DIR, file), fullPage: !!opts.fullPage });
  const meta = { id, question, url: opts.url ?? '', build: opts.build ?? process.env.BUILD_HASH ?? '', file, at: new Date().toISOString() };
  fs.writeFileSync(path.join(DIR, `${safe}.json`), JSON.stringify(meta, null, 2));
}

const MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => MAP[c]);

export default class HumanReviewReporter implements Reporter {
  private max: number;
  private build: string;
  constructor(o: { maxCards?: number; build?: string } = {}) { this.max = o.maxCards ?? 3; this.build = o.build ?? ''; }
  onBegin() {
    // start clean so old captures never leak into this run's page
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  onEnd() {
    let metas: any[] = [];
    try {
      metas = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
        .sort((a, b) => a.at.localeCompare(b.at));
    } catch { /* no captures */ }
    const warn = metas.length > this.max
      ? `${metas.length} cards, limit is ${this.max}. Cut the sheet: Ray gets at most ${this.max}.` : '';
    if (warn) console.warn(`[human-review] ${warn}`);
    const cards = metas.map((m, i) => {
      const b = m.build || this.build;
      return `<section class="card"><h2>${i + 1}. ${esc(m.question)}</h2>
<img src="human-review/${esc(m.file)}" alt="${esc(m.id)}">
<p class="meta">${esc(m.id)}${b ? ' · build ' + esc(b) : ''}${m.url ? ` · <a href="${esc(m.url)}">open live</a>` : ''}</p></section>`;
    }).join('\n');
    const html = `<!doctype html><meta charset="utf-8"><title>Human review</title>
<style>body{font:15px system-ui;max-width:960px;margin:1rem auto;padding:0 16px}.card{border:1px solid #8884;border-radius:8px;padding:12px;margin:16px 0}
img{max-width:100%;border:1px solid #8884}.meta{color:#666}.warn{background:#fe9;padding:8px;border-radius:6px}</style>
<h1>Human review (${metas.length})</h1>${warn ? `<p class="warn">${esc(warn)}</p>` : ''}
${cards || '<p>No captures this run.</p>'}`;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'human-review.html'), html);
  }
}
