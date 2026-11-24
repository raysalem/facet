import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';
import { provideRouter, RouteReuseStrategy, TitleStrategy, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { MAT_DATE_LOCALE, provideNativeDateAdapter } from '@angular/material/core';
import { MAT_SNACK_BAR_DEFAULT_OPTIONS, MatSnackBarConfig } from '@angular/material/snack-bar';
import { MAT_TOOLTIP_DEFAULT_OPTIONS, type MatTooltipDefaultOptions } from '@angular/material/tooltip';

import { routes } from './app.routes';
import { GalleryReuseStrategy } from './core/gallery-reuse.strategy';
import { I18nTitleStrategy } from './core/i18n-title.strategy';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { retryInterceptor } from './core/interceptors/retry.interceptor';
import { provideAgentTools } from './core/agent/agent-tools.bootstrap';
import { GlobalErrorHandler } from './core/services/global-error-handler.service';
import { I18nService } from './core/services/i18n.service';
import { SNACKBAR_LIFT_CLASS } from './shared/utils/mobile-bar';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    { provide: RouteReuseStrategy, useClass: GalleryReuseStrategy },
    { provide: TitleStrategy, useExisting: I18nTitleStrategy },
    provideHttpClient(withXhr(), withInterceptors([authInterceptor, errorInterceptor, retryInterceptor])),
    provideAnimations(),
    { provide: MAT_DATE_LOCALE, useValue: 'en-GB' },
    { provide: MAT_SNACK_BAR_DEFAULT_OPTIONS, useValue: { panelClass: [SNACKBAR_LIFT_CLASS] } satisfies MatSnackBarConfig },
    // A tooltip never takes the pointer: Material keeps an interactive tooltip open while the pointer is on it,
    // so one left over a neighbouring control (Card buttons over Details location, a rail tab over Display)
    // swallowed the click meant for that control.
    { provide: MAT_TOOLTIP_DEFAULT_OPTIONS, useValue: { showDelay: 0, hideDelay: 0, touchendHideDelay: 1500, disableTooltipInteractivity: true } satisfies MatTooltipDefaultOptions },
    provideNativeDateAdapter(),
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideAgentTools(),
    // The strings before the first render (B49): rendered before them, every label shows its key
    // ("gallery.selection.select"), the gallery header wraps to two rows and jumps back to one when they
    // land (CLS 0.14-0.36 on an album reload). Both loads swallow their own errors, so this never blocks.
    provideAppInitializer(async () => {
      const i18n = inject(I18nService);
      await i18n.loadLanguages();
      await i18n.load();
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      // Immediately: AppUpdateService checks for a newer build at startup, and the
      // 'registerWhenStable' wait (up to 30 s, longer while requests are in flight)
      // would leave the old cached shell running until it elapsed.
      registrationStrategy: 'registerImmediately',
    }),
  ],
};
