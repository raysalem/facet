import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { ScanService } from './scan.service';
import type { components } from '../api/schema';

export type AddonList = components['schemas']['AddonList'];
export type Addon = components['schemas']['AddonItem'];
export type AddonTokenCreated = components['schemas']['AddonTokenCreated'];
export type AddonLog = components['schemas']['AddonLog'];
/** What any signed-in viewer may know of an add-on: its name, icon and slots. */
export type AddonName = components['schemas']['AddonName'];

/**
 * The client side of the add-on boundary (docs/CONFIGURATION.md, Add-ons): the installed manifests as the server
 * lists them. Manifests are placed on disk by the operator; nothing here can declare or edit one.
 * Offered only where the server would accept the calls: `addons.enabled` (the `addons` feature) and
 * the scan gate (`ScanService.canLaunch`, the same rule as `require_scan_access`).
 */
@Injectable({ providedIn: 'root' })
export class AddonsService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly scan = inject(ScanService);

  readonly list = signal<AddonList | null>(null);
  readonly loadError = signal(false);
  readonly available = computed(() => this.auth.hasFeature('addons') && this.scan.canLaunch());
  /** The installed add-ons' names for a viewer who may not read `list` (B50): object tags and a tab shown off. */
  readonly names = signal<readonly AddonName[] | null>(null);
  private loading: Promise<AddonList | null> | null = null;
  private loadingNames = false;

  /**
   * Keep `list` in step with the right to read it: read once this session may (an edition unlock, a sign-in),
   * dropped when it may no longer (a lock). A page rail calls it whenever `available` changes.
   */
  sync(): void {
    if (!this.available()) {
      if (this.list() !== null) this.list.set(null);
      if (this.names() === null) void this.loadNames();
      return;
    }
    if (this.list() === null && !this.loading) {
      this.loading = this.load().finally(() => { this.loading = null; });
    }
  }

  async load(): Promise<AddonList | null> {
    if (!this.available()) {
      this.list.set(null);
      return null;
    }
    try {
      const list = await firstValueFrom(this.api.get<AddonList>('/addons'));
      this.list.set(list);
      this.loadError.set(false);
      return list;
    } catch {
      this.loadError.set(true);
      return null;
    }
  }

  /** The add-ons' names, readable by any signed-in viewer; kept once read (they change only with a manifest). */
  async loadNames(): Promise<readonly AddonName[] | null> {
    if (this.loadingNames || !this.auth.hasFeature('addons')) return this.names();
    this.loadingNames = true;
    try {
      const read = await firstValueFrom(this.api.get<{ addons: AddonName[] }>('/addons/names'));
      this.names.set(read.addons);
    } catch { /* No names: the ids stand in. */ } finally {
      this.loadingNames = false;
    }
    return this.names();
  }

  async mintToken(id: string): Promise<AddonTokenCreated> {
    const created = await firstValueFrom(this.api.post<AddonTokenCreated>(`/addons/${encodeURIComponent(id)}/token`));
    void this.load();
    return created;
  }

  /** Start a supervised add-on (no panel); the list then shows its live status. */
  async start(id: string): Promise<void> {
    try {
      await firstValueFrom(this.api.post(`/addons/${encodeURIComponent(id)}/start`, {}));
    } finally {
      await this.load();
    }
  }

  async stop(id: string): Promise<void> {
    try {
      await firstValueFrom(this.api.post(`/addons/${encodeURIComponent(id)}/stop`));
    } finally {
      await this.load();
    }
  }

  async log(id: string): Promise<string[]> {
    return (await firstValueFrom(this.api.get<AddonLog>(`/addons/${encodeURIComponent(id)}/log`))).lines;
  }

  async revokeTokens(id: string): Promise<void> {
    await firstValueFrom(this.api.delete(`/addons/${encodeURIComponent(id)}/tokens`));
    await this.load();
  }
}
