import { Injectable, effect, inject, untracked } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../services/api.service';
import { AddonsService, type Addon } from '../services/addons.service';
import { ScanService } from '../services/scan.service';
import { I18nService } from '../services/i18n.service';
import { I18N } from '../i18n/keys';
import { AddonPanelService } from './addon-panel.service';
import type { components } from '../api/schema';

export type AddonRun = components['schemas']['AddonRun'];

/**
 * "Import done. Open X for N photos?": watches the existing scan-status poll, and when a scan this
 * tab sees finish cleanly was started with an add-on requested (an `addon_runs` row), offers to
 * open that add-on's sidebar for the run. The server never starts anything on completion; a run
 * nobody opened stays listed as pending on the Add-ons page.
 */
@Injectable({ providedIn: 'root' })
export class AddonImportNotifier {
  private readonly api = inject(ApiService);
  private readonly addons = inject(AddonsService);
  private readonly scan = inject(ScanService);
  private readonly panels = inject(AddonPanelService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly i18n = inject(I18nService);
  private readonly offered = new Set<string>();

  constructor() {
    effect(() => {
      if (!this.addons.available()) return;
      const status = this.scan.status();
      const jobId = status.job_id;
      if (status.running || status.exit_code !== 0 || !jobId || (status.kind && status.kind !== 'scan')) return;
      untracked(() => void this.offer(jobId));
    });
  }

  /** Offer the run once per tab; a run without an add-on (404) or already opened is skipped. */
  async offer(jobId: string): Promise<void> {
    if (this.offered.has(jobId)) return;
    this.offered.add(jobId);
    let run: AddonRun;
    try {
      run = await firstValueFrom(this.api.get<AddonRun>(`/addons/runs/${encodeURIComponent(jobId)}`));
    } catch {
      return;
    }
    if (run.opened_at) return;
    const list = this.addons.list() ?? await this.addons.load();
    const addon = list?.addons.find(a => a.id === run.addon_id);
    if (!addon) return;
    const ref = this.snackBar.open(
      this.i18n.t(I18N.addons.import_done, { name: addon.name, count: run.photo_count ?? 0 }),
      this.i18n.t(I18N.addons.open), { duration: 30000 });
    ref.onAction().subscribe(() => void this.openRun(addon, jobId));
  }

  openRun(addon: Addon, jobId: string): Promise<boolean> {
    return this.panels.open(addon, { kind: 'import', run_id: jobId });
  }
}
