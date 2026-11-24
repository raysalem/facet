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
   assertions pass (the 4xx/5xx half is the kit's `attachNetworkGate`, which names the URL; a flow that
   provokes a 4xx on purpose declares it with `expectFailedLoad`).
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
| `05-route-smoke` | Each top-level page (`/albums`, `/capsules`, `/compare`, `/culling`, `/folders`, `/junk`, `/map`, `/persons`, `/scenes`, `/stats`, `/timeline`) loads on its own URL with no page error, console error or 5xx; a direct load of `/addons`, `/stats`, `/persons`, `/albums` and `/timeline` shows the same top tabs as the gallery, locked and unlocked (fails without the config load after the auth status in `App.ngOnInit`, B51) |
| `06-app-update` | A new app build is applied by itself; it waits behind the banner while a field has focus or holds unused text, and while an add-on panel is open (focus inside its frame), and lands once they are left. Build 2..5 are the served shell re-marked, with its hash updated in `ngsw.json` |
| `06-photo-page` | A double click on a gallery card opens that photo's page; the Quality panel carries the seeded score, the Histogram tab swaps the panel, and Back returns to the gallery |
| `07-album-lifecycle` | An album made through the API lists on `/albums`, opens to its photo, and leaves `/albums` once deleted while its photo stays in the library |
| `07-layout-geometry` | Measured geometry, not classes: with Showing open (1280, 1600 px) the grid and the panel's list are the only scrollers (B44), also on the photo page; the floating hover card is at most 640 px, its tags and people each one line ending in `+N`, and no line (capture line, caption, tags, people) is wider than its picture (U5, B38/B43). Then the probe's page-wide checks on the album and the photo page at 1180x880, 1480x1100, 2950x1100, 390x844 and dark at 1480 and 390; content widths are recorded as `content-width` annotations, not asserted |
| `08-edition-gate` | Without the edition password a delete and an album create are refused, a wrong password is refused, and no photo is deleted |
| `08-showing-tab` | The rail's Showing panel names the album; Set -> lunch narrows the grid to its 3 photos and shows the chip; another album, entered inside the app, has no chip and Showing names it (U7, I8); a reload of the album with Showing open moves nothing (CLS < 0.05 at 1180 and 1480, B49) |
| `09-gallery-sort-filter` | The gallery orders by score, flips on Ascending, and narrows by camera and by a minimum score; removing the chip restores the folder |
| `09-tag-kinds` | The photo page's Content panel lists Tags, People tags, Object tags (folded), Album tags (folded, last), in that order; album and object tags never sit among Tags; the hover card shows tags, people and object tags one line each and no album tags (U4, U6) |
| `10-gallery-search` | A caption word narrows the grid to its photo, survives a reload, and clearing it restores the folder |
| `10-narrow` | At 1023 and 640 (the side rail), 639 and 390 px: no gallery rail below sm (a phone's bottom sheet), Filters opens and closes as a drawer there, the photo page tabs are a column from sm and a row below, Content keeps its order, Hide panel and a tab bring the panel back, no sideways scroll (U13, I3). sm is Tailwind's 640 px, so 639 is the last width without the rail |
| `11-gallery-select-and-rate` | Review > Favorite and Review > Rate 4 in the selection bar apply to both selected photos; the favourites filter and the photo page read them back |
| `12-culling-confirm` | `/culling` proposes a keeper per burst; flipping a frame to kept and confirming rejects only the frame left out, and the gallery hides it |
| `13-login-ui` | The Edition dialog refuses a wrong password in place and unlocks with the right one; unlocked state survives a reload |
| `14-photo-page-review` | Rating, Favorite and Keep set on the photo page are read back after a reload; unlocked on the Grade panel at 1180, 1480 and 2950 px, the header's Previous, Next and Hide panel take their own clicks (centre and lower edge), the review strip starts below the header, and Next steps to the next photo (fails with the strip pulled up over the header, B52) |
| `15-photo-compare` | Two selected photos open the compare workspace (Reference / Candidate), the candidate can be promoted, and the page redirects without a selection |
| `16-timeline-and-folders` | The timeline month counts the day's photos and links to them; the Folders page filters the gallery to the clicked folder |
| `17-photo-page-metadata` | A caption, a manual tag and a one-hour capture-date shift made on the photo page are still shown after a reload |
| `18-add-to-new-album` | Add to Album > New Album from the selection bar creates the album with the selected photo only; deleting the album keeps the photo |
| `19-delete-selection` | Delete… in the selection bar: Cancel keeps both photos, confirming removes only the selected one |
| `20-persons` | The seeded person is listed, an in-place rename survives a reload, and View photos opens the gallery on that person's two photos |
| `21-map` | The two GPS photos give two single-photo markers (the third has no GPS); a marker opens a popup that closes |
| `22-shared-album` | A shared album opens by its link with no login, a wrong token is refused, and unsharing kills the old link |
| `23-scan-launcher` | The scan launcher (behind `features.show_scan_button`) offers the library folder, already chosen; no scan is started |
| `24-customize-shortcuts` | Rebinding Toggle favorite to G survives a reload; Reset all restores F |
| `25-connect-assistant` | A named assistant token is created (its prompt shown once), listed under Manage tokens and revoked |
| `26-download-selection` | Download saves each selected original; Copy filenames puts their names on the clipboard |
| `27-display-settings` | The Fast scrolling switch in Display persists across a reload |
| `28-portfolio-export` | Export portfolio waits for a target folder (allow-listed in the seed config) and writes the album's static site there |
| `29-capsules-date-range` | Setting and clearing the last date filter reloads the capsule grid with page 1 and no stale date parameter |
| `30-photo-details-panels` | A pre-split saved setting shows as Details location: Card + Details mode: Click and behaves so; Off hides the mode row; the location menu reads Side panel, Card, Off and the mode menu Hover, Click; the Showing and details panels and the photo page inspector resize by their inner edge and keep the width |
| `31-details-clicking` | Ray's clicking (B53): after a click on a photo whose card the opening panel moves, and after a click with Showing open (also after a reload), the side panel shows the clicked photo; then five seeded random runs of 30 steps (Details location / mode changes, clicks on the same and other photos, hovers, Escape, Hide / Show panel, Filters, reloads) assert it after every click (fails with either half of the fix removed). Every panel hides to the rail and comes back with one click, remembered across a reload; at 640, 800, 1024, 1180, 1480 and 2950 px the details panel, Showing and the photo page inspector sit beside the content with no page scrollbar; a phone keeps the bottom sheet and Panel on phone: Side puts the rail and panel at the side; the add-on dock is still a drawer at 390 (#391) |

Not covered yet: merge suggestions and the other persons tabs (the unnamed seed cluster does not reach "Needs naming"),
starting a scan (it would run the scoring models), the library export, and settings beyond the Display switches.

The edition login route allows 5 attempts a minute per address, so flows reuse one token (`editionToken` caches it,
`unlockEdition` hands it to the page) and only `13-login-ui` and `08-edition-gate` type or send a password. A flow that
provokes a 4xx on purpose declares it with `expectFailedLoad`.

CI runs the suite as the `Browser flows (Playwright)` job: the CI Python dependencies (no torch), the production build
and Playwright's own Chromium (`FACET_E2E_CHANNEL=chromium`). It is not a required check; a failed run uploads
`client/test-results` and `client/playwright-report` as the `e2e-failures` artifact.

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
