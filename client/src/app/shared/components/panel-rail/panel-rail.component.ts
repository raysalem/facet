import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { AddonRail } from '../../../core/addons/addon-rail';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { i18nKeys } from '../../../core/i18n/keys';
import { PanelLayoutService } from '../../../core/services/panel-layout.service';

/** One of the page's own panels on the rail; `label` is an i18n key. */
export interface RailTab { id: string; icon: string; label: string }

/** The shell's add-on dock (`app-addon-sidebar`), which an add-on tab controls while the panels sit at the side. */
export const ADDON_DOCK_ID = 'addon-dock';

const TAB = 'inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--mat-sys-on-surface-variant)] hover:bg-[var(--mat-sys-surface-container-high)] focus-visible:outline-2 focus-visible:outline-[var(--mat-sys-primary)] max-sm:h-11 max-sm:w-11 pointer-coarse:h-11 pointer-coarse:w-11';

/**
 * The narrow icon rail beside a page's panel slot (Acrobat-style): the page's own panels, then one icon per
 * enabled add-on with a panel. The picked icon is highlighted; the state lives in the page's `AddonRail`.
 * A column at the side wherever the panels sit at the side (sm and up, or a phone set to Side); a row of tabs
 * on a phone's bottom sheet, where an add-on keeps its own drawer, so its icon is a plain toggle button there
 * and the page panel's tab stays the selected one. With every panel collapsed, the column starts with a
 * Show panel button that brings the last one back.
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
    class: 'flex shrink-0 items-center gap-1 border-[var(--mat-sys-outline-variant)] bg-[var(--mat-sys-surface-container-lowest)] p-1',
    '[class.border-y]': '!isWide()',
    '[class.w-11]': 'isWide()',
    '[class.flex-col]': 'isWide()',
    '[class.border-l]': 'isWide()',
  },
  template: `
    @if (isWide() && rail().tab() === null) {
      <!-- Its tooltip goes below: to the left it would cover the page toolbar's last button (Display) beside it. -->
      <button type="button" data-rail-expand [matTooltip]="I18N.ui.buttons.expand_panel | translate" matTooltipPosition="below"
        [attr.aria-label]="I18N.ui.buttons.expand_panel | translate" (click)="reopen()" [class]="TAB">
        <mat-icon aria-hidden="true">first_page</mat-icon>
      </button>
      <span aria-hidden="true" class="my-1 h-px w-6 shrink-0 bg-[var(--mat-sys-outline-variant)]"></span>
    }
    @for (tab of tabs(); track tab.id) {
      <button type="button" role="tab" [attr.id]="idPrefix() ? idPrefix() + '-rail-' + tab.id : null" [attr.aria-controls]="idPrefix() ? idPrefix() + '-panel-' + tab.id : null"
        [attr.data-rail-tab]="tab.id" [attr.aria-selected]="selectedPage() === tab.id" [attr.tabindex]="tabStop() === tab.id ? 0 : -1"
        [matTooltip]="tab.label | translate" matTooltipPosition="left" [attr.aria-label]="tab.label | translate" (click)="rail().select(tab.id)"
        [class]="TAB" [class.!bg-[var(--mat-sys-secondary-container)]]="selectedPage() === tab.id" [class.!text-[var(--mat-sys-on-secondary-container)]]="selectedPage() === tab.id">
        <mat-icon aria-hidden="true">{{ tab.icon }}</mat-icon>
      </button>
    }
    @if (rail().addons().length) {
      <span aria-hidden="true" class="shrink-0 bg-[var(--mat-sys-outline-variant)]" [class]="isWide() ? 'my-1 h-px w-6' : 'mx-1 h-6 w-px'"></span>
      @for (addon of rail().addons(); track addon.id) {
        @let picked = rail().tab() === 'addon:' + addon.id;
        @let usable = rail().usable(addon.id);
        <!-- The tab is named for its add-on; a viewer who may not open it hears why as its description (and sees it as the tooltip). -->
        @let tip = usable ? addon.name : ((rail().lockedReason() === 'locked' ? I18N.addons.panel.locked : I18N.addons.panel.admin_only) | translate: { name: addon.name });
        <button type="button" [attr.role]="isWide() ? 'tab' : null" [attr.data-rail-addon]="addon.id"
          [attr.aria-disabled]="usable ? null : 'true'" [attr.data-rail-addon-locked]="usable ? null : ''"
          [attr.aria-selected]="isWide() ? picked : null" [attr.aria-pressed]="isWide() ? null : picked"
          [attr.aria-controls]="isWide() && picked && rail().addonActive() ? ADDON_DOCK_ID : null"
          [attr.tabindex]="isWide() ? (tabStop() === 'addon:' + addon.id ? 0 : -1) : null"
          [matTooltip]="tip" matTooltipPosition="left" [attr.aria-label]="addon.name" [attr.aria-description]="usable ? null : tip" (click)="rail().selectAddon(addon)"
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
  /** Whether the rail is the side column; a page that renders the rail only at the side says so, else the layout decides. */
  readonly wide = input<boolean | undefined>(undefined);
  private readonly layout = inject(PanelLayoutService);
  protected readonly isWide = computed(() => this.wide() ?? this.layout.side());
  /** The page tab announced and highlighted as selected: in the side column the pick; in the phone row the page panel on screen. */
  protected readonly selectedPage = computed(() => this.isWide() ? this.rail().tab() : this.rail().shownPage());
  /** The one Tab stop: the picked tab, or the first one while no panel is open. */
  protected readonly tabStop = computed(() => this.selectedPage() ?? this.tabs()[0]?.id ?? null);

  /** Show panel: the panel last on screen, if this rail still offers it, else the first. */
  protected reopen(): void {
    this.rail().reopen(this.tabs().map(tab => tab.id));
  }
}
