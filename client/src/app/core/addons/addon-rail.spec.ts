import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AddonRail } from './addon-rail';
import { AddonPanelService, type OpenPanel } from './addon-panel.service';
import { AuthService } from '../services/auth.service';
import { AddonsService, type AddonList } from '../services/addons.service';

describe('AddonRail', () => {
  const KEY = 'addon_rail_spec';
  const panel = signal<OpenPanel | null>(null);
  const dockHidden = signal(false);
  const addonShown = signal(false);
  const openForCurrentView = vi.fn(async () => true);
  const astro = { id: 'astro', name: 'Astro', icon: 'star' };

  beforeEach(() => {
    panel.set(null); dockHidden.set(false); addonShown.set(false); openForCurrentView.mockClear();
    TestBed.configureTestingModule({ providers: [
      { provide: AddonPanelService, useValue: { panel, dockHidden, addonShown, openForCurrentView } },
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

  it('closes every panel and the add-on with closeAll or Escape, also on a page that starts with a panel', () => {
    const close = vi.fn(() => panel.set(null));
    TestBed.overrideProvider(AddonPanelService, { useValue: { panel, dockHidden, addonShown, openForCurrentView, close } });
    const rail = create('view');
    TestBed.tick();
    open('n1');
    rail.closeAll(); TestBed.tick();
    expect(close).toHaveBeenCalledOnce();
    expect(rail.tab()).toBeNull();
    expect(rail.shownPage()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('');
    rail.select('view'); TestBed.tick();
    expect(rail.shownPage()).toBe('view');
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    handled.preventDefault();
    expect(rail.escape(handled)).toBe(false);
    expect(rail.escape(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))).toBe(true);
    expect(rail.tab()).toBeNull();
    TestBed.tick();
    // A page with a default panel still reopens closed.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [
      { provide: AddonPanelService, useValue: { panel, dockHidden, addonShown, openForCurrentView } },
      { provide: AuthService, useValue: { hasFeature: () => false } },
    ] });
    expect(create('view').tab()).toBeNull();
  });

  it('opens an add-on that is not open yet rather than picking an empty tab', () => {
    const rail = create('view');
    TestBed.tick();
    rail.selectAddon(astro);
    expect(openForCurrentView).toHaveBeenCalledWith(astro);
    expect(rail.tab()).toBe('view');
  });

  it('starts a newly built rail on the add-on when it is the panel being looked at (photo to gallery, back from Add-ons)', () => {
    panel.set({ addon: astro, nonce: 'n1', src: '/addons/astro/', scope: { kind: 'view' } });
    addonShown.set(true);
    localStorage.setItem(KEY, 'view');
    for (const defaultTab of ['view', null] as const) {
      const rail = create(defaultTab);
      TestBed.tick();
      expect(rail.tab()).toBe('addon:astro');
      expect(rail.addonActive()).toBe(true);
      expect(dockHidden()).toBe(false);
    }
  });

  it('leaves a remembered add-on tab when the open add-on is not the panel being looked at', () => {
    panel.set({ addon: astro, nonce: 'n1', src: '/addons/astro/', scope: { kind: 'view' } });
    localStorage.setItem(KEY, 'addon:astro');
    expect(create('view').tab()).toBe('view');
    localStorage.setItem(KEY, 'addon:astro');
    const rail = create(null);
    TestBed.tick();
    expect(rail.tab()).toBeNull();
    expect(dockHidden()).toBe(true);
  });

  it('records whether the add-on is the shown panel, so the next page can start from it', () => {
    const rail = create('view');
    TestBed.tick();
    open('n1');
    expect(addonShown()).toBe(true);
    rail.select('view'); TestBed.tick();
    expect(addonShown()).toBe(false);
    rail.selectAddon(astro); TestBed.tick();
    expect(addonShown()).toBe(true);
  });

  it('on return from parking, starts on an add-on opened meanwhile before deciding the dock (no flash)', () => {
    const rail = create(null);
    TestBed.tick();
    rail.release();
    panel.set({ addon: astro, nonce: 'n2', src: '/addons/astro/', scope: { kind: 'view' } });
    addonShown.set(true);
    rail.resume();
    expect(rail.tab()).toBe('addon:astro');
    expect(dockHidden()).toBe(false);
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

  it('shows the add-on tab as soon as an edition unlock lets the session read add-ons, and drops it on lock (#389)', () => {
    const available = signal(false);
    const list = signal<AddonList | null>(null);
    const item = { ...astro, slots: ['sidebar'], mode: 'supervised' } as unknown as AddonList['addons'][number];
    const sync = vi.fn(() => list.set(available() ? { addons: [item], refused: [], addons_dir: '' } as AddonList : null));
    TestBed.overrideProvider(AuthService, { useValue: { hasFeature: (key: string) => key === 'addons' } });
    TestBed.overrideProvider(AddonsService, { useValue: { available, list, sync } });
    const rail = create('view');
    TestBed.tick();
    expect(rail.addons()).toEqual([]);
    available.set(true); TestBed.tick();
    expect(rail.addons().map(addon => addon.id)).toEqual(['astro']);
    available.set(false); TestBed.tick();
    expect(rail.addons()).toEqual([]);
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it('opens again, after a reload, the add-on panel this page had open (#390)', async () => {
    const available = signal(true);
    const item = { ...astro, slots: ['sidebar'], mode: 'supervised' } as unknown as AddonList['addons'][number];
    const list = signal<AddonList | null>({ addons: [item], refused: [], addons_dir: '' } as AddonList);
    const restore = vi.fn(async () => { panel.set({ addon: astro, nonce: 'n9', src: '/addons/astro/', scope: { kind: 'view' } }); return true; });
    const restorable = () => ({ addonId: 'astro', scope: { kind: 'view' } });
    TestBed.overrideProvider(AuthService, { useValue: { hasFeature: (key: string) => key === 'addons' } });
    TestBed.overrideProvider(AddonsService, { useValue: { available, list, sync: vi.fn() } });
    TestBed.overrideProvider(AddonPanelService, { useValue: { panel, dockHidden, addonShown, openForCurrentView, restore, restorable } });
    localStorage.setItem(KEY, 'addon:astro');
    const rail = create('view');
    TestBed.tick();
    expect(restore).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'astro', mode: 'supervised' }));
    await Promise.resolve(); TestBed.tick();
    expect(rail.tab()).toBe('addon:astro');
    expect(dockHidden()).toBe(false);
    // A page remembered on its own panel reopens nothing.
    restore.mockClear(); panel.set(null);
    localStorage.setItem(KEY, 'view');
    create('view'); TestBed.tick();
    expect(restore).not.toHaveBeenCalled();
  });
});
