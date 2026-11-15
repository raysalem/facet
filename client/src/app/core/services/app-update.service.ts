import { DestroyRef, inject, Injectable, InjectionToken } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarRef, TextOnlySnackBar } from '@angular/material/snack-bar';
import { NavigationStart, Router } from '@angular/router';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import { AddonPanelService } from '../addons/addon-panel.service';
import { I18N } from '../i18n/keys';
import { I18nService } from './i18n.service';

/** Reloads the page. Injectable so specs can observe it instead of reloading the test runner. */
export const PAGE_RELOAD = new InjectionToken<() => void>('PAGE_RELOAD', {
  providedIn: 'root',
  factory: () => () => location.reload(),
});

/** How often an open tab asks the server whether a newer build exists. */
export const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** How often a deferred reload re-tests whether the page has become idle. */
export const IDLE_RECHECK_INTERVAL_MS = 5 * 1000;
/** An unrecoverable-state reload is not repeated inside this window. */
export const UNRECOVERABLE_RELOAD_WINDOW_MS = 60 * 1000;

const GUARD_KEY = 'facet_sw_reload';
const UNRECOVERABLE_MARKER = 'unrecoverable';

/**
 * Applies a new app build as soon as the service worker has it.
 *
 * The service worker serves the cached shell, so after a server upgrade the browser keeps
 * running the old bundle (even through F5 / Ctrl+F5) until the user happens to click the
 * "new version" snackbar, and that old bundle runs against the new server: renamed
 * translation keys show as raw text. This service finds the update early (at startup, when
 * the tab becomes visible, and on a timer), then activates it and reloads on its own, but
 * only when that cannot lose the user's work: it waits while a dialog or an overlay is open
 * an editable field has focus or holds typed text, or the page is fullscreen (the snackbar stays as the manual path), and a
 * `sessionStorage` marker stops it from ever reloading twice for the same build.
 *
 * The new version is activated only at reload time, not when it is detected. Activating
 * while the old page keeps running would serve its lazy chunks from the new build's
 * hashes, which the old bundle does not know about.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly swUpdate = inject(SwUpdate, { optional: true });
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly i18n = inject(I18nService);
  private readonly reloadPage = inject(PAGE_RELOAD);
  private readonly addonPanel = inject(AddonPanelService);
  private readonly router = inject(Router, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  /** Text fields the user has typed into since the last submit or navigation. */
  private readonly edited = new Set<HTMLElement>();
  private started = false;
  /** Hash of the build waiting for the page to go idle, if any. */
  private pendingHash: string | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private banner: MatSnackBarRef<TextOnlySnackBar> | null = null;

  /** Begin watching for updates. Safe to call more than once; a no-op without a service worker. */
  start(): void {
    const sw = this.swUpdate;
    if (this.started || !sw?.isEnabled) return;
    this.started = true;

    const subs = [
      sw.versionUpdates
        .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(e => this.onVersionReady(e.latestVersion?.hash ?? 'unknown')),
      sw.unrecoverable.subscribe(() => this.onUnrecoverable()),
    ];

    const onVisibility = () => {
      if (document.visibilityState === 'visible') this.checkNow();
      else if (this.pendingHash !== null) this.tryApplyPending();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const checkTimer = setInterval(() => this.checkNow(), UPDATE_CHECK_INTERVAL_MS);

    // Typed text counts as work even after the field loses focus. Capture phase sees every
    // field; a submit or a route change means the text was used or left behind.
    const onInput = (e: Event) => {
      if (e.target instanceof HTMLElement && AppUpdateService.isTextLike(e.target)) this.edited.add(e.target);
    };
    const clearEdited = () => this.edited.clear();
    document.addEventListener('input', onInput, true);
    document.addEventListener('submit', clearEdited, true);
    const navSub = this.router?.events.pipe(filter(e => e instanceof NavigationStart)).subscribe(clearEdited);

    this.destroyRef.onDestroy(() => {
      subs.forEach(s => s.unsubscribe());
      navSub?.unsubscribe();
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('submit', clearEdited, true);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(checkTimer);
      this.clearIdleTimer();
    });

    this.checkNow();
  }

  /** Ask the service worker to look for a newer build; failures (offline, no worker yet) are ignored. */
  private checkNow(): void {
    this.swUpdate?.checkForUpdate().catch(() => undefined);
  }

  /**
   * Whether reloading now could discard something the user is doing: a dialog or an overlay
   * with a backdrop (open menu, select panel) is up, an add-on panel is open, an editable field has focus, a field
   * holds text typed since the last submit or navigation (even unfocused), or the page is
   * fullscreen or playing a slideshow.
   *
   * The idle recheck notices the panel closing within IDLE_RECHECK_INTERVAL_MS and reloads then.
   *
   * Not covered, on purpose: scans and exports run as server jobs that a reload does not
   * stop, and the client has no upload flow, so there is no in-page work to lose there.
   */
  isBusy(): boolean {
    if (this.dialog.openDialogs?.length) return true;
    if (document.querySelector('.cdk-overlay-container .cdk-overlay-backdrop')) return true;
    if (document.fullscreenElement || document.querySelector('app-slideshow')) return true;
    // An add-on session (a finished plate solve not yet saved) lives in a sandboxed iframe a reload destroys.
    if (this.addonPanel.panel()) return true;
    if (this.hasUnsavedText()) return true;
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'INPUT' && AppUpdateService.isTextLike(el);
  }

  /** A field the user edited still holds text. Cost is the number of fields typed into, not the DOM size. */
  private hasUnsavedText(): boolean {
    for (const el of this.edited) {
      if (!el.isConnected) { this.edited.delete(el); continue; }
      const value = el.isContentEditable ? el.textContent : (el as HTMLInputElement | HTMLTextAreaElement).value;
      if (value) return true;
    }
    return false;
  }

  /** Text, search, number, ... inputs, textareas and contenteditable hosts; not buttons, checkboxes and the like. */
  private static isTextLike(el: HTMLElement): boolean {
    if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT'
      && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'image', 'file', 'color'].includes((el as HTMLInputElement).type);
  }

  private onVersionReady(hash: string): void {
    if (this.alreadyReloadedFor(hash)) {
      // The page we just reloaded into is still being told a newer build is ready: do not
      // loop, hand the decision to the user.
      this.showBanner(hash, false);
      return;
    }
    this.pendingHash = hash;
    if (this.isBusy()) {
      this.showBanner(hash, true);
      this.startIdleTimer();
    } else {
      void this.applyAndReload(hash);
    }
  }

  private onUnrecoverable(): void {
    // The worker's cache is corrupt: nothing is gained by waiting, but a reload that does
    // not cure it must not repeat in a tight loop.
    if (this.alreadyReloadedFor(UNRECOVERABLE_MARKER)) {
      this.showBanner(UNRECOVERABLE_MARKER, false);
      return;
    }
    if (!this.markReloaded(UNRECOVERABLE_MARKER)) {
      this.showBanner(UNRECOVERABLE_MARKER, false);
      return;
    }
    this.reloadPage();
  }

  private tryApplyPending(): void {
    if (this.pendingHash === null || this.isBusy()) return;
    void this.applyAndReload(this.pendingHash);
  }

  private startIdleTimer(): void {
    if (this.idleTimer !== null) return;
    this.idleTimer = setInterval(() => this.tryApplyPending(), IDLE_RECHECK_INTERVAL_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /** Activate the new build, record that we reloaded for it, then reload. */
  private async applyAndReload(hash: string): Promise<void> {
    this.clearIdleTimer();
    this.pendingHash = null;
    try {
      await this.swUpdate?.activateUpdate();
    } catch {
      // Activation failing still leaves a reload as the best remaining move.
    }
    if (!this.markReloaded(hash)) {
      // Without a working guard an automatic reload could loop: leave it to the user.
      this.showBanner(hash, false);
      return;
    }
    this.banner?.dismiss();
    this.reloadPage();
  }

  /** The snackbar: manual reload, and in the deferred case a promise that it will happen anyway. */
  private showBanner(hash: string, willAutoReload: boolean): void {
    this.banner?.dismiss();
    const message = this.i18n.t(willAutoReload ? I18N.pwa.update_when_idle : I18N.pwa.update_available);
    const ref = this.snackBar.open(message, this.i18n.t(I18N.pwa.reload), { duration: 0 });
    this.banner = ref;
    ref.onAction().subscribe(() => {
      this.clearIdleTimer();
      this.pendingHash = null;
      // A manual click is the user's own choice: it always reloads, guard or no guard.
      void (async () => {
        try { await this.swUpdate?.activateUpdate(); } catch { /* reload anyway */ }
        this.markReloaded(hash);
        this.reloadPage();
      })();
    });
  }

  private alreadyReloadedFor(marker: string): boolean {
    try {
      const raw = sessionStorage.getItem(GUARD_KEY);
      if (!raw) return false;
      const { marker: m, at } = JSON.parse(raw) as { marker: string; at: number };
      if (m !== marker) return false;
      return marker !== UNRECOVERABLE_MARKER || Date.now() - at < UNRECOVERABLE_RELOAD_WINDOW_MS;
    } catch {
      return false;
    }
  }

  /** Persist the reload marker; false when storage is unavailable, so callers can refuse to auto-reload. */
  private markReloaded(marker: string): boolean {
    try {
      sessionStorage.setItem(GUARD_KEY, JSON.stringify({ marker, at: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }
}
