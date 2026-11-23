import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AddonRail } from '../../../core/addons/addon-rail';
import { AddonPanelService, type OpenPanel } from '../../../core/addons/addon-panel.service';
import { AuthService } from '../../../core/services/auth.service';
import { AddonsService } from '../../../core/services/addons.service';
import { I18nService } from '../../../core/services/i18n.service';
import { PanelRailComponent } from './panel-rail.component';

const panel = signal<OpenPanel | null>(null);
const astro = { id: 'astro', name: 'Astro', icon: 'star' };

@Component({
  imports: [PanelRailComponent],
  template: `<app-panel-rail [rail]="rail" [tabs]="tabs" label="Panels" idPrefix="page" [wide]="wide()" />`,
})
class HostComponent {
  readonly rail = new AddonRail<'content' | 'filter'>({ storageKey: 'panel_rail_spec', tabs: ['content', 'filter'], defaultTab: 'content' });
  readonly tabs = [{ id: 'content', icon: 'info', label: 'content' }, { id: 'filter', icon: 'filter_alt', label: 'filter' }];
  readonly wide = signal(true);
}

describe('PanelRailComponent', () => {
  beforeEach(() => {
    panel.set({ addon: astro, nonce: 'n1', src: '/addons/astro/', scope: { kind: 'view' } });
    TestBed.configureTestingModule({ providers: [
      { provide: AddonPanelService, useValue: { panel, dockHidden: signal(false), addonShown: signal(true), openForCurrentView: vi.fn() } },
      { provide: AuthService, useValue: { hasFeature: () => false } },
      { provide: I18nService, useValue: { t: (key: string) => key, translations: signal({}), currentLang: signal('en') } },
    ] });
  });
  afterEach(() => localStorage.removeItem('panel_rail_spec'));

  function render(wide: boolean) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.wide.set(wide);
    fixture.detectChanges(); TestBed.tick(); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      list: root.querySelector<HTMLElement>('app-panel-rail')!,
      content: root.querySelector<HTMLElement>('[data-rail-tab="content"]')!,
      addon: root.querySelector<HTMLElement>('[data-rail-addon="astro"]')!,
    };
  }

  it('at lg is a vertical tablist whose add-on tab is selected and controls the dock', () => {
    const { list, content, addon } = render(true);
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    expect(addon.getAttribute('role')).toBe('tab');
    expect(addon.getAttribute('aria-selected')).toBe('true');
    expect(addon.getAttribute('aria-controls')).toBe('addon-dock');
    expect(addon.getAttribute('tabindex')).toBe('0');
    expect(content.getAttribute('aria-selected')).toBe('false');
    expect(content.getAttribute('aria-controls')).toBe('page-panel-content');
  });

  it('below lg keeps the page panel on screen selected and makes the add-on a plain toggle', () => {
    const { list, content, addon } = render(false);
    expect(list.getAttribute('aria-orientation')).toBe('horizontal');
    expect(content.getAttribute('aria-selected')).toBe('true');
    expect(content.getAttribute('tabindex')).toBe('0');
    expect(addon.getAttribute('role')).toBeNull();
    expect(addon.getAttribute('aria-selected')).toBeNull();
    expect(addon.getAttribute('aria-pressed')).toBe('true');
    expect(addon.getAttribute('tabindex')).toBeNull();
  });

  it('shows a viewer who may not open add-ons the add-on tab by name, off, with the reason (B50)', () => {
    panel.set(null);
    const openForCurrentView = vi.fn();
    TestBed.overrideProvider(AddonPanelService, { useValue: { panel, dockHidden: signal(false), addonShown: signal(false), openForCurrentView } });
    TestBed.overrideProvider(AuthService, { useValue: { hasFeature: (key: string) => key === 'addons', isMultiUser: () => false } });
    TestBed.overrideProvider(AddonsService, { useValue: {
      available: signal(false), list: signal(null), names: signal([{ ...astro, slots: ['sidebar'] }]), sync: vi.fn() } });
    const { addon } = render(true);
    expect(addon).not.toBeNull();
    expect(addon.getAttribute('aria-disabled')).toBe('true');
    // Named for the add-on, the reason as its description (M3): a screen reader announced only the reason.
    expect(addon.getAttribute('aria-label')).toBe(astro.name);
    expect(addon.getAttribute('aria-description')).toBe('addons.panel.locked');
    addon.click();
    expect(openForCurrentView).not.toHaveBeenCalled();
  });
});
