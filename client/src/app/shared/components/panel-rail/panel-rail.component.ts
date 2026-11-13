import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { AddonRail } from '../../../core/addons/addon-rail';
import { TranslatePipe } from '../../pipes/translate.pipe';

/** One of the page's own panels on the rail; `label` is an i18n key. */
export interface RailTab { id: string; icon: string; label: string }

const TAB = 'inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--mat-sys-on-surface-variant)] hover:bg-[var(--mat-sys-surface-container-high)] focus-visible:outline-2 focus-visible:outline-[var(--mat-sys-primary)] max-sm:h-11 max-sm:w-11 pointer-coarse:h-11 pointer-coarse:w-11';

/**
 * The narrow icon rail beside a page's panel slot (Acrobat-style): the page's own panels, then one icon per
 * enabled add-on with a panel. The picked icon is highlighted; the state lives in the page's `AddonRail`.
 * A row of tabs below lg, a column at lg and up.
 */
@Component({
  selector: 'app-panel-rail',
  imports: [MatIconModule, MatTooltipModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'tablist',
    '[attr.aria-label]': 'label()',
    // The keys bubble here from the tabs, which are the focusable elements.
    '(keydown)': 'rail().key($event)',
    class: 'flex shrink-0 items-center gap-1 border-[var(--mat-sys-outline-variant)] bg-[var(--mat-sys-surface-container-lowest)] p-1 max-lg:border-y lg:w-11 lg:flex-col lg:border-l',
  },
  template: `
    @for (tab of tabs(); track tab.id) {
      <button type="button" role="tab" [attr.id]="idPrefix() ? idPrefix() + '-rail-' + tab.id : null" [attr.aria-controls]="idPrefix() ? idPrefix() + '-panel-' + tab.id : null"
        [attr.data-rail-tab]="tab.id" [attr.aria-selected]="rail().tab() === tab.id" [attr.tabindex]="tabStop() === tab.id ? 0 : -1"
        [matTooltip]="tab.label | translate" matTooltipPosition="left" [attr.aria-label]="tab.label | translate" (click)="rail().select(tab.id)"
        [class]="TAB" [class.!bg-[var(--mat-sys-secondary-container)]]="rail().tab() === tab.id" [class.!text-[var(--mat-sys-on-secondary-container)]]="rail().tab() === tab.id">
        <mat-icon aria-hidden="true">{{ tab.icon }}</mat-icon>
      </button>
    }
    @if (rail().addons().length) {
      <span aria-hidden="true" class="shrink-0 bg-[var(--mat-sys-outline-variant)] max-lg:mx-1 max-lg:h-6 max-lg:w-px lg:my-1 lg:h-px lg:w-6"></span>
      @for (addon of rail().addons(); track addon.id) {
        <button type="button" role="tab" [attr.data-rail-addon]="addon.id"
          [attr.aria-selected]="rail().tab() === 'addon:' + addon.id" [attr.tabindex]="tabStop() === 'addon:' + addon.id ? 0 : -1"
          [matTooltip]="addon.name" matTooltipPosition="left" [attr.aria-label]="addon.name" (click)="rail().selectAddon(addon)"
          [class]="TAB" [class.!bg-[var(--mat-sys-secondary-container)]]="rail().tab() === 'addon:' + addon.id" [class.!text-[var(--mat-sys-on-secondary-container)]]="rail().tab() === 'addon:' + addon.id">
          <mat-icon aria-hidden="true">{{ addon.icon }}</mat-icon>
        </button>
      }
    }
  `,
})
export class PanelRailComponent {
  protected readonly TAB = TAB;
  readonly rail = input.required<AddonRail<string>>();
  readonly tabs = input.required<readonly RailTab[]>();
  /** The rail's accessible name, already translated. */
  readonly label = input.required<string>();
  /** Gives the tabs ids (`<prefix>-rail-<id>`) and points them at their panels (`<prefix>-panel-<id>`). */
  readonly idPrefix = input<string | null>(null);
  /** The one Tab stop: the picked tab, or the first one while no panel is open. */
  protected readonly tabStop = computed(() => this.rail().tab() ?? this.tabs()[0]?.id ?? null);
}
