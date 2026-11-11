import { signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { AddonsPageComponent } from './addons-page.component';
import { AddonsService, type AddonList } from '../../core/services/addons.service';
import { I18nService } from '../../core/services/i18n.service';
import { AddonPanelService } from '../../core/addons/addon-panel.service';
import { AddonImportNotifier } from '../../core/addons/addon-import-notifier.service';

function listing(): AddonList {
  return {
    addons_dir: 'C:/Facet/data/addons',
    addons: [
      { id: 'astro', name: 'Astro', version: '0.3.0', icon: 'star', facet_api: 1, slots: ['sidebar'],
        permissions: ['photos.read', 'gps.write'], mode: 'external', ui_path: '/', status: 'external', live_tokens: 0 },
      { id: 'local', name: 'Local', version: '1', icon: 'extension', facet_api: 1, slots: ['sidebar'],
        permissions: ['photos.read'], mode: 'supervised', ui_path: '/ui/', status: 'stopped', live_tokens: 0 },
    ],
    refused: [{ directory: 'broken', reason: 'unknown permissions: db.write' }],
    pending_runs: [{ job_id: 'f'.repeat(32), addon_id: 'astro', run_id: 41, photo_count: 9 }],
  } as AddonList;
}

describe('Add-ons page', () => {
  let fixture: ComponentFixture<AddonsPageComponent>;
  let root: HTMLElement;
  const list = signal<AddonList | null>(null);
  const loadError = signal(false);
  let load: ReturnType<typeof vi.fn>;
  let mintToken: ReturnType<typeof vi.fn>;
  let revokeTokens: ReturnType<typeof vi.fn>;
  let openForCurrentView: ReturnType<typeof vi.fn>;
  const openError = signal<string | null>(null);
  let openRun: ReturnType<typeof vi.fn>;
  let start: ReturnType<typeof vi.fn>;
  let stop: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    list.set(null); loadError.set(false);
    load = vi.fn(async () => { list.set(listing()); return list(); });
    mintToken = vi.fn(async (id: string) => ({ id: 7, addon_id: id, level: 'edition', token: 'fct_secret', scopes: [] }));
    revokeTokens = vi.fn(async () => undefined);
    openForCurrentView = vi.fn(async () => true);
    openError.set(null);
    openRun = vi.fn(async () => true);
    start = vi.fn(async () => undefined);
    stop = vi.fn(async () => undefined);
    log = vi.fn(async () => ['line one', 'line two']);
    TestBed.configureTestingModule({ imports: [AddonsPageComponent], providers: [
      { provide: AddonsService, useValue: { list, loadError, load, mintToken, revokeTokens, start, stop, log } },
      { provide: AddonPanelService, useValue: { openForCurrentView, openError } },
      { provide: AddonImportNotifier, useValue: { openRun } },
      { provide: I18nService, useValue: { t: (key: string, params?: Record<string, unknown>) => key + (params ? ' ' + Object.values(params).join(' ') : ''), translations: signal({}), currentLang: signal('en') } },
    ] });
    fixture = TestBed.createComponent(AddonsPageComponent);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  async function settle() { await Promise.resolve(); await Promise.resolve(); fixture.detectChanges(); }

  it('lists the installed add-ons, their permissions and the refused manifests with the reason', async () => {
    await settle();
    expect(load).toHaveBeenCalled();
    expect(root.querySelector('[data-addons-dir]')?.textContent).toContain('C:/Facet/data/addons');
    expect(root.querySelectorAll('[data-addon]')).toHaveLength(2);
    expect(root.querySelector('[data-addon="astro"]')?.textContent).toContain('addons.permission.gps.write');
    expect(root.querySelector('[data-addon="local"] [data-addon-status]')?.textContent).toContain('addons.status.stopped');
    expect(root.querySelector('[data-addons-refused]')?.textContent).toContain('unknown permissions: db.write');
  });

  it('offers a one-time token only for an external add-on and shows it once', async () => {
    await settle();
    expect(root.querySelector('[data-addon="local"] [data-addon-mint]')).toBeNull();
    (root.querySelector('[data-addon="astro"] [data-addon-mint]') as HTMLButtonElement).click();
    await settle();
    expect(mintToken).toHaveBeenCalledWith('astro');
    expect(root.querySelector('[data-addon="astro"] [data-addon-token]')?.textContent).toBe('fct_secret');
  });

  it('shows an alert when the token cannot be minted', async () => {
    await settle();
    mintToken.mockRejectedValueOnce(new Error('403'));
    (root.querySelector('[data-addon-mint]') as HTMLButtonElement).click();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('addons.token.error');
  });

  it('opens a sidebar add-on for the current view and shows why it could not', async () => {
    await settle();
    (root.querySelector('[data-addon="astro"] [data-addon-open]') as HTMLButtonElement).click();
    expect(openForCurrentView).toHaveBeenCalledWith(expect.objectContaining({ id: 'astro' }));
    openError.set('The add-on is not running');
    fixture.detectChanges();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('The add-on is not running');
  });

  it('lists after-import runs nobody opened and opens one with its import scope', async () => {
    await settle();
    const row = root.querySelector('[data-pending-run]')!;
    expect(row.textContent).toContain('addons.pending_run 41 9');
    (row.querySelector('[data-pending-open]') as HTMLButtonElement).click();
    await settle();
    expect(openRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'astro' }), 'f'.repeat(32));
  });

  it('starts and stops a supervised add-on and shows its log', async () => {
    await settle();
    expect(root.querySelector('[data-addon="astro"] [data-addon-start]')).toBeNull();
    (root.querySelector('[data-addon="local"] [data-addon-start]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('local'));
    expect(start).toHaveBeenCalledWith('local');
    fixture.detectChanges();
    expect(root.querySelector('[data-addon="local"] [data-addon-log] pre')?.textContent).toContain('line one\nline two');
    const running = listing();
    running.addons[1] = { ...running.addons[1], status: 'running' };
    list.set(running);
    fixture.detectChanges();
    (root.querySelector('[data-addon="local"] [data-addon-stop]') as HTMLButtonElement).click();
    await settle();
    expect(stop).toHaveBeenCalledWith('local');
  });

  it('shows why a supervised add-on failed and its exit code', async () => {
    await settle();
    const failed = listing();
    failed.addons[1] = { ...failed.addons[1], status: 'failed', exit_code: 2, error: 'did not answer its health check in time' };
    list.set(failed);
    fixture.detectChanges();
    expect(root.querySelector('[data-addon="local"] [data-addon-error]')?.textContent).toContain('health check');
    expect(root.querySelector('[data-addon="local"] [data-addon-exit]')?.textContent).toContain('addons.exit_code 2');
    expect((root.querySelector('[data-addon="local"] [data-addon-log]') as HTMLDetailsElement).open).toBe(true);
  });

  it('says so when nothing is installed', async () => {
    load.mockImplementationOnce(async () => { list.set({ addons_dir: '/d', addons: [], refused: [] } as AddonList); return list(); });
    fixture.componentInstance.ngOnInit();
    await settle();
    expect(root.querySelector('[data-addons-empty]')).not.toBeNull();
  });
});
