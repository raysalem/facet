import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, untracked, viewChild,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { Router, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AddonPanelService } from '../../../core/addons/addon-panel.service';
import { MAP_SITES, buildContext, readPanelMessage, type PanelRequest } from '../../../core/addons/addon-bridge';
import { GalleryStore } from '../../../features/gallery/gallery.store';
import { WebMcpToolRegistry } from '../../../core/agent/webmcp-registry.service';
import { AssistantChangesService } from '../../../core/agent/assistant-changes.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { i18nKeys } from '../../../core/i18n/keys';

/**
 * The add-on sidebar: the right-hand rail of the shell, so it survives navigation between the
 * gallery and a photo. It frames the add-on's panel through Facet's `/addons/<id>/` proxy in
 * `sandbox="allow-scripts"` (an opaque origin: no Facet cookie, storage or token reaches it) and
 * speaks postMessage v1 with it (`addon-bridge.ts`).
 */
@Component({
  selector: 'app-addon-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, TranslatePipe],
  host: {
    class: 'relative flex shrink-0 flex-col border-l border-[var(--mat-sys-outline-variant)] bg-[var(--mat-sys-surface-container-low)] max-w-[80vw]',
    '[style.width.px]': 'service.width()',
    '[attr.data-addon-sidebar]': 'panel()?.addon?.id ?? null',
    '(window:message)': 'onMessage($event)',
  },
  template: `
    @if (panel(); as open) {
      <!-- Drag to resize; arrow keys for keyboard users. -->
      <div role="separator" aria-orientation="vertical" tabindex="0" data-addon-resize
           [attr.aria-label]="I18N.addons.panel.resize | translate"
           class="absolute left-0 top-0 bottom-0 w-1.5 -ml-0.5 cursor-col-resize z-10 hover:bg-[var(--mat-sys-primary)] focus:bg-[var(--mat-sys-primary)]"
           (pointerdown)="startResize($event)" (keydown.arrowleft)="nudge(24)" (keydown.arrowright)="nudge(-24)"></div>
      <header class="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--mat-sys-outline-variant)] shrink-0">
        <mat-icon class="shrink-0">{{ open.addon.icon }}</mat-icon>
        <h2 class="m-0 min-w-0 flex-1 truncate text-sm font-medium">{{ open.addon.name }}</h2>
        <button mat-icon-button data-addon-close (click)="service.close()"
                [matTooltip]="I18N.addons.panel.close | translate" [attr.aria-label]="I18N.addons.panel.close | translate">
          <mat-icon>close</mat-icon>
        </button>
      </header>
      @if (open.failure; as failure) {
        <div class="flex-1 min-h-0 overflow-auto p-3" role="alert" data-addon-failure>
          <p class="m-0 mb-2 text-sm font-medium">{{ I18N.addons.not_started | translate: { name: open.addon.name } }}</p>
          @if (failure.error) { <p class="m-0 mb-2 text-sm">{{ failure.error }}</p> }
          <pre class="m-0 text-xs font-mono whitespace-pre-wrap opacity-80 bg-[var(--mat-sys-surface-container)] rounded p-2">{{ failure.log }}</pre>
        </div>
      } @else {
        <iframe #frame class="block flex-1 w-full min-h-0 border-0 bg-[var(--mat-sys-surface)]"
                [class.pointer-events-none]="resizing()"
                [src]="src()" sandbox="allow-scripts" referrerpolicy="no-referrer"
                [title]="open.addon.name" (load)="onFrameLoad()"></iframe>
      }
    }
  `,
})
export class AddonSidebarComponent {
  protected readonly I18N = i18nKeys();
  protected readonly service = inject(AddonPanelService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly router = inject(Router);
  private readonly gallery = inject(GalleryStore);
  private readonly tools = inject(WebMcpToolRegistry);
  private readonly changes = inject(AssistantChangesService);
  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  protected readonly panel = this.service.panel;
  protected readonly resizing = signal(false);
  /** 0 until the frame's current document sends a `ready` with our nonce; then a counter of readies. */
  private readonly handshake = signal(0);
  private readyCount = 0;
  private readonly url = toSignal(
    this.router.events.pipe(filter(e => e instanceof NavigationEnd), map(() => this.router.url)),
    { initialValue: this.router.url });

  /** The proxy URL is the one resource this component frames; the service checked its shape. */
  protected readonly src = computed(() => {
    const open = this.panel();
    return open?.src ? this.sanitizer.bypassSecurityTrustResourceUrl(open.src) : null;
  });

  private readonly selection = computed(() =>
    this.gallery.selectionScope() === 'paths' ? [...this.gallery.selectedPaths()] : []);

  constructor() {
    // A new panel needs a new handshake.
    effect(() => { this.panel(); untracked(() => this.handshake.set(0)); });
    // Context on open (after `ready`) and on every change of route or selection.
    effect(() => {
      const open = this.panel();
      const url = this.url();
      const selection = this.selection();
      if (!open || this.handshake() === 0) return;
      untracked(() => this.post(buildContext(open.nonce, url, selection, open.scope)));
    });
  }

  protected onFrameLoad(): void {
    this.handshake.set(0);
  }

  protected onMessage(event: MessageEvent): void {
    const open = this.panel();
    if (!open) return;
    const request = readPanelMessage(event, this.frame()?.nativeElement.contentWindow ?? null, open.nonce);
    if (!request) return;
    if (request.type === 'ready') {
      // First ready verifies the document; a later one asks for the context again.
      this.handshake.set(++this.readyCount);
      return;
    }
    if (this.handshake() === 0) return;
    void this.handle(request, open.addon.id);
  }

  private async handle(request: PanelRequest, addonId: string): Promise<void> {
    switch (request.type) {
      case 'ready':
        return;
      case 'close':
        this.service.close();
        return;
      case 'refresh':
        this.changes.report({ tool: `addon:${addonId}`, paths: request.paths, count: request.paths.length });
        return;
      case 'show_photos':
        await this.tools.load();
        await this.tools.execute('ui_show_photos', { paths: request.paths });
        return;
      case 'open_photo':
        await this.tools.load();
        await this.tools.execute('ui_open_photo', { path: request.path });
        return;
      case 'open_map':
        // A fixed URL picked by key (never one from the panel); no opener, no referrer.
        window.open(MAP_SITES[request.site], '_blank', 'noopener,noreferrer');
        return;
    }
  }

  /** Outbound only after a verified `ready`; an opaque origin leaves `"*"` as the only target. */
  private post(message: object): void {
    this.frame()?.nativeElement.contentWindow?.postMessage(message, '*');
  }

  protected nudge(delta: number): void {
    this.service.setWidth(this.service.width() + delta, window.innerWidth);
  }

  protected startResize(event: PointerEvent): void {
    const handle = event.target as HTMLElement;
    handle.setPointerCapture?.(event.pointerId);
    this.resizing.set(true);
    const move = (e: PointerEvent) => this.service.setWidth(window.innerWidth - e.clientX, window.innerWidth);
    const end = () => {
      this.resizing.set(false);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
