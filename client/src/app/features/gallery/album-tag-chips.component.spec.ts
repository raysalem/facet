import type { Mock } from 'vitest';
import { signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { I18nService } from '../../core/services/i18n.service';
import { GalleryStore } from './gallery.store';
import { AlbumTagChipsComponent } from './album-tag-chips.component';
import { albumTagChipGroups } from './album-tag-chips.util';

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

describe('albumTagChipGroups', () => {
  it('drops the event parent, labels parts by their last segment, and keeps device children out', () => {
    const groups = albumTagChipGroups(FACETS.tags);
    expect(groups.sets.map(c => [c.label, c.count])).toEqual([['church', 69], ['lunch', 376], ['party', 505]]);
    expect(groups.by.map(c => [c.label, c.count])).toEqual([['ray', 159], ['robin', 778]]);
  });

  it('leaves a one-chip row empty', () => {
    const groups = albumTagChipGroups([
      { tag: 'peter/9th-bday', count: 605 }, { tag: 'photographer[ray]', count: 604 },
    ]);
    expect(groups).toEqual({ sets: [], by: [] });
  });
});

describe('AlbumTagChipsComponent', () => {
  let fixture: ComponentFixture<AlbumTagChipsComponent>;
  let mockApi: { get: Mock };
  let store: {
    currentAlbum: ReturnType<typeof signal<{ id: number } | null>>;
    filters: ReturnType<typeof signal<{ tag: string }>>;
    tagsRevision: ReturnType<typeof signal<number>>;
    filterPayload: Mock;
    updateFilter: Mock;
  };

  async function render() {
    fixture = TestBed.createComponent(AlbumTagChipsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function chips(): string[] {
    return ([...fixture.nativeElement.querySelectorAll('[data-album-chip]')] as HTMLElement[])
      .map(b => b.getAttribute('data-album-chip')!);
  }

  beforeEach(() => {
    mockApi = { get: vi.fn(() => of(FACETS)) };
    store = {
      currentAlbum: signal<{ id: number } | null>({ id: 3 }),
      filters: signal({ tag: '' }),
      tagsRevision: signal(0),
      filterPayload: vi.fn(() => ({ album_id: '3', tag: store.filters().tag, page: '1' })),
      updateFilter: vi.fn(async (_k: string, v: string) => store.filters.set({ tag: v })),
    };
    TestBed.configureTestingModule({
      imports: [AlbumTagChipsComponent],
      providers: [
        { provide: ApiService, useValue: mockApi },
        { provide: GalleryStore, useValue: store },
        { provide: I18nService, useValue: { t: (k: string) => k, translations: () => ({}) } },
      ],
    });
  });

  it('asks for the view without tag or page and shows sets and photographers', async () => {
    await render();
    expect(mockApi.get).toHaveBeenCalledWith('/album_tags/facets', { album_id: '3' });
    expect(chips()).toEqual([
      '', 'peter/communion/church', 'peter/communion/lunch', 'peter/communion/party',
      'photographer[ray]', 'photographer[robin]',
    ]);
  });

  it('a chip sets the tag filter and a second click clears it', async () => {
    await render();
    const church = () => fixture.nativeElement.querySelector('[data-album-chip="peter/communion/church"]') as HTMLButtonElement;
    church().click();
    expect(store.updateFilter).toHaveBeenCalledWith('tag', 'peter/communion/church');
    fixture.detectChanges();
    expect(church().getAttribute('aria-pressed')).toBe('true');
    church().click();
    expect(store.updateFilter).toHaveBeenLastCalledWith('tag', '');
  });

  it('switching chips does not refetch; a tag write does', async () => {
    await render();
    expect(mockApi.get).toHaveBeenCalledTimes(1);
    store.filters.set({ tag: 'peter/communion/lunch' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(mockApi.get).toHaveBeenCalledTimes(1);
    store.tagsRevision.set(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(mockApi.get).toHaveBeenCalledTimes(2);
  });

  it('renders nothing outside an album', async () => {
    store.currentAlbum.set(null);
    await render();
    expect(mockApi.get).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="album-tag-chips"]')).toBeNull();
  });
});
