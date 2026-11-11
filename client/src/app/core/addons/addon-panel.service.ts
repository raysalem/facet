import { Injectable, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../services/api.service';
import { GalleryStore } from '../../features/gallery/gallery.store';
import type { Addon } from '../services/addons.service';
import type { components } from '../api/schema';
import type { PanelScope } from './addon-bridge';

export type AddonOpened = components['schemas']['AddonOpened'];

export interface OpenPanel {
  addon: Pick<Addon, 'id' | 'name' | 'icon'>;
  nonce: string;
  src: string;
  scope: PanelScope;
}

const WIDTH_KEY = 'facet_addon_panel_width';
export const MIN_PANEL_WIDTH = 280;
export const DEFAULT_PANEL_WIDTH = 380;

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_PANEL_WIDTH ? stored : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

/**
 * The one open add-on sidebar (or none). Opening asks the server for a per-open nonce and the
 * iframe `src`; the server validates the scope. The panel survives navigation: it lives in the shell.
 */
@Injectable({ providedIn: 'root' })
export class AddonPanelService {
  private readonly api = inject(ApiService);
  private readonly gallery = inject(GalleryStore);

  readonly panel = signal<OpenPanel | null>(null);
  readonly openError = signal<string | null>(null);
  readonly width = signal(readWidth());

  async open(addon: Pick<Addon, 'id' | 'name' | 'icon'>, scope: PanelScope): Promise<boolean> {
    this.openError.set(null);
    try {
      const opened = await firstValueFrom(this.api.post<AddonOpened>(
        `/addons/${encodeURIComponent(addon.id)}/open`, { scope }));
      this.adopt(addon, opened);
      return true;
    } catch (err) {
      const detail = err instanceof HttpErrorResponse && typeof err.error?.detail === 'string' ? err.error.detail : null;
      this.openError.set(detail ?? addon.name);
      return false;
    }
  }

  /** The scope "opened by hand": the selection when there is one, else the gallery's current view. */
  currentScope(): PanelScope {
    if (this.gallery.selectionScope() === 'paths' && this.gallery.selectedPaths().size > 0) return { kind: 'selection' };
    const filters = this.gallery.filterPayload() ?? {};
    return { kind: 'view', query: new URLSearchParams(filters).toString().slice(0, 2048) };
  }

  openForCurrentView(addon: Pick<Addon, 'id' | 'name' | 'icon'>): Promise<boolean> {
    return this.open(addon, this.currentScope());
  }

  /** Show a panel the server already opened (the supervisor's start returns one). */
  adopt(addon: Pick<Addon, 'id' | 'name' | 'icon'>, opened: AddonOpened): void {
    // Only ever frame the add-on proxy: the src comes from our own server, but check its shape anyway.
    if (!opened.src.startsWith(`/addons/${addon.id}/`)) throw new Error('Unexpected add-on panel source');
    this.closeQuietly();
    this.panel.set({ addon, nonce: opened.nonce, src: opened.src, scope: opened.scope as PanelScope });
  }

  close(): void {
    this.closeQuietly();
    this.panel.set(null);
  }

  setWidth(width: number, viewport: number): void {
    const clamped = Math.round(Math.min(Math.max(width, MIN_PANEL_WIDTH), Math.max(MIN_PANEL_WIDTH, viewport * 0.8)));
    this.width.set(clamped);
    try { localStorage.setItem(WIDTH_KEY, String(clamped)); } catch { /* a per-viewer nicety only */ }
  }

  private closeQuietly(): void {
    const current = this.panel();
    if (!current) return;
    void firstValueFrom(this.api.post(`/addons/${encodeURIComponent(current.addon.id)}/close`, { nonce: current.nonce }))
      .catch(() => undefined);
  }
}
