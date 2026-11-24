import { OverlayContainer } from '@angular/cdk/overlay';
import { computed, signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { PhotoLogicalAssetComponent } from './photo-logical-asset.component';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { NavigationCancel, NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { I18nService } from '../../core/services/i18n.service';
import type { RelatedFilesResponse } from '../../core/api/types';
import { makePhoto } from '../../../testing/photo.fixture';
import { PhotoRelatedFilesComponent } from './photo-related-files.component';

describe('PhotoRelatedFilesComponent', () => {
  const primary = { name: 'shot.jpg', kind: 'photo', state: 'available', indexed: true, raw_download: false } as const;
  const response: RelatedFilesResponse = {
    inventory_state: 'checked', indexed_images_only: false, multiple_raw_candidates: false, basename_sidecar_unverified: true,
    files: [
      primary,
      { name: 'shot.CR2', kind: 'raw', state: 'available', indexed: true, raw_download: true },
      { name: 'shot.xmp', kind: 'xmp_basename', state: 'available', indexed: false, raw_download: false },
    ],
  };
  /** Only the photo itself on disk, and no notice to give. */
  const alone: RelatedFilesResponse = { ...response, basename_sidecar_unverified: false, files: [primary] };
  let auth: { status: ReturnType<typeof signal<object | null>>; session: () => string | null; token: string };
  let events: Subject<NavigationStart | NavigationCancel>;
  let http: HttpTestingController;
  beforeEach(() => {
    const status = signal<object | null>({ user_id: 'alice' });
    auth = { status, session: computed(() => (status() as { user_id?: string } | null)?.user_id ?? null), token: 'one' };
    events = new Subject();
    TestBed.configureTestingModule({
      imports: [PhotoRelatedFilesComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(),
        { provide: AuthService, useValue: auth }, { provide: Router, useValue: { events } },
        { provide: I18nService, useValue: { t: (key: string) => key, translations: () => ({}) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  // The inline RAW/JPEG list has its own spec; here its read is only acknowledged.
  afterEach(() => { try { http.match(request => request.url.startsWith('/api/logical_assets/by-photo')); http.verify(); } finally { TestBed.resetTestingModule(); } });
  function render(path = '/shot.jpg') {
    const fixture = TestBed.createComponent(PhotoRelatedFilesComponent);
    fixture.componentRef.setInput('photo', makePhoto({ path })); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    return { fixture, root, trigger: () => root.querySelector<HTMLElement>('mat-expansion-panel-header')! };
  }
  const related = (path = '/shot.jpg') => http.expectOne(`/api/photo/related_files?path=${path}`);
  const isOpen = (root: HTMLElement) => root.querySelector('mat-expansion-panel-header')!.getAttribute('aria-expanded') === 'true';
  /** The RAW/JPEG list renders inline in the open panel and reads its own state. */
  const logical = (path = '/shot.jpg') => http.expectOne(`/api/logical_assets/by-photo?path=${path}`);

  it('reads the inventory up front, lists the companions but never the photo itself, and closes on Escape', () => {
    const { fixture, root, trigger } = render(); document.body.appendChild(root);
    const request = related();
    expect(request.request.method).toBe('GET'); request.flush(response); fixture.detectChanges();
    expect(isOpen(root)).toBe(false);
    trigger().click(); fixture.detectChanges();
    expect([...root.querySelectorAll('li bdi')].map(name => name.textContent)).toEqual(['shot.CR2', 'shot.xmp']);
    expect(root.textContent).not.toContain('related_files.photo');
    expect(root.textContent).toContain('related_files.raw_download');
    expect(root.textContent).toContain('related_files.basename_unverified');
    expect(root.querySelector('a')).toBeNull(); expect([...root.querySelectorAll('button')].filter(button => !button.closest('app-context-help'))).toHaveLength(0);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    trigger().dispatchEvent(event); fixture.detectChanges();
    expect(event.defaultPrevented).toBe(true); expect(isOpen(root)).toBe(false);
    expect(document.activeElement).toBe(trigger()); expect(root.textContent).not.toContain('shot.CR2');
    http.expectNone('/api/photo/related_files?path=/shot.jpg');
    fixture.destroy(); root.remove();
  });

  it('leaves the section out when nothing but the photo itself is there', () => {
    const { fixture, root } = render();
    related().flush(alone); fixture.detectChanges();
    expect(root.querySelector('mat-expansion-panel')).toBeNull();
    logical().flush({ asset: null, can_group: false, candidates: [{ path: '/shot.jpg', name: 'shot.jpg', kind: 'jpeg' }] });
    fixture.detectChanges();
    expect(root.querySelector('mat-expansion-panel')).toBeNull();
    expect(root.textContent!.trim()).toBe('');
  });

  it('keeps the section for a photo alone on disk that belongs to a version group', () => {
    const { fixture, root, trigger } = render();
    related().flush(alone); fixture.detectChanges();
    logical().flush({ asset: { id: 'a'.repeat(32), primary_path: '/shot.jpg', members: [] }, can_group: false, candidates: [] });
    fixture.detectChanges();
    expect(root.querySelector('mat-expansion-panel[data-related-files]')).not.toBeNull();
    trigger().click(); fixture.detectChanges();
    expect(root.querySelectorAll('li')).toHaveLength(0);
    expect(root.querySelector('[data-logical-asset]')).not.toBeNull();
  });

  it('cancels obsolete photo reads and offers a fresh retry for an offline result or HTTP failure', () => {
    const { fixture, root, trigger } = render();
    const old = related();
    fixture.componentRef.setInput('photo', makePhoto({ path: '/next.jpg' })); fixture.detectChanges();
    expect(old.cancelled).toBe(true);
    related('/next.jpg').flush({ ...response, inventory_state: 'unavailable', files: [{ ...primary, state: 'missing' }] });
    fixture.detectChanges();
    trigger().click(); fixture.detectChanges();
    expect(root.textContent).toContain('related_files.unchecked');
    root.querySelector<HTMLButtonElement>('[data-related-retry]')!.click();
    related('/next.jpg').flush({}, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges(); expect(root.querySelector('[role="alert"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-related-files] button')!.click();
    related('/next.jpg').flush(response); fixture.detectChanges();
    expect(root.textContent).toContain('shot.CR2'); expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('clears owner data, holds reads during navigation and reads again after a rotated credential', () => {
    const { fixture, root, trigger } = render();
    related().flush(response); fixture.detectChanges();
    trigger().click(); fixture.detectChanges();
    logical().flush({ asset: null, can_group: false, candidates: [] });
    expect(root.textContent).toContain('shot.CR2');
    auth.status.set(null); fixture.detectChanges();
    expect(root.querySelector('mat-expansion-panel')).toBeNull(); http.expectNone(() => true);
    events.next(new NavigationStart(1, '/persons'));
    auth.status.set({ user_id: 'bob' }); fixture.detectChanges(); http.expectNone(() => true);
    events.next(new NavigationCancel(1, '/persons', 'cancelled')); fixture.detectChanges();
    const request = related();
    auth.token = 'two'; request.flush(response); fixture.detectChanges();
    expect(root.textContent).not.toContain('shot.CR2');
    related().flush(response); fixture.detectChanges();
    expect(isOpen(root)).toBe(false);
    trigger().click(); fixture.detectChanges(); expect(root.textContent).toContain('shot.CR2');
  });

  it('renders inventory warnings, every candidate label and relays logical changes', () => {
    const { fixture, root, trigger } = render();
    related().flush({ ...response,
      indexed_images_only: true, multiple_raw_candidates: true,
      files: [
        { name: 'shot.jpeg', kind: 'jpeg', state: 'missing', indexed: true, raw_download: false },
        { name: 'shot.jpg.xmp', kind: 'xmp_full', state: 'unavailable', indexed: false, raw_download: false },
        { name: 'fallback.xmp', kind: 'xmp_fallback', state: 'link', indexed: false, raw_download: false },
      ],
    }); fixture.detectChanges();
    trigger().click(); fixture.detectChanges();
    const text = root.textContent!;
    for (const label of ['jpeg', 'missing', 'xmp_full', 'unavailable', 'xmp_fallback', 'link', 'indexed', 'multiple_raw']) {
      expect(text).toContain('related_files.' + label);
    }
    root.querySelector<HTMLButtonElement>('app-context-help button')!.click(); fixture.detectChanges();
    const help = TestBed.inject(OverlayContainer).getContainerElement();
    expect(help.textContent).toContain('related_files.multi_user_scope');
    const emitted = vi.fn(); fixture.componentInstance.logicalApplied.subscribe(emitted);
    const child = fixture.debugElement.query(By.directive(PhotoLogicalAssetComponent)).componentInstance as PhotoLogicalAssetComponent;
    const change = { operation: 'dissolve' as const, assetId: 'a'.repeat(32), primaryPath: null, members: ['/shot.jpg'] };
    child.applied.emit(change);
    expect(emitted).toHaveBeenCalledExactlyOnceWith(change);
  });

  it('lists the RAW/JPEG photo inline once the panel opens, with the help icon beside the file list', () => {
    const { fixture, root, trigger } = render();
    related().flush(response); fixture.detectChanges();
    http.expectNone('/api/logical_assets/by-photo?path=/shot.jpg');
    trigger().click(); fixture.detectChanges();
    logical().flush({ asset: null, can_group: false, candidates: [] }); fixture.detectChanges();
    const inline = root.querySelector<HTMLElement>('[data-logical-asset]')!;
    expect(inline.tagName).toBe('SECTION');
    expect(root.querySelector('details, summary')).toBeNull();
    expect(inline.textContent).toContain('logical_assets.title');
    expect(inline.textContent).toContain('logical_assets.no_candidates');
    const help = root.querySelector<HTMLButtonElement>('[data-related-list] app-context-help button')!;
    expect(help.getAttribute('aria-label')).toBe('related_files.help_title');
    expect(help.textContent!.trim()).toBe('help_outline');
  });
});
