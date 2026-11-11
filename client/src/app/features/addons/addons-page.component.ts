import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AddonsService, type AddonTokenCreated } from '../../core/services/addons.service';
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
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, TranslatePipe],
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
      @if (mintError()) {
        <p role="alert" class="text-sm text-red-400 mt-2">{{ I18N.addons.token.error | translate }}</p>
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

  ngOnInit(): void {
    void this.addons.load();
  }

  protected refresh(): void {
    void this.addons.load();
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
