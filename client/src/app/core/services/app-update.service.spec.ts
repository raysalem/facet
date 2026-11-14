import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SwUpdate } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { I18N } from '../i18n/keys';
import {
  AppUpdateService, IDLE_RECHECK_INTERVAL_MS, PAGE_RELOAD, UNRECOVERABLE_RELOAD_WINDOW_MS, UPDATE_CHECK_INTERVAL_MS,
} from './app-update.service';
import { I18nService } from './i18n.service';

const ready = (hash: string) => ({ type: 'VERSION_READY', latestVersion: { hash } });
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('AppUpdateService', () => {
  let versionUpdates: Subject<unknown>;
  let unrecoverable: Subject<unknown>;
  let sw: {
    isEnabled: boolean; versionUpdates: Subject<unknown>; unrecoverable: Subject<unknown>;
    checkForUpdate: ReturnType<typeof vi.fn>; activateUpdate: ReturnType<typeof vi.fn>;
  };
  let reload: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  let onAction: Subject<void>;
  let dismiss: ReturnType<typeof vi.fn>;
  let dialogs: unknown[];

  function setup(isEnabled = true) {
    versionUpdates = new Subject();
    unrecoverable = new Subject();
    sw = {
      isEnabled, versionUpdates, unrecoverable,
      checkForUpdate: vi.fn(() => Promise.resolve(false)),
      activateUpdate: vi.fn(() => Promise.resolve(true)),
    };
    reload = vi.fn();
    onAction = new Subject<void>();
    dismiss = vi.fn();
    open = vi.fn(() => ({ onAction: () => onAction, dismiss }));
    dialogs = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: SwUpdate, useValue: sw },
        { provide: PAGE_RELOAD, useValue: reload },
        { provide: MatSnackBar, useValue: { open } },
        { provide: MatDialog, useValue: { get openDialogs() { return dialogs; } } },
        { provide: I18nService, useValue: { t: (k: string) => k } },
      ],
    });
    const service = TestBed.inject(AppUpdateService);
    service.start();
    return service;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });

  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does nothing without an enabled service worker', () => {
    setup(false);
    versionUpdates.next(ready('a'));
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  describe('looking for updates', () => {
    it('checks at startup, when the tab becomes visible, and on an interval', async () => {
      setup();
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
      expect(sw.checkForUpdate).toHaveBeenCalledTimes(3);
    });

    it('survives a failing check', async () => {
      setup();
      sw.checkForUpdate.mockRejectedValueOnce(new Error('offline'));
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(reload).not.toHaveBeenCalled();
    });
  });

  describe('VERSION_READY', () => {
    it('activates and reloads at once when the page is idle', async () => {
      setup();
      versionUpdates.next(ready('hash-1'));
      await flush();
      expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
    });

    it('ignores other version events', async () => {
      setup();
      versionUpdates.next({ type: 'VERSION_DETECTED' });
      await flush();
      expect(reload).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    });

    it('defers while a dialog is open, shows the banner, then reloads once it closes', async () => {
      setup();
      dialogs = [{}];
      versionUpdates.next(ready('hash-2'));
      await flush();
      expect(reload).not.toHaveBeenCalled();
      expect(sw.activateUpdate).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith(I18N.pwa.update_when_idle, I18N.pwa.reload, { duration: 0 });

      await vi.advanceTimersByTimeAsync(IDLE_RECHECK_INTERVAL_MS);
      expect(reload).not.toHaveBeenCalled();

      dialogs = [];
      await vi.advanceTimersByTimeAsync(IDLE_RECHECK_INTERVAL_MS);
      expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(dismiss).toHaveBeenCalled();
    });

    it('defers while a text field has focus', async () => {
      setup();
      const input = document.createElement('input');
      input.type = 'text';
      document.body.appendChild(input);
      input.focus();
      versionUpdates.next(ready('hash-3'));
      await flush();
      expect(reload).not.toHaveBeenCalled();
      input.blur();
      await vi.advanceTimersByTimeAsync(IDLE_RECHECK_INTERVAL_MS);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('does not treat a focused button as busy', async () => {
      setup();
      const button = document.createElement('button');
      document.body.appendChild(button);
      button.focus();
      versionUpdates.next(ready('hash-4'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('defers while an overlay with a backdrop (menu, select) is open', async () => {
      setup();
      document.body.innerHTML = '<div class="cdk-overlay-container"><div class="cdk-overlay-backdrop"></div></div>';
      versionUpdates.next(ready('hash-5'));
      await flush();
      expect(reload).not.toHaveBeenCalled();
      document.body.innerHTML = '';
      await vi.advanceTimersByTimeAsync(IDLE_RECHECK_INTERVAL_MS);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('rechecks when the tab is hidden, but never reloads over a busy page', async () => {
      setup();
      dialogs = [{}];
      versionUpdates.next(ready('hash-6'));
      await flush();
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(reload).not.toHaveBeenCalled();
      dialogs = [];
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('the banner action reloads immediately even while busy', async () => {
      setup();
      dialogs = [{}];
      versionUpdates.next(ready('hash-7'));
      await flush();
      onAction.next();
      await flush();
      expect(sw.activateUpdate).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('still reloads when activation fails', async () => {
      setup();
      sw.activateUpdate.mockRejectedValueOnce(new Error('no'));
      versionUpdates.next(ready('hash-8'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  describe('reload-loop guard', () => {
    it('reloads only once for the same build, then falls back to the banner', async () => {
      setup();
      versionUpdates.next(ready('same'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);

      // Same tab after the reload: the worker reports the same build ready again.
      TestBed.resetTestingModule();
      setup();
      versionUpdates.next(ready('same'));
      await flush();
      expect(reload).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith(I18N.pwa.update_available, I18N.pwa.reload, { duration: 0 });
    });

    it('reloads again for a different, newer build', async () => {
      setup();
      versionUpdates.next(ready('one'));
      await flush();
      TestBed.resetTestingModule();
      setup();
      versionUpdates.next(ready('two'));
      await flush();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('does not auto-reload when sessionStorage is unavailable', async () => {
      setup();
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
      versionUpdates.next(ready('x'));
      await flush();
      expect(reload).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith(I18N.pwa.update_available, I18N.pwa.reload, { duration: 0 });
    });
  });

  describe('unrecoverable', () => {
    it('reloads, and does not repeat inside the window', () => {
      setup();
      unrecoverable.next({ type: 'UNRECOVERABLE_STATE' });
      expect(reload).toHaveBeenCalledTimes(1);
      unrecoverable.next({ type: 'UNRECOVERABLE_STATE' });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalled();
    });

    it('reloads again after the window has passed', () => {
      setup();
      unrecoverable.next({});
      vi.setSystemTime(Date.now() + UNRECOVERABLE_RELOAD_WINDOW_MS + 1);
      unrecoverable.next({});
      expect(reload).toHaveBeenCalledTimes(2);
    });
  });
});
