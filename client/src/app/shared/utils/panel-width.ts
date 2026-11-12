import { DestroyRef, inject, signal } from '@angular/core';

export interface PanelWidthOptions {
  /** localStorage key the committed width is remembered under. */
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** The page side the panel sits on: a left panel widens as its handle moves right, a right panel as it moves left. */
  side: 'left' | 'right';
}

/** Arrow keys move the handle by this many pixels; Home and End jump to the narrowest and widest panel. */
const KEY_STEP = 16;

/**
 * The user-resizable width of a side panel, for a `role="separator"` handle on its inner edge:
 * pointer drag (one pointer, rAF-throttled, Escape or a lost capture restores the starting width),
 * Arrow/Home/End keys, and the committed width remembered per `storageKey`.
 * Construct it in an injection context (a field initializer); the template binds the handle's
 * pointer and key events to `start`, `move`, `finish` and `key`.
 */
export class PanelWidth {
  readonly min: number;
  readonly max: number;
  readonly width = signal(0);
  private drag: { id: number; x: number; width: number; target: HTMLElement } | null = null;
  private frame: number | null = null;
  private pending: number | null = null;

  constructor(private readonly options: PanelWidthOptions) {
    this.min = options.min;
    this.max = options.max;
    this.width.set(this.stored());
    inject(DestroyRef).onDestroy(() => this.finishPointer(true));
  }

  private clamp(width: number): number { return Math.max(this.min, Math.min(this.max, width)); }

  private stored(): number {
    try {
      const stored = Number.parseInt(localStorage.getItem(this.options.storageKey) ?? '', 10);
      return Number.isFinite(stored) ? this.clamp(stored) : this.options.defaultWidth;
    } catch {
      return this.options.defaultWidth;
    }
  }

  private persist(): void {
    try { localStorage.setItem(this.options.storageKey, String(this.width())); } catch { /* Storage blocked: the width still applies, it is just not remembered. */ }
  }

  /** Pixels of width per pixel the handle moves right. */
  private get grow(): 1 | -1 { return this.options.side === 'left' ? 1 : -1; }

  start(event: PointerEvent): void {
    if (this.drag || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.focus();
    this.drag = { id: event.pointerId, x: event.clientX, width: this.width(), target };
    try { target.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer. */ }
  }

  move(event: PointerEvent): void {
    if (this.drag?.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    this.pending = this.drag.width + (event.clientX - this.drag.x) * this.grow;
    if (this.frame === null) this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.pending !== null) this.width.set(this.clamp(this.pending));
      this.pending = null;
    });
  }

  finish(event: PointerEvent, cancel = false): void {
    if (this.drag?.id === event.pointerId) this.finishPointer(cancel);
  }

  private finishPointer(cancel: boolean): void {
    const drag = this.drag;
    this.drag = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (!drag) { this.pending = null; return; }
    if (!cancel && this.pending !== null) this.width.set(this.clamp(this.pending));
    this.pending = null;
    if (cancel) this.width.set(drag.width);
    else this.persist();
    try { drag.target.releasePointerCapture(drag.id); } catch { /* Already released. */ }
  }

  key(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    if (event.key === 'Escape' && !this.drag) return;
    event.preventDefault(); event.stopPropagation();
    this.finishPointer(true);
    if (event.key === 'Escape') return;
    const next = event.key === 'Home' ? this.min : event.key === 'End' ? this.max
      : this.width() + (event.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP) * this.grow;
    this.width.set(this.clamp(next));
    this.persist();
  }
}
