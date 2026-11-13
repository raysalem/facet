import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AddonRail } from './addon-rail';
import { AddonPanelService, type OpenPanel } from './addon-panel.service';
import { AuthService } from '../services/auth.service';

describe('AddonRail', () => {
  const KEY = 'addon_rail_spec';
  const panel = signal<OpenPanel | null>(null);
  const dockHidden = signal(false);
  const openForCurrentView = vi.fn(async () => true);
  const astro = { id: 'astro', name: 'Astro', icon: 'star' };

  beforeEach(() => {
    panel.set(null); dockHidden.set(false); openForCurrentView.mockClear();
    TestBed.configureTestingModule({ providers: [
      { provide: AddonPanelService, useValue: { panel, dockHidden, openForCurrentView } },
      { provide: AuthService, useValue: { hasFeature: () => false } },
    ] });
  });
  afterEach(() => { localStorage.removeItem(KEY); TestBed.resetTestingModule(); });

  const create = (defaultTab: 'view' | null) =>
    TestBed.runInInjectionContext(() => new AddonRail<'view'>({ storageKey: KEY, tabs: ['view'], defaultTab }));
  const open = (nonce: string) => { panel.set({ addon: astro, nonce, src: '/addons/astro/', scope: { kind: 'view' } }); TestBed.tick(); };

  it('starts without a panel when the page wants the room, and a second click closes the picked one', () => {
    const rail = create(null);
    TestBed.tick();
    expect(rail.tab()).toBeNull();
    rail.select('view'); TestBed.tick();
    expect(rail.tab()).toBe('view');
    expect(localStorage.getItem(KEY)).toBe('view');
    rail.select('view'); TestBed.tick();
    expect(rail.tab()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('');
  });

  it('selects an add-on panel opened anywhere, hides the dock while none of it shows, and closes on a second click', () => {
    const rail = create(null);
    TestBed.tick();
    expect(dockHidden()).toBe(true);
    open('n1');
    expect(rail.tab()).toBe('addon:astro');
    expect(dockHidden()).toBe(false);
    rail.selectAddon(astro); TestBed.tick();
    expect(openForCurrentView).not.toHaveBeenCalled();
    expect(rail.tab()).toBeNull();
    expect(dockHidden()).toBe(true);
    rail.selectAddon(astro); TestBed.tick();
    expect(dockHidden()).toBe(false);
    panel.set(null); TestBed.tick();
    expect(rail.tab()).toBeNull();
  });

  it('opens an add-on that is not open yet rather than picking an empty tab', () => {
    const rail = create('view');
    TestBed.tick();
    rail.selectAddon(astro);
    expect(openForCurrentView).toHaveBeenCalledWith(astro);
    expect(rail.tab()).toBe('view');
  });

  it('hands the dock back while its page is parked and takes it again on return', () => {
    const rail = create('view');
    TestBed.tick();
    open('n1');
    rail.select('view'); TestBed.tick();
    expect(dockHidden()).toBe(true);
    rail.release();
    expect(dockHidden()).toBe(false);
    panel.set({ addon: astro, nonce: 'n1', src: '/addons/astro/', scope: { kind: 'view' } }); TestBed.tick();
    expect(dockHidden()).toBe(false);
    rail.resume();
    expect(dockHidden()).toBe(true);
  });
});
