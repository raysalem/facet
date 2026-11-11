import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Subject, of, throwError } from 'rxjs';
import { AddonImportNotifier, type AddonRun } from './addon-import-notifier.service';
import { AddonPanelService } from './addon-panel.service';
import { ApiService } from '../services/api.service';
import { AddonsService, type AddonList } from '../services/addons.service';
import { ScanService, type ScanStatus } from '../services/scan.service';
import { I18nService } from '../services/i18n.service';

const JOB = 'a'.repeat(32);

describe('after-import add-on notice', () => {
  const status = signal<ScanStatus>({ running: true, directories: [], output: [], elapsed_seconds: 1, exit_code: null, job_id: JOB, kind: 'scan' });
  const available = signal(true);
  const action = new Subject<void>();
  let get: ReturnType<typeof vi.fn>;
  let snack: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  let run: AddonRun;

  beforeEach(() => {
    status.set({ running: true, directories: [], output: [], elapsed_seconds: 1, exit_code: null, job_id: JOB, kind: 'scan' });
    available.set(true);
    run = { job_id: JOB, addon_id: 'astro', photo_count: 12, opened_at: null } as AddonRun;
    get = vi.fn(() => of(run));
    snack = vi.fn(() => ({ onAction: () => action }));
    open = vi.fn(async () => true);
    const list = signal<AddonList | null>({ addons_dir: '/d', refused: [], addons: [
      { id: 'astro', name: 'Astro', icon: 'star', slots: ['sidebar', 'import_hook'] }] } as unknown as AddonList);
    TestBed.configureTestingModule({ providers: [
      { provide: ApiService, useValue: { get } },
      { provide: AddonsService, useValue: { available, list, load: vi.fn(async () => list()) } },
      { provide: ScanService, useValue: { status } },
      { provide: AddonPanelService, useValue: { open } },
      { provide: MatSnackBar, useValue: { open: snack } },
      { provide: I18nService, useValue: { t: (key: string, p?: Record<string, unknown>) => key + (p ? ' ' + Object.values(p).join(' ') : '') } },
    ] });
    TestBed.inject(AddonImportNotifier);
    TestBed.tick();
  });

  async function finish(exitCode = 0) {
    status.set({ ...status(), running: false, exit_code: exitCode });
    TestBed.tick();
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve();
  }

  it('offers the requested add-on once the scan finishes cleanly, and opens the import scope', async () => {
    expect(get).not.toHaveBeenCalled();
    await finish();
    expect(get).toHaveBeenCalledWith(`/addons/runs/${JOB}`);
    await vi.waitFor(() => expect(snack).toHaveBeenCalledWith('addons.import_done Astro 12', 'addons.open', expect.anything()));
    action.next();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'astro' }), { kind: 'import', run_id: JOB });
  });

  it('asks once per run, and stays quiet for a run without an add-on or one already opened', async () => {
    get.mockReturnValueOnce(throwError(() => ({ status: 404 })));
    await finish();
    expect(snack).not.toHaveBeenCalled();
    status.set({ ...status(), elapsed_seconds: 2 });
    TestBed.tick();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a failed scan or when add-ons are unavailable', () => {
    status.set({ ...status(), running: false, exit_code: 1 });
    TestBed.tick();
    available.set(false);
    status.set({ ...status(), exit_code: 0 });
    TestBed.tick();
    expect(get).not.toHaveBeenCalled();
  });
});
