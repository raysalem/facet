import { TestBed } from '@angular/core/testing';
import { PanelWidth } from './panel-width';

describe('PanelWidth', () => {
  const KEY = 'panel_width_spec';
  afterEach(() => { localStorage.removeItem(KEY); vi.unstubAllGlobals(); vi.restoreAllMocks(); TestBed.resetTestingModule(); });

  const create = (side: 'left' | 'right') =>
    TestBed.runInInjectionContext(() => new PanelWidth({ storageKey: KEY, defaultWidth: 300, min: 200, max: 400, side }));
  const target = () => {
    const element = document.createElement('div');
    element.setPointerCapture = vi.fn(); element.releasePointerCapture = vi.fn();
    return element;
  };
  const pointer = (type: string, clientX: number, currentTarget: HTMLElement, pointerId = 1) => {
    const event = new PointerEvent(type, { clientX, pointerId, isPrimary: true, button: 0 });
    Object.defineProperty(event, 'currentTarget', { value: currentTarget });
    return event;
  };

  it.each([['left', 350], ['right', 250]] as const)('a %s panel follows its handle 50px to the right to %ipx on release', (side, expected) => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const panel = create(side), handle = target();
    panel.start(pointer('pointerdown', 100, handle));
    panel.move(pointer('pointermove', 150, handle));
    panel.finish(pointer('pointerup', 150, handle));
    expect(panel.width()).toBe(expected);
    expect(localStorage.getItem(KEY)).toBe(String(expected));
  });

  it('clamps a drag and restores the starting width when the drag is cancelled', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const panel = create('right'), handle = target();
    panel.start(pointer('pointerdown', 500, handle));
    panel.move(pointer('pointermove', 0, handle));
    panel.finish(pointer('pointerup', 0, handle));
    expect(panel.width()).toBe(400);
    panel.start(pointer('pointerdown', 500, handle));
    panel.move(pointer('pointermove', 600, handle));
    panel.finish(pointer('pointercancel', 600, handle), true);
    expect(panel.width()).toBe(400);
  });

  it('falls back to the default width when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const panel = create('right');
    expect(panel.width()).toBe(300);
    panel.key(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(panel.width()).toBe(316);
  });
});
