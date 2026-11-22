# Browser flows (Playwright)

End-to-end flows that drive the real viewer (`viewer.py --production`) in Chrome, step by step,
for paths the unit and component tests cannot see: several clicks in a row, the service worker's
thumbnail cache, what the gallery shows after a server-side change. See #464.

## Run

```bash
cd client
npm ci
npx ng build                     # the flows test the production build
FACET_E2E_PYTHON=../venv/bin/python npm run e2e
```

- **Browser:** the installed Chrome (`channel: 'chrome'`), so nothing is downloaded. Set
  `FACET_E2E_CHANNEL=chromium` after `npx playwright install chromium` to use Playwright's own.
- **Python:** `FACET_E2E_PYTHON` is the interpreter with Facet's dependencies (default `python`).
- **Port:** 5099 (`FACET_E2E_PORT`); the seeded external add-on's own page is served on 5100 (`FACET_E2E_ADDON_PORT`).
- **Node:** the Angular CLI and Playwright need Node 24.15 or newer (or 22.22.3+).
- Not part of `npm run test` (that is `ng test`, the Vitest unit suite).

## What a run does

1. `seed_library.py serve` rebuilds `e2e/.work/`. It writes a config with an edition password,
   a database made by `db.schema.init_database`, and a library of synthetic solid-colour photos
   whose rows are written directly. There are no models and no scan, so the seed takes about a
   second. It then starts the viewer on that library.
2. Each flow in `flows/` owns one folder of the library. A flow that changes its folder first restores
   it (`seed_library.py reset <folder>`), so the flows run in any order and survive `--repeat-each`.
   A photo a flow deletes goes to `e2e/.work/xdg-data/Trash`, never to your own Trash.
3. `fixtures.ts` fails a flow on any page error, `console.error` or 4xx/5xx response, even when the
   assertions pass (the 4xx/5xx half is the kit's `attachNetworkGate`, which names the URL).
4. Each flow calls `expectCleanUI` at its key states (see Helpers). After the run,
   `test-results/human-review.html` lists the (at most 3) screens a person has to judge.

## When a flow fails

- `npx playwright show-trace test-results/<flow>/trace.zip` shows the page before and after
  every step, with the network calls and the console.
- `playwright-report/index.html` holds the run, with the screenshot of each failure (video is off: it would
  need Playwright's ffmpeg download).

## Writing a flow

- Sign in as an editor (`signInAsEditor`) when the journey needs the add-on rail or add-on names; leave it
  anonymous otherwise.
- One spec per user journey, with numbered `test.step`s, so a failure names its step.
- Select by role and accessible name (`getByRole('button', { name: … })`), never by CSS classes.
- No fixed sleeps: use `expect` (which retries) or wait for a response.
- Keep the service worker on (the default here). A stale-cache bug only shows with it.
- To check that the right picture is on screen, sample a pixel (`centrePixel`) rather than
  trusting the `src`.
- A flow for a fixed bug must fail with that fix removed. Check it once by hand.

| Flow | Checks |
|---|---|
| `01-ai-edit-burst-strip` | The gallery shows a burst once, as its leading AI edit; the original's strip labels the edit "AI edit" and opens it |
| `02-hide-bursts` | Hide bursts folds each burst behind its lead; Show all brings every frame back |
| `03-reused-name-new-picture` | An edit imported under a deleted edit's name shows the new picture, not the cached thumbnail (fails without `apply_ai_edit_captions`' fresh `preview_revision`) |
| `04-delete-burst-lead` | Deleting the AI edit that leads its burst keeps the burst in the gallery (fails without `_reassign_dead_burst_leads`) |
| `05-album-switch` | Opening an album on a slow network (its config and album reads held 1.5 s each) never shows a card of the view shown before it, the plain gallery or another album (fails without the clear at the start of `GalleryComponent`'s fresh visit) |
| `06-app-update` | A new app build is applied by itself; it waits behind the banner while a field has focus or holds unused text, and while an add-on panel is open (focus inside its frame), and lands once they are left. Build 2..5 are the served shell re-marked, with its hash updated in `ngsw.json` |
| `07-layout-geometry` | Measured geometry, not classes: with Showing open (1280, 1600 px) the grid and the panel's list are the only scrollers (B44), also on the photo page; the floating hover card is at most 640 px, its tags and people each one line ending in `+N`, and no line (capture line, caption, tags, people) is wider than its picture (U5, B38/B43). Then the probe's page-wide checks on the album and the photo page at 1180x880, 1480x1100, 2950x1100, 390x844 and dark at 1480 and 390; content widths are recorded as `content-width` annotations, not asserted |
| `08-showing-tab` | The rail's Showing panel names the album; Set -> lunch narrows the grid to its 3 photos and shows the chip; another album, entered inside the app, has no chip and Showing names it (U7, I8) |
| `09-tag-kinds` | The photo page's Content panel lists Tags, People tags, Object tags (folded), Album tags (folded, last), in that order; album and object tags never sit among Tags; the hover card shows tags, people and object tags one line each and no album tags (U4, U6) |
| `10-narrow` | At 1024 (the rail), 1023 and 390 px: no gallery rail below lg, Filters opens and closes as a drawer, the photo page tabs are a column from lg and a row below, Content keeps its order, no sideways scroll (U13, I3). lg is Tailwind's 1024 px, so 1023 is the last width without the rail |

## Helpers (`helpers/`)

- `ui-probe.js`, `ui-probe.helpers.ts`, `human-review-reporter.ts` are the shared kit (`dev-notes/_shared`),
  copied. One local change: `expectCleanUI` skips the entries of `known-findings.ts` (exact rule + selector).
- `expectCleanUI(page, { label, panes })` runs the probe: raw i18n keys (I5), horizontal page scroll (I3),
  floating cards wider than 640 px or the viewport (I4), alerts outside the viewport (I7), `hidden` but shown
  (I1), and at most one vertical scroller per pane (I2). `panes` are selectors whose scrollers are counted
  separately: pass `['[data-gallery-panel="filter"]']` with the Showing panel open, `['[data-photo-inspector]']` on the photo page's
  panel; without `panes` the whole page may have one. Fix a false positive with `panes`, never by editing `ui-probe.js`.
- `known-findings.ts`: findings the probe reports that a person has not triaged yet (`kind: 'finding'`) and probe
  misreadings no `panes` choice can express (`'false-positive'`). Each skips by exact rule + selector. Delete an entry
  when its cause is fixed; a new offender still fails.
- `captureForHuman(page, id, question)` saves a screenshot for the human-review page (exactly three flows use it:
  09 Content, 09 hover card, 08 Set chip). `nav.ts` holds the shared steps: `signInAsEditor`, `useTheme`, `openAlbum`,
  `openShowing`, `useHoverCard`, `recordContentWidth`, `expectTagKindOrder`, `photoTabsLayout`.

## Widths

Ray's display is 2954x1231 CSS px. The flows use 1180x880 (his window), 1480x1100 (half), 2950x1100 (maximised),
390x844 (phone); `WIDTHS` in `helpers/nav.ts`. The default viewport is 1480x1100. Layout choices (`lg` = 1024 px) are tested at
1024 and 1023 in `10-narrow`.
