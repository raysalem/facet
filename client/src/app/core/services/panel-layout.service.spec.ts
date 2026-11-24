import { TestBed } from '@angular/core/testing';
import { PanelLayoutService } from './panel-layout.service';

describe('PanelLayoutService', () => {
  afterEach(() => {
    localStorage.removeItem('facet_phone_panel');
    document.documentElement.removeAttribute('data-side-panels');
    vi.unstubAllGlobals();
  });

  it('puts the panels at the side from sm, and marks <html> so templates can lay out with in-data-side-panels:', () => {
    const layout = TestBed.inject(PanelLayoutService);
    layout.setWide(true);
    TestBed.tick();
    expect(layout.side()).toBe(true);
    expect(layout.phone()).toBe(false);
    expect(document.documentElement.hasAttribute('data-side-panels')).toBe(true);
    layout.setWide(false);
    TestBed.tick();
    expect(layout.side()).toBe(false);
    expect(document.documentElement.hasAttribute('data-side-panels')).toBe(false);
  });

  it('reads the viewport through the sm media query', () => {
    vi.stubGlobal('matchMedia', (media: string) => ({ matches: media === '(min-width: 640px)', media, addEventListener() {}, removeEventListener() {} }));
    expect(TestBed.inject(PanelLayoutService).side()).toBe(true);
  });

  it('a phone keeps the bottom sheet by default; set to Side, it gets the side panels too, remembered', () => {
    const layout = TestBed.inject(PanelLayoutService);
    layout.setWide(false);
    expect(layout.phonePanel()).toBe('sheet');
    expect(layout.side()).toBe(false);
    layout.setPhonePanel('side');
    expect(layout.side()).toBe(true);
    expect(localStorage.getItem('facet_phone_panel')).toBe('side');
    TestBed.resetTestingModule();
    expect(TestBed.inject(PanelLayoutService).phonePanel()).toBe('side');
  });
});
