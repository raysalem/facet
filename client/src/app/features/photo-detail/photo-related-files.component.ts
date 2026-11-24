import { PhotoPanelReader } from './photo-panel-reader';
import { LogicalAssetApplied } from '../../shared/models/logical-asset-change';
import { PhotoLogicalAssetComponent } from './photo-logical-asset.component';
import { ChangeDetectionStrategy, Component, computed, effect, output, signal, untracked } from '@angular/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { I18N } from '../../core/i18n/keys';
import type { RelatedFilesResponse } from '../../core/api/types';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { ContextHelpComponent } from '../../shared/components/context-help/context-help.component';

@Component({
  selector: 'app-photo-related-files',
  imports: [MatExpansionModule, MatIconModule, TranslatePipe, ContextHelpComponent, PhotoLogicalAssetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    <!-- Read as soon as the photo shows; with nothing beside the photo itself the section is left out entirely. -->
    @if (shown()) {
    <mat-expansion-panel #panel data-related-files class="!rounded-none !bg-transparent !shadow-none [&_.mat-expansion-panel-body]:!px-0 [&_.mat-expansion-panel-body]:!pb-2"
                         [expanded]="open()" (expandedChange)="open.set($event)" (keydown.escape)="open() && closePanel($event, header)">
      <mat-expansion-panel-header #header class="!h-11 !ps-0 !pe-2 !text-xs !font-medium">
        <mat-panel-title class="!m-0 items-center gap-2"><mat-icon aria-hidden="true" class="!h-5 !w-5 shrink-0 !text-xl">file_copy</mat-icon>{{ I18N.related_files.title | translate }}</mat-panel-title>
      </mat-expansion-panel-header>
      @if (open()) {
        <div class="space-y-2 pb-2 text-xs">
          @if (loading()) { <p role="status">{{ I18N.ui.labels.loading | translate }}</p> }
          @else if (failed()) {
            <p role="alert">{{ I18N.related_files.failed | translate }}</p>
            <button type="button" class="min-h-11 cursor-pointer underline focus-visible:outline-2" (click)="load()">{{ I18N.gallery.load_error.retry | translate }}</button>
          } @else if (data(); as result) {
            <div data-related-list class="flex items-start gap-1">
            <ul class="m-0 min-w-0 flex-1 list-none space-y-2 p-0" [attr.aria-label]="I18N.related_files.title | translate">
              @for (file of rows(); track file.name) {
                <li class="flex min-w-0 items-start gap-2">
                  <mat-icon aria-hidden="true" class="!h-4 !w-4 shrink-0 !text-base">{{ file.icon }}</mat-icon>
                  <div class="min-w-0 flex-1">
                    <bdi class="block break-words font-medium">{{ file.name }}</bdi>
                    <span class="text-[var(--mat-sys-on-surface-variant)]">{{ file.kindLabel | translate }} · {{ file.stateLabel | translate }}</span>
                    @if (file.indexed && file.kind !== 'photo') { <span class="ml-1">· {{ I18N.related_files.indexed | translate }}</span> }
                    @if (file.raw_download) { <span class="block">{{ I18N.related_files.raw_download | translate }}</span> }
                  </div>
                </li>
              }
            </ul>
            <app-context-help [label]="I18N.related_files.help_title" [keys]="helpKeys()" [iconOnly]="true" />
            </div>
            @if (result.inventory_state === 'unavailable') {
              <p class="m-0">{{ I18N.related_files.unchecked | translate }}</p>
              <button type="button" data-related-retry class="min-h-11 cursor-pointer underline focus-visible:outline-2" (click)="load()">{{ I18N.gallery.load_error.retry | translate }}</button>
            }
            @if (result.multiple_raw_candidates) { <p class="m-0">{{ I18N.related_files.multiple_raw | translate }}</p> }
            @if (result.basename_sidecar_unverified) { <p class="m-0">{{ I18N.related_files.basename_unverified | translate }}</p> }
            <app-photo-logical-asset [photo]="photo()" (applied)="logicalApplied.emit($event)" />
          }
        </div>
      }
    </mat-expansion-panel>
    }
  `,
})
export class PhotoRelatedFilesComponent extends PhotoPanelReader<RelatedFilesResponse> {
  protected readonly endpoint = '/photo/related_files';
  readonly logicalApplied = output<LogicalAssetApplied>();
  protected readonly I18N = I18N;
  protected readonly helpKeys = computed(() => this.data()?.indexed_images_only
    ? [I18N.related_files.help, I18N.related_files.multi_user_scope] : [I18N.related_files.help]);
  /** The panel's own disclosure; the reader's expanded flag only means the inventory is wanted. */
  protected readonly open = signal(false);
  /** Whether an existing version group holds this photo, asked only when no companion is on disk. */
  private readonly grouped = signal<boolean | null>(null);
  /** Companions only: the indexed photo itself is what the page already shows. */
  private readonly companions = computed(() => (this.data()?.files ?? []).filter(file => file.kind !== 'photo'));
  /** Something to read: a companion, a version group, a notice, or a failure to retry. */
  private readonly worthShowing = computed(() => {
    if (this.failed()) return true;
    const result = this.data();
    if (!result) return false;
    return this.companions().length > 0 || result.inventory_state !== 'checked'
      || result.multiple_raw_candidates || result.basename_sidecar_unverified || this.grouped() === true;
  });
  /** Settles only between reads, so re-reading the same photo after an edit does not blink the section away. */
  protected readonly shown = signal(false);
  protected readonly rows = computed(() => this.companions().map(file => ({
    ...file,
    icon: file.kind.startsWith('xmp') ? 'description' : file.kind === 'raw' ? 'raw_on' : 'image',
    kindLabel: ({ photo: I18N.related_files.photo, raw: I18N.related_files.raw, jpeg: I18N.related_files.jpeg,
      xmp_full: I18N.related_files.xmp_full, xmp_basename: I18N.related_files.xmp_basename,
      xmp_fallback: I18N.related_files.xmp_fallback })[file.kind],
    stateLabel: ({ available: I18N.related_files.available, missing: I18N.related_files.missing,
      unavailable: I18N.related_files.unavailable, link: I18N.related_files.link })[file.state],
  })));

  constructor() {
    super();
    // Read whenever the page can, as the albums list does: on render and after each reset (path, session, navigation).
    effect(() => {
      // Tracks the reader's flag too, so a read dropped for a rotated credential is made again with the new one.
      const settled = !this.navigating && !!this.auth.session() && !!this.photo().path && !this.expanded();
      untracked(() => { if (settled) this.setExpanded(true); });
    });
    effect(() => {
      const show = this.worthShowing();
      const settling = this.loading() || (!!this.data() && this.grouped() === null && !show);
      untracked(() => { if (!settling) this.shown.set(show); });
    });
    // Nothing on disk beside the photo: it can still belong to a version group, which the panel must keep reachable.
    effect(() => {
      const result = this.data();
      untracked(() => { if (result && result.inventory_state === 'checked' && !this.companions().length) this.readGroup(); });
    });
  }

  private readGroup(): void {
    const current = this.scope();
    this.api.get<{ asset: unknown }>('/logical_assets/by-photo', { path: this.photo().path }).subscribe({
      next: state => { if (current()) this.grouped.set(!!state?.asset); },
      error: () => { if (current()) this.grouped.set(false); },
    });
  }

  protected closePanel(event: Event, trigger: { focus(): void }): void {
    event.preventDefault(); event.stopPropagation(); this.open.set(false); trigger.focus();
  }

  protected override onReset(): void { this.open.set(false); this.grouped.set(null); this.shown.set(false); }
}
