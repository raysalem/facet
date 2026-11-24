import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { i18nKeys } from '../../../core/i18n/keys';
import { I18nService } from '../../../core/services/i18n.service';
import { PanelWidth } from '../../utils/panel-width';

/**
 * The drag handle on a side panel's inner edge, driving a {@link PanelWidth}:
 * a `role="separator"` that is dragged with the pointer or moved with the
 * arrow keys, Home and End once focused. A short grip stays visible so the
 * edge reads as draggable (with a col-resize cursor and a how-to tooltip);
 * the full-height line lights up on hover, focus and while dragging. The caller places it (display and position classes), since
 * a panel that clips its overflow needs it inside, and one that does not can
 * have it straddle the border.
 */
@Component({
  selector: 'app-panel-resize-handle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'separator',
    tabindex: '0',
    'aria-orientation': 'vertical',
    'data-panel-resize': '',
    class: 'group z-10 w-3 shrink-0 cursor-col-resize touch-none select-none items-center justify-center outline-none',
    '[attr.aria-label]': 'label()',
    '[attr.title]': 'hint()',
    '[attr.aria-valuemin]': 'panel().min',
    '[attr.aria-valuemax]': 'panel().max',
    '[attr.aria-valuenow]': 'panel().width()',
    '[attr.data-dragging]': 'panel().dragging() || null',
    '(pointerdown)': 'panel().start($event)',
    '(pointermove)': 'panel().move($event)',
    '(pointerup)': 'panel().finish($event)',
    '(pointercancel)': 'panel().finish($event, true)',
    '(lostpointercapture)': 'panel().finish($event, true)',
    '(keydown)': 'panel().key($event)',
  },
  template: `
    <span aria-hidden="true" class="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-[var(--mat-sys-primary)] group-focus-visible:bg-[var(--mat-sys-primary)]"
          [class.bg-[var(--mat-sys-primary)]]="panel().dragging()"></span>
    <span aria-hidden="true" class="relative block h-10 w-1.5 rounded-full bg-[var(--mat-sys-outline)] shadow-sm"></span>
  `,
})
export class PanelResizeHandleComponent {
  /** The width the handle drives; its min, max and current width are announced. */
  readonly panel = input.required<PanelWidth>();
  /** What the handle resizes, e.g. "Resize photo details panel". */
  readonly label = input.required<string>();
  private readonly i18n = inject(I18nService);
  /** How to use it, as the pointer's tooltip: the separator role alone does not say "drag me". */
  protected readonly hint = computed(() => this.i18n.t(i18nKeys().ui.labels.resize_hint));
}
