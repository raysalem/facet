import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { of } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiService } from '../../core/services/api.service';
import { AlbumService } from '../../core/services/album.service';
import { AuthService } from '../../core/services/auth.service';
import { I18nService } from '../../core/services/i18n.service';
import { PageContextService } from '../../core/agent/page-context.service';
import { GalleryStore } from '../gallery/gallery.store';
import { ScenesComponent } from './scenes.component';

describe('ScenesComponent page context', () => {
  let mockApi: { get: Mock };
  let pageContext: PageContextService;

  const setup = (album: string | null = null): ScenesComponent => {
    mockApi = { get: vi.fn(() => of({ scenes: [], total: 7, page: 1, per_page: 20, total_pages: 1 })) };
    TestBed.configureTestingModule({
      providers: [
        ScenesComponent,
        { provide: ApiService, useValue: mockApi },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: I18nService, useValue: { t: vi.fn((key: string) => key) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => album } } } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: AlbumService, useValue: { listNonSmart: () => of([]) } },
        { provide: AuthService, useValue: { isEdition: vi.fn(() => false) } },
        { provide: GalleryStore, useValue: { config: () => null } },
      ],
    });
    pageContext = TestBed.inject(PageContextService);
    return TestBed.inject(ScenesComponent);
  };

  it('registers the scenes page with an empty scope before anything loads', () => {
    setup();
    expect(pageContext.snapshot()).toEqual({ id: 'scenes', album_id: null, total: 0 });
  });

  it('reports the album scope and total once loaded', async () => {
    const component = setup('42');
    await component.ngOnInit();
    expect(pageContext.snapshot()).toEqual({ id: 'scenes', album_id: '42', total: 7 });
  });

  it('removes the registration when the component is destroyed', () => {
    setup();
    expect(pageContext.snapshot()).not.toBeNull();
    TestBed.resetTestingModule();
    expect(pageContext.snapshot()).toBeNull();
  });
});

describe('ScenesComponent scene names', () => {
  let mockApi: { get: Mock; post: Mock };
  let router: { navigate: Mock };
  let component: ScenesComponent;
  const scene = {
    scene_id: 3, start: '2025:07:27 14:18:10', end: '2025:07:27 14:34:15', count: 26,
    best_path: '/p/a.jpg', photos: [], names: [] as string[],
  };
  interface Testable {
    nameScene: (s: typeof scene, n: string, a?: 'add' | 'delete') => Promise<void>;
    openNamed: (n: string) => void;
    scenes: { set: (v: unknown[]) => void; (): (typeof scene)[] };
  }

  beforeEach(() => {
    mockApi = {
      get: vi.fn(() => of({ scenes: [{ ...scene, names: ['pool'] }], total: 1, page: 1, per_page: 1, total_pages: 1 })),
      post: vi.fn(() => of({ success: true, count: 30 })),
    };
    router = { navigate: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        ScenesComponent,
        { provide: ApiService, useValue: mockApi },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: I18nService, useValue: { t: vi.fn((key: string) => key) } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
        { provide: Router, useValue: router },
        { provide: AlbumService, useValue: { listNonSmart: () => of([]) } },
        { provide: AuthService, useValue: { isEdition: vi.fn(() => true) } },
        { provide: GalleryStore, useValue: { config: () => null } },
      ],
    });
    component = TestBed.inject(ScenesComponent);
    (component as unknown as Testable).scenes.set([scene]);
  });

  it('tags the scene window, then shows the name it reads back', async () => {
    await (component as unknown as Testable).nameScene(scene, '  Pool ');

    expect(mockApi.post).toHaveBeenCalledWith('/scenes/manual_tags', {
      start: scene.start, end: scene.end, tag: 'Pool', action: 'add',
    });
    expect(mockApi.get).toHaveBeenCalledWith('/scenes', {
      date_from: scene.start, date_to: scene.end, per_page: 1, summary: 'true',
    });
    expect((component as unknown as Testable).scenes()[0].names).toEqual(['pool']);
  });

  it('removes a name', async () => {
    await (component as unknown as Testable).nameScene(scene, 'pool', 'delete');
    expect(mockApi.post.mock.calls[0][1]).toMatchObject({ tag: 'pool', action: 'delete' });
  });

  it('ignores an empty name', async () => {
    await (component as unknown as Testable).nameScene(scene, '   ');
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('opens the gallery on the named photos', () => {
    (component as unknown as Testable).openNamed('pool');
    expect(router.navigate).toHaveBeenCalledWith(['/'], { queryParams: { tag: 'pool' } });
  });
});
