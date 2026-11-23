import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AddonsService, type Addon, type AddonTokenCreated } from '../../core/services/addons.service';
import { AddonPanelService } from '../../core/addons/addon-panel.service';
import { IncludesPipe } from '../../shared/pipes/array.pipe';
import { AddonImportNotifier } from '../../core/addons/addon-import-notifier.service';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { i18nKeys } from '../../core/i18n/keys';

/**
 * The Add-ons page: a read-only list of the installed manifests and the ones Facet refused, with
 * the reason. Nothing here can add, edit or remove an add-on -- the operator places or deletes its
 * folder. An external add-on's token is minted here once and shown once.
 */
@Component({
  selector: 'app-addons-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, TranslatePipe, IncludesPipe],
  host: { class: 'block px-4 pt-4 pb-8 max-w-3xl mx-auto' },
  template: `
    <header class="flex items-center gap-2 mb-2">
      <h1 class="m-0 text-xl font-medium flex-1">{{ I18N.addons.title | translate }}</h1>
      <button mat-icon-button data-addons-refresh (click)="refresh()"
              [matTooltip]="I18N.addons.refresh | translate" [attr.aria-label]="I18N.addons.refresh | translate">
        <mat-icon>refresh</mat-icon>
      </button>
    </header>
    @if (addons.loadError()) {
      <p role="alert" class="text-sm text-red-400">{{ I18N.addons.load_error | translate }}</p>
    }
    @if (addons.list(); as list) {
      <p class="text-sm text-[var(--mat-sys-on-surface-variant)] mb-1">{{ I18N.addons.intro | translate }}</p>
      <p class="text-xs font-mono break-all mb-4 opacity-80" data-addons-dir>{{ list.addons_dir }}</p>
      @if (list.addons.length === 0) {
        <p class="text-sm py-4" data-addons-empty>{{ I18N.addons.empty | translate }}</p>
      }
      <ul class="flex flex-col gap-3 list-none p-0 m-0">
        @for (addon of list.addons; track addon.id) {
          <li class="rounded-lg border border-[var(--mat-sys-outline-variant)] p-4" [attr.data-addon]="addon.id">
            <div class="flex items-start gap-3">
              <mat-icon class="shrink-0 mt-0.5">{{ addon.icon }}</mat-icon>
              <div class="min-w-0 flex-1">
                <h2 class="m-0 text-base font-medium">{{ addon.name }}</h2>
                <p class="m-0 text-xs text-[var(--mat-sys-on-surface-variant)]">
                  {{ I18N.addons.version | translate: { version: addon.version } }} ·
                  {{ ('addons.mode.' + addon.mode) | translate }}
                </p>
              </div>
              <span class="text-xs rounded-full px-2 py-0.5 bg-[var(--mat-sys-surface-container-high)]" data-addon-status>
                {{ ('addons.status.' + addon.status) | translate }}
              </span>
            </div>
            <p class="mt-3 mb-1 text-xs font-medium">{{ I18N.addons.permissions | translate }}</p>
            <ul class="flex flex-wrap gap-1 list-none p-0 m-0">
              @for (permission of addon.permissions; track permission) {
                <li class="text-xs rounded px-2 py-0.5 bg-[var(--mat-sys-surface-container)]">{{ ('addons.permission.' + permission) | translate }}</li>
              }
            </ul>
            <div class="flex flex-wrap items-center gap-2 mt-3">
              @if (addon.slots | includes: 'sidebar') {
                <button mat-flat-button data-addon-open [disabled]="busy() === addon.id" (click)="open(addon)">
                  <mat-icon>open_in_new</mat-icon>{{ I18N.addons.open | translate }}
                </button>
              }
              @if (addon.mode === 'supervised') {
                @if (addon.status === 'running' || addon.status === 'starting') {
                  <button mat-stroked-button data-addon-stop [disabled]="busy() === addon.id" (click)="stop(addon.id)">
                    <mat-icon>stop</mat-icon>{{ I18N.addons.stop | translate }}
                  </button>
                } @else {
                  <button mat-stroked-button data-addon-start [disabled]="busy() === addon.id" (click)="start(addon.id)">
                    <mat-icon>play_arrow</mat-icon>{{ I18N.addons.start | translate }}
                  </button>
                }
                @if (addon.exit_code !== null && addon.exit_code !== undefined && addon.status !== 'running') {
                  <span class="text-xs" data-addon-exit>{{ I18N.addons.exit_code | translate: { code: addon.exit_code } }}</span>
                }
              }
            </div>
            @if (addon.error) {
              <p role="alert" class="text-sm text-red-400 mt-2 mb-0" data-addon-error>{{ addon.error }}</p>
            }
            @if (addon.mode === 'supervised') {
              <details class="mt-2" [open]="addon.status === 'failed'" (toggle)="toggleLog(addon.id, $event)" data-addon-log>
                <summary class="cursor-pointer text-sm">{{ I18N.addons.log | translate }}</summary>
                <pre class="mt-1 mb-0 text-xs font-mono whitespace-pre-wrap max-h-64 overflow-y-auto opacity-80 bg-[var(--mat-sys-surface-container)] rounded p-2">{{ logs()[addon.id] || (I18N.addons.log_empty | translate) }}</pre>
              </details>
            }
            @if (addon.mode === 'external') {
              <div class="flex flex-wrap items-center gap-2 mt-3">
                <button mat-stroked-button data-addon-mint (click)="mint(addon.id)">
                  <mat-icon>key</mat-icon>{{ I18N.addons.token.create | translate }}
                </button>
                @if (addon.live_tokens) {
                  <span class="text-xs">{{ I18N.addons.token.live | translate: { count: addon.live_tokens } }}</span>
                  <button mat-button data-addon-revoke (click)="revoke(addon.id)">{{ I18N.addons.token.revoke | translate }}</button>
                }
              </div>
              @if (minted(); as token) {
                @if (token.addon_id === addon.id) {
                  <p class="mt-2 mb-1 text-xs" role="status">{{ I18N.addons.token.shown_once | translate }}</p>
                  <code class="block text-xs break-all select-all p-2 rounded bg-[var(--mat-sys-surface-container)]" data-addon-token>{{ token.token }}</code>
                }
              }
            }
          </li>
        }
      </ul>
      @if (panels.openError(); as error) {
        <p role="alert" class="text-sm text-red-400 mt-2">{{ I18N.addons.open_error | translate: { detail: error } }}</p>
      }
      @if (mintError()) {
        <p role="alert" class="text-sm text-red-400 mt-2">{{ I18N.addons.token.error | translate }}</p>
      }
      @if (list.pending_runs?.length) {
        <section class="mt-6" data-addons-pending>
          <h2 class="text-base font-medium mb-2">{{ I18N.addons.pending_title | translate }}</h2>
          <ul class="list-none p-0 m-0 flex flex-col gap-2">
            @for (run of list.pending_runs; track run.job_id) {
              <li class="flex flex-wrap items-center gap-2 text-sm" [attr.data-pending-run]="run.job_id">
                <span class="flex-1 min-w-0">{{ run.addon_id }} — {{ I18N.addons.pending_run | translate: { run: run.run_id ?? '?', count: run.photo_count ?? 0 } }}</span>
                <button mat-stroked-button data-pending-open (click)="openRun(run.addon_id, run.job_id)">{{ I18N.addons.open | translate }}</button>
              </li>
            }
          </ul>
        </section>
      }
      @if (list.refused.length) {
        <section class="mt-6" data-addons-refused>
          <h2 class="text-base font-medium mb-1">{{ I18N.addons.refused_title | translate }}</h2>
          <p class="text-xs text-[var(--mat-sys-on-surface-variant)] mb-2">{{ I18N.addons.refused_help | translate }}</p>
          <ul class="list-none p-0 m-0 flex flex-col gap-1">
            @for (item of list.refused; track item.directory) {
              <li class="text-sm"><span class="font-mono">{{ item.directory }}</span>: {{ item.reason }}</li>
            }
          </ul>
        </section>
      }
    }
  `,
})
export class AddonsPageComponent implements OnInit {
  protected readonly I18N = i18nKeys();
  protected readonly addons = inject(AddonsService);
  protected readonly minted = signal<AddonTokenCreated | null>(null);
  protected readonly mintError = signal(false);
  protected readonly panels = inject(AddonPanelService);
  private readonly imports = inject(AddonImportNotifier);
  private readonly router = inject(Router);
  /**
   * The in-app page this one was opened from, recorded on entry. Not the browser's previous history entry:
   * after a deep link or a Back onto /addons that can be another site, and after a sign-in it is /login.
   * None when /addons was reached by Back/Forward, loaded first, or came from the login page.
   */
  private readonly returnUrl = ((): string | null => {
    const navigation = this.router.currentNavigation();
    const previous = navigation?.trigger === 'popstate' ? null : navigation?.previousNavigation?.finalUrl;
    if (!previous) return null;
    const page = previous.root.children['primary']?.segments[0]?.path;
    return page === 'login' || page === 'addons' ? null : this.router.serializeUrl(previous);
  })();
  /** The add-on a Start/Stop/Open is in flight for. */
  protected readonly busy = signal<string | null>(null);
  protected readonly logs = signal<Record<string, string>>({});

  ngOnInit(): void {
    void this.addons.load();
  }

  protected refresh(): void {
    void this.addons.load();
  }

  /** Open the add-on's sidebar for the gallery's current view or selection, then return to that page. */
  protected async open(addon: Addon): Promise<void> {
    this.busy.set(addon.id);
    try {
      if (await this.panels.openForCurrentView(addon)) this.returnToPreviousPage();
    } finally {
      this.busy.set(null);
      if (addon.mode === 'supervised') void this.addons.load();
    }
  }

  protected async start(id: string): Promise<void> {
    await this.run(id, () => this.addons.start(id));
  }

  protected async stop(id: string): Promise<void> {
    await this.run(id, () => this.addons.stop(id));
  }

  private async run(id: string, action: () => Promise<void>): Promise<void> {
    this.busy.set(id);
    try {
      await action();
    } catch {
      // The refreshed list carries the reason (status, error, exit code).
    } finally {
      this.busy.set(null);
      // A start that Facet refused (a broken addon.json) moves the add-on to the refused list, where it has
      // no log: asking would answer 404 and log a console error (M1).
      if (this.addons.list()?.addons.some(addon => addon.id === id)) await this.reloadLog(id);
    }
  }

  protected toggleLog(id: string, event: Event): void {
    if ((event.target as HTMLDetailsElement).open) void this.reloadLog(id);
  }

  private async reloadLog(id: string): Promise<void> {
    try {
      const lines = await this.addons.log(id);
      this.logs.update(current => ({ ...current, [id]: lines.join('\n') }));
    } catch { /* the page still shows status and error */ }
  }

  /** Open an after-import run that nobody opened yet (the browser was closed when it finished). */
  protected async openRun(addonId: string, jobId: string): Promise<void> {
    const addon = this.addons.list()?.addons.find(a => a.id === addonId);
    if (addon && await this.imports.openRun(addon, jobId)) {
      void this.addons.load();
      this.returnToPreviousPage();
    }
  }

  /**
   * The panel lives in the shell and survives navigation, so after opening it go back to the page the user
   * came from (the photo they were on, the gallery view): the panel then works on that, not on this page.
   * Only to the in-app page recorded on entry (`returnUrl`); otherwise the page stays.
   */
  private returnToPreviousPage(): void {
    if (this.returnUrl) void this.router.navigateByUrl(this.returnUrl);
  }

  protected async mint(id: string): Promise<void> {
    this.mintError.set(false);
    try {
      this.minted.set(await this.addons.mintToken(id));
    } catch {
      this.mintError.set(true);
    }
  }

  protected async revoke(id: string): Promise<void> {
    if (this.minted()?.addon_id === id) this.minted.set(null);
    await this.addons.revokeTokens(id).catch(() => this.addons.loadError.set(true));
  }
}
