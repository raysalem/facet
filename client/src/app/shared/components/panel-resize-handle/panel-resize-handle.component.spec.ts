import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { I18nService } from '../../../core/services/i18n.service';
import { PanelWidth } from '../../utils/panel-width';
import { PanelResizeHandleComponent } from './panel-resize-handle.component';

const KEY = 'panel_resize_handle_spec';

@Component({
  imports: [PanelResizeHandleComponent],
  template: `<div class="flex"><app-panel-resize-handle class="relative flex" [panel]="width" label="Resize the test panel" />
    <aside data-panel [style.width.px]="width.width()"></aside></div>`,
})
class HostComponent {
  readonly width = new PanelWidth({ storageKey: KEY, defaultWidth: 320, min: 288, max: 560, side: 'right' });
}

describe('PanelResizeHandleComponent', () => {
  const i18n = { t: vi.fn((key: string) => key) };

  function render() {
    TestBed.configureTestingModule({ imports: [HostComponent], providers: [{ provide: I18nService, useValue: i18n }] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const handle = root.querySelector<HTMLElement>('app-panel-resize-handle')!;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    const panel = root.querySelector<HTMLElement>('[data-panel]')!;
    return { fixture, handle, panel };
  }

  const pointer = (handle: HTMLElement, type: string, clientX: number) =>
    handle.dispatchEvent(new PointerEvent(type, { clientX, pointerId: 7, isPrimary: true, button: 0, bubbles: true }));

  beforeEach(() => {
    // Run the drag's rAF-throttled update at once, so each move is visible to the test.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => { localStorage.removeItem(KEY); vi.unstubAllGlobals(); TestBed.resetTestingModule(); });

  it('is a focusable, labelled vertical separator announcing the width range', () => {
    const { handle } = render();
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-label')).toBe('Resize the test panel');
    expect([handle.getAttribute('aria-valuemin'), handle.getAttribute('aria-valuemax'), handle.getAttribute('aria-valuenow')])
      .toEqual(['288', '560', '320']);
  });

  it('shows that it can be dragged: a resize cursor, a how-to tooltip and a visible grip', () => {
    const { handle } = render();
    expect(handle.classList).toContain('cursor-col-resize');
    expect(handle.getAttribute('title')).toBe('ui.labels.resize_hint');
    const grip = handle.querySelectorAll('span')[1];
    expect(grip.className).toContain('bg-[var(--mat-sys-outline)]');
    expect(grip.className).toContain('h-10');
  });

  it('dragging the handle left widens a right-side panel, lights the line meanwhile, and remembers the width', () => {
    const { fixture, handle, panel } = render();
    expect(panel.style.width).toBe('320px');
    pointer(handle, 'pointerdown', 500);
    pointer(handle, 'pointermove', 400);
    fixture.detectChanges();
    expect(panel.style.width).toBe('420px');
    expect(handle.getAttribute('data-dragging')).toBe('true');
    expect(handle.querySelector('span')!.classList).toContain('bg-[var(--mat-sys-primary)]');
    pointer(handle, 'pointerup', 400);
    fixture.detectChanges();
    expect(panel.style.width).toBe('420px');
    expect(handle.getAttribute('data-dragging')).toBeNull();
    expect(handle.getAttribute('aria-valuenow')).toBe('420');
    expect(localStorage.getItem(KEY)).toBe('420');
  });

  it('a new panel starts at the remembered width', () => {
    localStorage.setItem(KEY, '480');
    expect(render().panel.style.width).toBe('480px');
  });

  it('moves with the arrow keys, Home and End', () => {
    const { fixture, handle, panel } = render();
    const key = (name: string) => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); fixture.detectChanges(); };
    key('ArrowLeft'); expect(panel.style.width).toBe('336px');
    key('End'); expect(panel.style.width).toBe('560px');
    key('Home'); expect(panel.style.width).toBe('288px');
    expect(localStorage.getItem(KEY)).toBe('288');
  });
});
