import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { i18nKeys } from '../../core/i18n/keys';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { GalleryStore } from './gallery.store';
import { AlbumTagCount, albumTagGroups } from './album-tag-groups.util';

/** Query keys that do not change which album tags the view holds. */
const VIEW_ONLY_KEYS = new Set(['album_tags', 'page', 'per_page', 'sort', 'sort_direction']);

/**
 * The album's Set (church, lunch, party) and Photographer pull-downs, in the filter sidebar.
 *
 * Built from the album tags the view's photos carry (`GET /api/album_tags/facets`,
 * asked without `album_tags` so every option stays listed while one is chosen).
 * The two combine: the gallery sends both as `album_tags`, which requires each one.
 * Neither is saved into the album (`SMART_ALBUM_EXCLUDE_KEYS`).
 */
@Component({
  selector: 'app-album-tag-filters',
  imports: [MatFormFieldModule, MatSelectModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.Eager,
  host: { class: 'contents' },
  template: `
    @if (groups().sets.length) {
      <mat-form-field subscriptSizing="dynamic" class="w-full" data-testid="album-set-filter">
        <mat-label>{{ I18N.album_tags.set_label | translate }}</mat-label>
        <mat-select [value]="store.filters().album_set" (selectionChange)="store.updateFilter('album_set', $event.value)">
          <mat-option value="">{{ I18N.gallery.all | translate }}</mat-option>
          @for (o of groups().sets; track o.tag) {
            <mat-option [value]="o.tag">{{ o.label }} ({{ o.count }})</mat-option>
          }
        </mat-select>
      </mat-form-field>
    }
    @if (groups().by.length) {
      <mat-form-field subscriptSizing="dynamic" class="w-full" data-testid="album-photographer-filter">
        <mat-label>{{ I18N.album_tags.photographer_label | translate }}</mat-label>
        <mat-select [value]="store.filters().photographer" (selectionChange)="store.updateFilter('photographer', $event.value)">
          <mat-option value="">{{ I18N.gallery.all | translate }}</mat-option>
          @for (o of groups().by; track o.tag) {
            <mat-option [value]="o.tag">{{ o.label }} ({{ o.count }})</mat-option>
          }
        </mat-select>
      </mat-form-field>
    }
  `,
})
export class AlbumTagFiltersComponent {
  protected readonly store = inject(GalleryStore);
  private readonly api = inject(ApiService);
  protected readonly I18N = i18nKeys();

  private readonly facets = signal<AlbumTagCount[]>([]);
  protected readonly groups = computed(() => albumTagGroups(this.facets()));

  /** The view's query without `album_tags`: choosing a set must not refetch the options. */
  private readonly query = computed(() => {
    if (!this.store.currentAlbum()) return null;
    const payload = this.store.filterPayload();
    if (!payload) return null;
    const rest = Object.fromEntries(
      Object.entries(payload).filter(([key]) => !VIEW_ONLY_KEYS.has(key)));
    return JSON.stringify([this.store.tagsRevision(), rest]);
  });

  /** The request in flight; replaced by a newer query and cancelled when the sidebar goes away. */
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
}
