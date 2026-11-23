import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { AddonRail } from '../../../core/addons/addon-rail';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { i18nKeys } from '../../../core/i18n/keys';
import { LG_BREAKPOINT_PX, useDesktopSignal } from '../../utils/media-query';

/** One of the page's own panels on the rail; `label` is an i18n key. */
export interface RailTab { id: string; icon: string; label: string }

/** The shell's add-on dock (`app-addon-sidebar`), which an add-on tab controls at lg and up. */
export const ADDON_DOCK_ID = 'addon-dock';

const TAB = 'inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--mat-sys-on-surface-variant)] hover:bg-[var(--mat-sys-surface-container-high)] focus-visible:outline-2 focus-visible:outline-[var(--mat-sys-primary)] max-sm:h-11 max-sm:w-11 pointer-coarse:h-11 pointer-coarse:w-11';

/**
 * The narrow icon rail beside a page's panel slot (Acrobat-style): the page's own panels, then one icon per
 * enabled add-on with a panel. The picked icon is highlighted; the state lives in the page's `AddonRail`.
 * A row of tabs below lg, a column at lg and up. Below lg an add-on keeps its own dock or sheet beside the
 * page panel, so its icon is a plain toggle button there and the page panel's tab stays the selected one.
 */
@Component({
  selector: 'app-panel-rail',
  imports: [MatIconModule, MatTooltipModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'tablist',
    '[attr.aria-label]': 'label()',
    '[attr.aria-orientation]': 'isWide() ? "vertical" : "horizontal"',
    // The keys bubble here from the tabs, which are the focusable elements.
    '(keydown)': 'rail().key($event)',
    class: 'flex shrink-0 items-center gap-1 border-[var(--mat-sys-outline-variant)] bg-[var(--mat-sys-surface-container-lowest)] p-1 max-lg:border-y lg:w-11 lg:flex-col lg:border-l',
  },
  template: `
    @for (tab of tabs(); track tab.id) {
      <button type="button" role="tab" [attr.id]="idPrefix() ? idPrefix() + '-rail-' + tab.id : null" [attr.aria-controls]="idPrefix() ? idPrefix() + '-panel-' + tab.id : null"
        [attr.data-rail-tab]="tab.id" [attr.aria-selected]="selectedPage() === tab.id" [attr.tabindex]="tabStop() === tab.id ? 0 : -1"
        [matTooltip]="tab.label | translate" matTooltipPosition="left" [attr.aria-label]="tab.label | translate" (click)="rail().select(tab.id)"
        [class]="TAB" [class.!bg-[var(--mat-sys-secondary-container)]]="selectedPage() === tab.id" [class.!text-[var(--mat-sys-on-secondary-container)]]="selectedPage() === tab.id">
        <mat-icon aria-hidden="true">{{ tab.icon }}</mat-icon>
      </button>
    }
    @if (rail().addons().length) {
      <span aria-hidden="true" class="shrink-0 bg-[var(--mat-sys-outline-variant)] max-lg:mx-1 max-lg:h-6 max-lg:w-px lg:my-1 lg:h-px lg:w-6"></span>
      @for (addon of rail().addons(); track addon.id) {
        @let picked = rail().tab() === 'addon:' + addon.id;
        @let usable = rail().usable(addon.id);
        @let tip = usable ? addon.name : ((rail().lockedReason() === 'locked' ? I18N.addons.panel.locked : I18N.addons.panel.admin_only) | translate: { name: addon.name });
        <button type="button" [attr.role]="isWide() ? 'tab' : null" [attr.data-rail-addon]="addon.id"
          [attr.aria-disabled]="usable ? null : 'true'" [attr.data-rail-addon-locked]="usable ? null : ''"
          [attr.aria-selected]="isWide() ? picked : null" [attr.aria-pressed]="isWide() ? null : picked"
          [attr.aria-controls]="isWide() && picked && rail().addonActive() ? ADDON_DOCK_ID : null"
          [attr.tabindex]="isWide() ? (tabStop() === 'addon:' + addon.id ? 0 : -1) : null"
          [matTooltip]="tip" matTooltipPosition="left" [attr.aria-label]="tip" (click)="rail().selectAddon(addon)"
          [class]="TAB" [class.opacity-40]="!usable" [class.!cursor-not-allowed]="!usable" [class.!bg-[var(--mat-sys-secondary-container)]]="picked" [class.!text-[var(--mat-sys-on-secondary-container)]]="picked">
          <mat-icon aria-hidden="true">{{ addon.icon }}</mat-icon>
        </button>
      }
    }
  `,
})
export class PanelRailComponent {
  protected readonly TAB = TAB;
  protected readonly I18N = i18nKeys();
  protected readonly ADDON_DOCK_ID = ADDON_DOCK_ID;
  readonly rail = input.required<AddonRail<string>>();
  readonly tabs = input.required<readonly RailTab[]>();
  /** The rail's accessible name, already translated. */
  readonly label = input.required<string>();
  /** Gives the tabs ids (`<prefix>-rail-<id>`) and points them at their panels (`<prefix>-panel-<id>`). */
  readonly idPrefix = input<string | null>(null);
  /** Whether the rail is the lg-and-up column; a page that renders the rail only at lg says so, else the viewport decides. */
  readonly wide = input<boolean | undefined>(undefined);
  private readonly lg = useDesktopSignal({ breakpointPx: LG_BREAKPOINT_PX });
  protected readonly isWide = computed(() => this.wide() ?? this.lg.isDesktop());
  /** The page tab announced and highlighted as selected: at lg the pick; below lg the page panel on screen. */
  protected readonly selectedPage = computed(() => this.isWide() ? this.rail().tab() : this.rail().shownPage());
  /** The one Tab stop: the picked tab, or the first one while no panel is open. */
  protected readonly tabStop = computed(() => this.selectedPage() ?? this.tabs()[0]?.id ?? null);

  constructor() {
    this.lg.setup();
    inject(DestroyRef).onDestroy(() => this.lg.cleanup());
  }
}
