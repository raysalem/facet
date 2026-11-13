import { DestroyRef, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { AddonsService, type Addon } from '../services/addons.service';
import { AddonPanelService } from './addon-panel.service';

/** An add-on as a rail and the panel service know it. */
export type RailAddon = Pick<Addon, 'id' | 'name' | 'icon'> & Partial<Pick<Addon, 'mode'>>;

export interface AddonRailOptions<T extends string> {
  /** localStorage key the picked tab is remembered under. */
  storageKey: string;
  /** The page's own panels, in rail order. */
  tabs: readonly T[];
  /** The panel shown first, or null when the page starts with no panel and a second click on a tab closes it. */
  defaultTab: T | null;
  /** Also read the add-on registry when this says so (the photo page: a photo showing add-on tags). */
  needsRegistry?: () => boolean;
}

const ADDON_PREFIX = 'addon:';

/**
 * A page's right rail: it picks one of the page's own panels or an add-on's panel. The add-on's frame lives
 * in the shell's dock and is never moved (moving a frame reloads it): picking one of the page's panels hides
 * the dock at lg and up instead (`AddonPanelService.dockHidden`), and picking the add-on shows it again.
 * A panel opened from anywhere (toolbar, add-on menu, the rail) selects its tab; a closed one gives way.
 * Construct it in an injection context (a field initializer).
 */
export class AddonRail<T extends string> {
  private readonly panels = inject(AddonPanelService);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);
  private readonly options: AddonRailOptions<T>;
  /** `T`, `addon:<id>`, or null for no panel (only when `defaultTab` is null). */
  readonly tab = signal<string | null>(null);
  /** The page panel shown when no add-on is, and below lg where add-ons keep their own dock. */
  readonly pageTab = signal<T | null>(null);
  /** The installed add-ons, read once when this account has add-ons (or `needsRegistry` asks). */
  readonly registry = signal<readonly Addon[]>([]);
  /** Add-ons with a sidebar panel, plus the open panel's add-on when the registry has not been read. */
  readonly addons = computed<RailAddon[]>(() => {
    const listed: RailAddon[] = this.registry().filter(addon => addon.slots.includes('sidebar'));
    const open = this.panels.panel()?.addon;
    return open && !listed.some(addon => addon.id === open.id) ? [...listed, open] : listed;
  });
  /** An add-on's tab counts as picked only once its panel is open; until then the page panel stays. */
  readonly addonActive = computed(() => {
    const open = this.panels.panel();
    return !!open && this.tab() === ADDON_PREFIX + open.addon.id;
  });
  /** False while the host page is parked (detached by route reuse): another page owns the dock then. */
  private active = true;
  private lastPanel: string | null | undefined = undefined;
  private registryRequested = false;

  constructor(options: AddonRailOptions<T>) {
    this.options = options;
    const stored = this.read();
    const isPageTab = (value: string | null): value is T => value !== null && (options.tabs as readonly string[]).includes(value);
    this.tab.set(isPageTab(stored) || stored?.startsWith(ADDON_PREFIX) || (stored === '' && options.defaultTab === null) ? stored : options.defaultTab);
    this.pageTab.set(isPageTab(stored) ? stored : options.defaultTab);

    effect(() => {
      if (this.registryRequested || (!this.auth.hasFeature('addons') && !options.needsRegistry?.())) return;
      this.registryRequested = true;
      // Resolved only now: a page that needs no add-on never starts the add-on service.
      const addons = this.injector.get(AddonsService);
      untracked(async () => {
        const list = addons.list() ?? (addons.available() ? await addons.load() : null);
        if (list) this.registry.set(list.addons);
      });
    });
    effect(() => {
      const open = this.panels.panel();
      const key = open ? `${open.addon.id}|${open.nonce}` : null;
      const previous = this.lastPanel;
      this.lastPanel = key;
      untracked(() => {
        const tab = this.tab();
        if (open && previous !== undefined && key !== previous) this.tab.set(ADDON_PREFIX + open.addon.id);
        else if (tab?.startsWith(ADDON_PREFIX) && tab !== ADDON_PREFIX + open?.addon.id) this.tab.set(this.pageTab());
      });
    });
    effect(() => {
      const hidden = !this.addonActive();
      if (this.active) this.panels.dockHidden.set(hidden);
    });
    effect(() => {
      const tab = this.tab();
      try { localStorage.setItem(options.storageKey, tab ?? ''); } catch { /* Storage blocked: the pick holds for this page only. */ }
    });
    inject(DestroyRef).onDestroy(() => this.release());
  }

  private read(): string | null {
    try { return localStorage.getItem(this.options.storageKey); } catch { return null; }
  }

  /** Pick a page panel; a page that starts without one closes it on a second click. */
  select(tab: T): void {
    if (this.options.defaultTab === null && this.tab() === tab) {
      this.tab.set(null);
      this.pageTab.set(null);
      return;
    }
    this.pageTab.set(tab);
    this.tab.set(tab);
  }

  /** Show an add-on's panel; opening it (when another or none is open) selects its tab once it is there. */
  selectAddon(addon: RailAddon): void {
    const tab = ADDON_PREFIX + addon.id;
    if (this.panels.panel()?.addon.id !== addon.id) void this.panels.openForCurrentView(addon);
    else if (this.options.defaultTab === null && this.tab() === tab) this.tab.set(this.pageTab());
    else this.tab.set(tab);
  }

  /** Arrows, Home and End move focus along the rail (kept from the page's own keys); Enter or Space picks. */
  key(event: KeyboardEvent): void {
    const tabs = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement as HTMLElement);
    const target = index < 0 ? undefined : ({ ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 } as Record<string, number>)[event.key];
    if (target === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    tabs[(target + tabs.length) % tabs.length].focus();
  }

  /** The page left (destroyed or parked): other pages have no rail, so the dock shows again there. */
  release(): void {
    this.active = false;
    this.panels.dockHidden.set(false);
  }

  /** The parked page is back: it owns the dock again. */
  resume(): void {
    this.active = true;
    this.panels.dockHidden.set(!this.addonActive());
  }
}
