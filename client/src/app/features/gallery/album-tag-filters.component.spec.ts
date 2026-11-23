import type { Mock } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { I18nService } from '../../core/services/i18n.service';
import { GalleryStore } from './gallery.store';
import { AlbumTagFiltersComponent } from './album-tag-filters.component';
import { albumTagGroups } from './album-tag-groups.util';

const FACETS = {
  tags: [
    { tag: 'peter/communion', count: 950 },
    { tag: 'peter/communion/church', count: 69 },
    { tag: 'peter/communion/lunch', count: 376 },
    { tag: 'peter/communion/party', count: 505 },
    { tag: 'photographer[ray]', count: 159 },
    { tag: 'photographer[ray]/dslr', count: 159 },
    { tag: 'photographer[robin]', count: 778 },
  ],
};

describe('albumTagGroups', () => {
  it('drops the event parent, labels parts by their last segment, and keeps device children out', () => {
    const groups = albumTagGroups(FACETS.tags);
    expect(groups.sets.map(c => [c.label, c.count])).toEqual([['church', 69], ['lunch', 376], ['party', 505]]);
    expect(groups.by.map(c => [c.label, c.count])).toEqual([['ray', 159], ['robin', 778]]);
  });

  it('leaves a one-option pull-down empty', () => {
    const groups = albumTagGroups([
      { tag: 'peter/9th-bday', count: 605 }, { tag: 'photographer[ray]', count: 604 },
    ]);
    expect(groups).toEqual({ sets: [], by: [] });
  });
});

describe('AlbumTagFiltersComponent', () => {
  let fixture: ComponentFixture<AlbumTagFiltersComponent>;
  let mockApi: { get: Mock };
  let store: {
    currentAlbum: ReturnType<typeof signal<{ id: number } | null>>;
    filters: ReturnType<typeof signal<{ album_set: string; photographer: string }>>;
    tagsRevision: ReturnType<typeof signal<number>>;
    filterControlsShown: ReturnType<typeof signal<boolean>>;
    filterPayload: Mock;
    updateFilter: Mock;
  };

  async function render() {
    fixture = TestBed.createComponent(AlbumTagFiltersComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const field = (id: string) => fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  async function options(id: string): Promise<string[]> {
    (field(id)!.querySelector('.mat-mdc-select-trigger') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    const texts = ([...document.querySelectorAll('mat-option')] as HTMLElement[]).map(o => o.textContent!.trim());
    (document.querySelector('.cdk-overlay-backdrop') as HTMLElement | null)?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    return texts;
  }

  beforeEach(() => {
    mockApi = { get: vi.fn(() => of(FACETS)) };
    store = {
      currentAlbum: signal<{ id: number } | null>({ id: 3 }),
      filters: signal({ album_set: '', photographer: '' }),
      tagsRevision: signal(0),
      filterControlsShown: signal(true),
      filterPayload: vi.fn(() => {
        const { album_set, photographer } = store.filters();
        const albumTags = [album_set, photographer].filter(Boolean).join(',');
        return { album_id: String(store.currentAlbum()?.id ?? 0), page: '1', ...(albumTags ? { album_tags: albumTags } : {}) };
      }),
      updateFilter: vi.fn(async (k: 'album_set' | 'photographer', v: string) =>
        store.filters.update(f => ({ ...f, [k]: v }))),
    };
    TestBed.configureTestingModule({
      imports: [AlbumTagFiltersComponent, NoopAnimationsModule],
      providers: [
        { provide: ApiService, useValue: mockApi },
        { provide: GalleryStore, useValue: store },
        { provide: I18nService, useValue: { t: (k: string) => k, translations: () => ({}) } },
      ],
    });
  });

  it('asks for the view without album_tags or page and offers All plus each set and photographer', async () => {
    await render();
    expect(mockApi.get).toHaveBeenCalledWith('/album_tags/facets', { album_id: '3' });
    expect(await options('album-set-filter')).toEqual(['gallery.all', 'church (69)', 'lunch (376)', 'party (505)']);
    expect(await options('album-photographer-filter')).toEqual(['gallery.all', 'ray (159)', 'robin (778)']);
  });

  it('each pull-down writes its own filter key, so a set and a photographer combine', async () => {
    await render();
    (field('album-set-filter')!.querySelector('.mat-mdc-select-trigger') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    ([...document.querySelectorAll('mat-option')] as HTMLElement[])[1].click();
    expect(store.updateFilter).toHaveBeenLastCalledWith('album_set', 'peter/communion/church');
    fixture.detectChanges();
    await fixture.whenStable();
    (field('album-photographer-filter')!.querySelector('.mat-mdc-select-trigger') as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    ([...document.querySelectorAll('mat-option')] as HTMLElement[])[2].click();
    expect(store.updateFilter).toHaveBeenLastCalledWith('photographer', 'photographer[robin]');
    expect(store.filters()).toEqual({ album_set: 'peter/communion/church', photographer: 'photographer[robin]' });
  });

  it('choosing an option does not refetch the options; a tag write does', async () => {
    await render();
    expect(mockApi.get).toHaveBeenCalledTimes(1);
    store.filters.set({ album_set: 'peter/communion/lunch', photographer: 'photographer[ray]' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(mockApi.get).toHaveBeenCalledTimes(1);
    store.tagsRevision.set(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(mockApi.get).toHaveBeenCalledTimes(2);
  });

  // Flow 18: the body is built on idle with the panel shut, and its late read of an album deleted meanwhile answered 404.
  it('asks nothing while the controls are shut, and asks once they open', async () => {
    store.filterControlsShown.set(false);
    await render();
    expect(mockApi.get).not.toHaveBeenCalled();
    expect(field('album-set-filter')).toBeNull();

    store.filterControlsShown.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(mockApi.get).toHaveBeenCalledExactlyOnceWith('/album_tags/facets', { album_id: '3' });
    expect(field('album-set-filter')).not.toBeNull();
  });

  it('does not ask again on reopening an unchanged view', async () => {
    await render();
    store.filterControlsShown.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    store.filterControlsShown.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(mockApi.get).toHaveBeenCalledTimes(1);
    expect(field('album-set-filter')).not.toBeNull();
  });

  it('drops the options of a view changed while shut and asks for the new one only on opening', async () => {
    await render();
    store.filterControlsShown.set(false);
    store.currentAlbum.set({ id: 4 });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(mockApi.get).toHaveBeenCalledTimes(1);
    expect(field('album-set-filter')).toBeNull();

    store.filterControlsShown.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(mockApi.get).toHaveBeenCalledTimes(2);
    expect(mockApi.get).toHaveBeenLastCalledWith('/album_tags/facets', { album_id: '4' });
  });

  it('renders nothing outside an album', async () => {
    store.currentAlbum.set(null);
    await render();
    expect(mockApi.get).not.toHaveBeenCalled();
    expect(field('album-set-filter')).toBeNull();
    expect(field('album-photographer-filter')).toBeNull();
  });
});
