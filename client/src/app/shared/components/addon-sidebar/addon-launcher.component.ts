import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AddonsService, type Addon } from '../../../core/services/addons.service';
import { AddonPanelService } from '../../../core/addons/addon-panel.service';
import { I18nService } from '../../../core/services/i18n.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { I18N, i18nKeys } from '../../../core/i18n/keys';

/**
 * The header's add-on button: opens an add-on's sidebar for what the tab shows now (the selection,
 * else the current view). Only add-ons that declare the `sidebar` slot are offered.
 */
@Component({
  selector: 'app-addon-launcher',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, TranslatePipe],
  host: { class: 'contents' },
  template: `
    <button mat-icon-button data-addon-launcher [matMenuTriggerFor]="addonMenu" (menuOpened)="refresh()"
            [matTooltip]="I18N.addons.launcher | translate" [attr.aria-label]="I18N.addons.launcher | translate">
      <mat-icon>extension</mat-icon>
    </button>
    <mat-menu #addonMenu="matMenu">
      @for (addon of sidebars(); track addon.id) {
        <button mat-menu-item [attr.data-addon-launch]="addon.id" (click)="open(addon)">
          <mat-icon>{{ addon.icon }}</mat-icon>{{ addon.name }}
        </button>
      } @empty {
        <p class="px-4 py-2 m-0 text-sm opacity-70">{{ I18N.addons.launcher_empty | translate }}</p>
      }
    </mat-menu>
  `,
})
export class AddonLauncherComponent {
  protected readonly I18N = i18nKeys();
  private readonly addons = inject(AddonsService);
  private readonly panels = inject(AddonPanelService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly i18n = inject(I18nService);

  protected readonly sidebars = computed(() => (this.addons.list()?.addons ?? []).filter(a => a.slots.includes('sidebar')));

  protected refresh(): void {
    void this.addons.load();
  }

  protected async open(addon: Addon): Promise<void> {
    if (!await this.panels.openForCurrentView(addon)) {
      this.snackBar.open(this.i18n.t(I18N.addons.open_error, { detail: this.panels.openError() ?? addon.name }), '', { duration: 6000 });
    }
  }
}
