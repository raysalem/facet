import { Injectable, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../services/api.service';
import { GalleryStore } from '../../features/gallery/gallery.store';
import type { Addon } from '../services/addons.service';
import type { components } from '../api/schema';
import type { PanelScope } from './addon-bridge';

export type AddonOpened = components['schemas']['AddonOpened'];
export type AddonStarted = components['schemas']['AddonStarted'];
type PanelAddon = Pick<Addon, 'id' | 'name' | 'icon'> & Partial<Pick<Addon, 'mode'>>;

export interface OpenPanel {
  addon: PanelAddon;
  nonce: string;
  src: string;
  scope: PanelScope;
  /** A supervised add-on that did not start: the sidebar shows why and the last log lines. */
  failure?: { error: string | null; log: string };
}

const WIDTH_KEY = 'facet_addon_panel_width';
/** The open panel's add-on and scope, kept for this tab only, so a reload (F5) can open it again. */
export const OPEN_PANEL_KEY = 'facet_addon_panel_open';

/** What a reload needs to open the panel again. */
export interface RestorablePanel { addonId: string; scope: PanelScope }
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
  /**
   * A page that shows its own panels in the dock's place (the photo page's rail) hides the dock at `lg`
   * and up while one of those is shown. The frame stays mounted, so the add-on keeps its state.
   */
  readonly dockHidden = signal(false);
  /**
   * Whether the open add-on is the panel the user is looking at, so a page built later (photo to gallery,
   * back from the Add-ons page) starts on the add-on's tab instead of hiding it. An open sets it; a rail
   * that picks one of its own panels, or closes them all, clears it.
   */
  readonly addonShown = signal(false);

  private restoring = false;

  /** The panel that was open in this tab before a reload, if any. */
  restorable(): RestorablePanel | null {
    try {
      const raw = JSON.parse(sessionStorage.getItem(OPEN_PANEL_KEY) ?? 'null') as RestorablePanel | null;
      return raw && typeof raw.addonId === 'string' && raw.scope && typeof raw.scope.kind === 'string' ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * Open again the panel this tab had open before a reload, with the scope it had (the server checks it again).
   * Once only, and quietly: a refusal (rights changed, add-on gone) forgets it instead of showing an error.
   */
  async restore(addon: PanelAddon): Promise<boolean> {
    const saved = this.restorable();
    if (this.restoring || this.panel() || !saved || saved.addonId !== addon.id) return false;
    this.restoring = true;
    try {
      const opened = await this.open(addon, saved.scope);
      if (!opened) {
        this.openError.set(null);
        this.forget();
      }
      return opened;
    } finally {
      this.restoring = false;
    }
  }

  async open(addon: PanelAddon, scope: PanelScope): Promise<boolean> {
    this.openError.set(null);
    if (addon.mode === 'supervised') return this.startAndOpen(addon, scope);
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

  /** A supervised add-on: start it if needed (Facet runs it), then open its panel in one call. */
  private async startAndOpen(addon: PanelAddon, scope: PanelScope): Promise<boolean> {
    try {
      const started = await firstValueFrom(this.api.post<AddonStarted>(
        `/addons/${encodeURIComponent(addon.id)}/start`, { scope }));
      if (!started.opened) throw new Error('No panel was opened');
      this.adopt(addon, started.opened);
      return true;
    } catch (err) {
      const detail = err instanceof HttpErrorResponse ? err.error?.detail : null;
      if (detail && typeof detail === 'object' && 'status' in detail) {
        // It did not start: show that in the sidebar, with the log tail the server sent.
        this.closeQuietly();
        this.addonShown.set(true);
        this.panel.set({ addon, nonce: '', src: '', scope,
          failure: { error: typeof detail.error === 'string' ? detail.error : null,
            log: Array.isArray(detail.log_tail) ? detail.log_tail.filter((l: unknown) => typeof l === 'string').join('\n') : '' } });
        return false;
      }
      this.openError.set(typeof detail === 'string' ? detail : addon.name);
      return false;
    }
  }

  /** The scope "opened by hand": the selection when there is one, else the gallery's current view. */
  currentScope(): PanelScope {
    if (this.gallery.selectionScope() === 'paths' && this.gallery.selectedPaths().size > 0) return { kind: 'selection' };
    const filters = this.gallery.filterPayload() ?? {};
    return { kind: 'view', query: new URLSearchParams(filters).toString().slice(0, 2048) };
  }

  openForCurrentView(addon: PanelAddon): Promise<boolean> {
    return this.open(addon, this.currentScope());
  }

  /** Show a panel the server already opened (the supervisor's start returns one). */
  adopt(addon: PanelAddon, opened: AddonOpened): void {
    // Only ever frame the add-on proxy: the src comes from our own server, but check its shape anyway.
    if (!opened.src.startsWith(`/addons/${addon.id}/`)) throw new Error('Unexpected add-on panel source');
    this.closeQuietly();
    this.addonShown.set(true);
    this.panel.set({ addon, nonce: opened.nonce, src: opened.src, scope: opened.scope as PanelScope });
    try {
      sessionStorage.setItem(OPEN_PANEL_KEY, JSON.stringify({ addonId: addon.id, scope: opened.scope as PanelScope } satisfies RestorablePanel));
    } catch { /* Storage blocked: a reload leaves the panel closed. */ }
  }

  close(): void {
    this.closeQuietly();
    this.addonShown.set(false);
    this.panel.set(null);
    this.forget();
  }

  private forget(): void {
    try { sessionStorage.removeItem(OPEN_PANEL_KEY); } catch { /* nothing kept */ }
  }

  setWidth(width: number, viewport: number): void {
    const clamped = Math.round(Math.min(Math.max(width, MIN_PANEL_WIDTH), Math.max(MIN_PANEL_WIDTH, viewport * 0.8)));
    this.width.set(clamped);
    try { localStorage.setItem(WIDTH_KEY, String(clamped)); } catch { /* a per-viewer nicety only */ }
  }

  private closeQuietly(): void {
    const current = this.panel();
    if (!current || !current.nonce) return;
    void firstValueFrom(this.api.post(`/addons/${encodeURIComponent(current.addon.id)}/close`, { nonce: current.nonce }))
      .catch(() => undefined);
  }
}
