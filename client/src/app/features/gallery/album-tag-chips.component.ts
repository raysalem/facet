import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { i18nKeys } from '../../core/i18n/keys';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { GalleryStore } from './gallery.store';
import { AlbumTagCount, albumTagChipGroups } from './album-tag-chips.util';

/** Query keys that do not change which album tags the view holds. */
const VIEW_ONLY_KEYS = new Set(['tag', 'page', 'per_page', 'sort', 'sort_direction']);

const CHIP = 'inline-flex items-center gap-1 px-2.5 py-1 min-h-8 rounded-full border text-xs cursor-pointer transition-colors';
const CHIP_OFF = CHIP + ' border-[var(--mat-sys-outline-variant)] hover:bg-[var(--mat-sys-surface-container-high)]';
const CHIP_ON = CHIP + ' border-transparent bg-[var(--mat-sys-secondary-container)] text-[var(--mat-sys-on-secondary-container)] font-medium';

/**
 * The album's sets (church, lunch, party) and photographers as filter chips.
 *
 * Built from the album tags the view's photos carry (`GET /api/album_tags/facets`,
 * which ignores the active `tag` so every chip stays visible while one is on).
 * A chip sets the gallery's tag filter; clicking it again, or **All**, clears it.
 */
@Component({
  selector: 'app-album-tag-chips',
  imports: [MatIconModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { class: 'contents' },
  template: `
    @if (groups().sets.length || groups().by.length) {
      <div data-testid="album-tag-chips" role="group" [attr.aria-label]="I18N.album_tags.chips_label | translate"
           class="mx-2 md:mx-4 mt-2 md:mt-3 flex flex-col gap-1.5 text-xs">
        @if (groups().sets.length) {
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="w-12 shrink-0 uppercase tracking-wider text-[0.625rem] text-[var(--mat-sys-on-surface-variant)]">{{ I18N.album_tags.sets | translate }}</span>
            <button type="button" data-album-chip="" [class]="store.filters().tag ? CHIP_OFF : CHIP_ON"
                    [attr.aria-pressed]="!store.filters().tag" (click)="select('')">
              {{ I18N.album_tags.all | translate }}
            </button>
            @for (c of groups().sets; track c.tag) {
              <button type="button" [attr.data-album-chip]="c.tag" [class]="store.filters().tag === c.tag ? CHIP_ON : CHIP_OFF"
                      [attr.aria-pressed]="store.filters().tag === c.tag" (click)="select(c.tag)">
                {{ c.label }} <span class="opacity-70">{{ c.count }}</span>
              </button>
            }
          </div>
        }
        @if (groups().by.length) {
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="w-12 shrink-0 uppercase tracking-wider text-[0.625rem] text-[var(--mat-sys-on-surface-variant)]">{{ I18N.album_tags.by | translate }}</span>
            @for (c of groups().by; track c.tag) {
              <button type="button" [attr.data-album-chip]="c.tag" [class]="store.filters().tag === c.tag ? CHIP_ON : CHIP_OFF"
                      [attr.aria-pressed]="store.filters().tag === c.tag" (click)="select(c.tag)">
                <mat-icon class="!text-sm !w-3.5 !h-3.5 !leading-[14px] opacity-70" aria-hidden="true">photo_camera</mat-icon>
                {{ c.label }} <span class="opacity-70">{{ c.count }}</span>
              </button>
            }
          </div>
        }
      </div>
    }
  `,
})
export class AlbumTagChipsComponent {
  protected readonly store = inject(GalleryStore);
  private readonly api = inject(ApiService);
  protected readonly I18N = i18nKeys();
  protected readonly CHIP_ON = CHIP_ON;
  protected readonly CHIP_OFF = CHIP_OFF;

  private readonly facets = signal<AlbumTagCount[]>([]);
  protected readonly groups = computed(() => albumTagChipGroups(this.facets()));

  /** The view's query without `tag`: switching chips must not refetch the chips. */
  private readonly query = computed(() => {
    if (!this.store.currentAlbum()) return null;
    const payload = this.store.filterPayload();
    if (!payload) return null;
    const rest = Object.fromEntries(
      Object.entries(payload).filter(([key]) => !VIEW_ONLY_KEYS.has(key)));
    return JSON.stringify([this.store.tagsRevision(), rest]);
  });

  /** The request in flight; replaced by a newer query and cancelled when the chips go away. */
  private request?: Subscription;

  constructor() {
    effect(() => {
      const query = this.query();
      untracked(() => this.load(query));
    });
    inject(DestroyRef).onDestroy(() => this.request?.unsubscribe());
  }

  private load(query: string | null): void {
    this.request?.unsubscribe();
    if (!query) {
      this.facets.set([]);
      return;
    }
    const params = (JSON.parse(query) as [number, Record<string, string>])[1];
    this.request = this.api.get<{ tags: AlbumTagCount[] }>('/album_tags/facets', params).subscribe({
      next: res => this.facets.set(res.tags ?? []),
      error: () => this.facets.set([]),
    });
  }

  protected select(tag: string): void {
    void this.store.updateFilter('tag', this.store.filters().tag === tag ? '' : tag);
  }
}
