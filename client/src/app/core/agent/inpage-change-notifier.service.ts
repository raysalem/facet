import { Injectable, effect, inject, untracked } from '@angular/core';
import { MatSnackBar, MatSnackBarRef, TextOnlySnackBar } from '@angular/material/snack-bar';
import { AuthService } from '../services/auth.service';
import { I18nService } from '../services/i18n.service';
import { I18N } from '../i18n/keys';

const SNACKBAR_MS = 8000;

/**
 * One non-blocking "Assistant changed N photos" snackbar per burst. Writes landing while it is open
 * raise its count instead of stacking. Its only action is Close.
 */
@Injectable({ providedIn: 'root' })
export class InpageChangeNotifier {
  private readonly snackBar = inject(MatSnackBar);
  private readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);
  private ref: MatSnackBarRef<TextOnlySnackBar> | null = null;
  private count = 0;
  /** The add-on behind every write of the open burst, else null (the assistant, or a mix). */
  private actor: string | null = null;

  constructor() {
    let first = true;
    effect(() => {
      this.auth.identity();
      untracked(() => {
        if (first) first = false;
        else this.dropBurst();
      });
    });
  }

  /** Record a write that changed `changed` photos; `actor` names the add-on that made it ("Astro changed 2 photos"). */
  notify(changed: number, actor?: string): void {
    if (changed <= 0) return;
    this.actor = this.count === 0 || this.actor === (actor ?? null) ? actor ?? null : null;
    this.count += changed;
    const keys = I18N.dialog.connect_assistant;
    const close = I18N.dialog.close;
    const one = this.count === 1;
    const message = this.actor
      ? this.i18n.t(one ? keys.addon_changed : keys.addon_changed_plural, { count: String(this.count), name: this.actor })
      : this.i18n.t(one ? keys.inpage_changed : keys.inpage_changed_plural, { count: String(this.count) });
    const ref = this.snackBar.open(message, this.i18n.t(close), { duration: SNACKBAR_MS });
    this.ref = ref;
    ref.afterDismissed().subscribe(() => {
      // A later write replaced this snackbar: only the one still current ends the burst.
      if (this.ref !== ref) return;
      this.ref = null;
      this.count = 0;
      this.actor = null;
    });
  }

  private dropBurst(): void {
    const ref = this.ref;
    this.ref = null;
    this.count = 0;
    this.actor = null;
    ref?.dismiss();
  }
}
