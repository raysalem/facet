import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { AddonPanelService, OPEN_PANEL_KEY } from './addon-panel.service';
import { ApiService } from '../services/api.service';
import { GalleryStore } from '../../features/gallery/gallery.store';

describe('add-on panel service', () => {
  let post: ReturnType<typeof vi.fn>;
  let service: AddonPanelService;
  const selectedPaths = signal(new Set<string>());
  const opened = { addon_id: 'astro', nonce: 'n1', src: '/addons/astro/ui/?nonce=n1', scope: { kind: 'view', query: 'type=astro' } };

  afterEach(() => sessionStorage.removeItem(OPEN_PANEL_KEY));

  beforeEach(() => {
    selectedPaths.set(new Set());
    post = vi.fn(() => of(opened));
    TestBed.configureTestingModule({ providers: [
      { provide: ApiService, useValue: { post } },
      { provide: GalleryStore, useValue: { selectionScope: signal('paths'), selectedPaths, filterPayload: () => ({ type: 'astro' }) } },
    ] });
    service = TestBed.inject(AddonPanelService);
  });

  it('opens an external add-on for the current view, or the selection when there is one', async () => {
    expect(await service.openForCurrentView({ id: 'astro', name: 'Astro', icon: 'star', mode: 'external' })).toBe(true);
    expect(post).toHaveBeenCalledWith('/addons/astro/open', { scope: { kind: 'view', query: 'type=astro' } });
    expect(service.panel()?.src).toBe('/addons/astro/ui/?nonce=n1');
    selectedPaths.set(new Set(['/p/a.jpg']));
    expect(service.currentScope()).toEqual({ kind: 'selection' });
  });

  it('starts a supervised add-on and opens the panel the start returned', async () => {
    post.mockImplementation((url: string) => url.endsWith('/start') ? of({ addon_id: 'astro', status: 'running', opened }) : of({}));
    expect(await service.open({ id: 'astro', name: 'Astro', icon: 'star', mode: 'supervised' }, { kind: 'view' })).toBe(true);
    expect(post).toHaveBeenCalledWith('/addons/astro/start', { scope: { kind: 'view' } });
    expect(service.panel()?.nonce).toBe('n1');
  });

  it("shows a supervised add-on that didn't start, with its log, in the sidebar", async () => {
    post.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 502, error: { detail: {
      status: 'failed', error: 'did not answer its health check in time', log_tail: ['boom', 'trace'] } } })));
    expect(await service.open({ id: 'astro', name: 'Astro', icon: 'star', mode: 'supervised' }, { kind: 'view' })).toBe(false);
    expect(service.panel()?.failure).toEqual({ error: 'did not answer its health check in time', log: 'boom\ntrace' });
  });

  it('refuses to frame anything but the add-on proxy', () => {
    expect(() => service.adopt({ id: 'astro', name: 'A', icon: 'x' }, { ...opened, src: 'https://evil.example/' })).toThrow();
  });

  it('keeps the width within bounds', () => {
    service.setWidth(50, 1000);
    expect(service.width()).toBe(280);
    service.setWidth(5000, 1000);
    expect(service.width()).toBe(800);
  });

  it('remembers the open panel for this tab and reopens it after a reload with the same scope (#390)', async () => {
    const astro = { id: 'astro', name: 'Astro', icon: 'star', mode: 'external' as const };
    await service.openForCurrentView(astro);
    expect(service.restorable()).toEqual({ addonId: 'astro', scope: opened.scope });
    // A reload: a fresh service in the same tab.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [
      { provide: ApiService, useValue: { post } },
      { provide: GalleryStore, useValue: { selectionScope: signal('paths'), selectedPaths, filterPayload: () => ({}) } },
    ] });
    const reloaded = TestBed.inject(AddonPanelService);
    post.mockClear();
    expect(await reloaded.restore({ ...astro, id: 'other' })).toBe(false);
    expect(await reloaded.restore(astro)).toBe(true);
    expect(post).toHaveBeenCalledWith('/addons/astro/open', { scope: opened.scope });
    expect(reloaded.panel()?.nonce).toBe('n1');
    // Closed by the user: nothing to reopen.
    reloaded.close();
    expect(reloaded.restorable()).toBeNull();
  });

  it('forgets a panel that cannot be reopened, without an error line', async () => {
    sessionStorage.setItem(OPEN_PANEL_KEY, JSON.stringify({ addonId: 'astro', scope: { kind: 'view' } }));
    post.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 403, error: { detail: 'Scan access required.' } })));
    expect(await service.restore({ id: 'astro', name: 'Astro', icon: 'star', mode: 'external' })).toBe(false);
    expect(service.openError()).toBeNull();
    expect(service.restorable()).toBeNull();
  });
});
