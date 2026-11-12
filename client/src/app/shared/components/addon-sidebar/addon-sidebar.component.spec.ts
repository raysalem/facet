import { signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { AddonSidebarComponent } from './addon-sidebar.component';
import { AddonPanelService, type OpenPanel } from '../../../core/addons/addon-panel.service';
import { GalleryStore } from '../../../features/gallery/gallery.store';
import { WebMcpToolRegistry } from '../../../core/agent/webmcp-registry.service';
import { AssistantChangesService } from '../../../core/agent/assistant-changes.service';
import { I18nService } from '../../../core/services/i18n.service';

describe('add-on sidebar host', () => {
  let fixture: ComponentFixture<AddonSidebarComponent>;
  let root: HTMLElement;
  const panel = signal<OpenPanel | null>(null);
  const selectedPaths = signal(new Set<string>());
  const close = vi.fn();
  const execute = vi.fn(async () => ({ ok: true }));
  const report = vi.fn();
  const events = new Subject<unknown>();

  beforeEach(() => {
    close.mockReset(); execute.mockClear(); report.mockClear();
    panel.set({ addon: { id: 'astro', name: 'Astro', icon: 'star' }, nonce: 'nonce-1', src: '/addons/astro/ui/?nonce=nonce-1',
      scope: { kind: 'view', query: 'type=astro' } });
    selectedPaths.set(new Set(['/p/a.jpg']));
    TestBed.configureTestingModule({ imports: [AddonSidebarComponent], providers: [
      { provide: AddonPanelService, useValue: { panel, width: signal(380), close, setWidth: vi.fn() } },
      { provide: GalleryStore, useValue: { selectionScope: signal('paths'), selectedPaths } },
      { provide: WebMcpToolRegistry, useValue: { load: vi.fn(async () => undefined), execute } },
      { provide: AssistantChangesService, useValue: { report } },
      { provide: Router, useValue: { url: '/album/7', events } },
      { provide: I18nService, useValue: { t: (key: string) => key, translations: signal({}), currentLang: signal('en') } },
    ] });
    fixture = TestBed.createComponent(AddonSidebarComponent);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  function frame(): HTMLIFrameElement { return root.querySelector('iframe')!; }
  function send(data: unknown, source: unknown = frame().contentWindow): void {
    window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
  }

  it('frames the proxy URL in an allow-scripts-only sandbox without a referrer', () => {
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame().getAttribute('src')).toBe('/addons/astro/ui/?nonce=nonce-1');
  });

  it('ignores everything before a verified ready, then posts the context with the nonce', async () => {
    const posted = vi.spyOn(frame().contentWindow!, 'postMessage');
    send({ type: 'close', v: 1, nonce: 'nonce-1' });
    expect(close).not.toHaveBeenCalled();
    send({ type: 'ready', v: 1, nonce: 'wrong' });
    send({ type: 'ready', v: 1, nonce: 'nonce-1' }, window);
    fixture.detectChanges();
    expect(posted).not.toHaveBeenCalled();
    send({ type: 'ready', v: 1, nonce: 'nonce-1' });
    fixture.detectChanges();
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({
      type: 'context', v: 1, nonce: 'nonce-1', route: '/album/7', album_id: 7, selection: ['/p/a.jpg'],
      scope: { kind: 'view', query: 'type=astro' } }), '*');
  });

  it('re-sends the context when the selection changes', () => {
    const posted = vi.spyOn(frame().contentWindow!, 'postMessage');
    send({ type: 'ready', v: 1, nonce: 'nonce-1' });
    fixture.detectChanges();
    selectedPaths.set(new Set(['/p/b.jpg']));
    fixture.detectChanges();
    expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({ selection: ['/p/b.jpg'] }), '*');
  });

  it("keeps the handshake through the frame's load event (ready arrives first)", () => {
    // A page sends ready while loading; the iframe's load event fires afterwards. Resetting there dropped
    // every later request, so Google Earth / Maps and Show in Facet did nothing.
    send({ type: 'ready', v: 1, nonce: 'nonce-1' });
    frame().dispatchEvent(new Event('load'));
    send({ type: 'close', v: 1, nonce: 'nonce-1' });
    expect(close).toHaveBeenCalled();
  });

  it("shows a supervised add-on that didn't start, with its log, and no frame", () => {
    panel.set({ addon: { id: 'astro', name: 'Astro', icon: 'star' }, nonce: '', src: '', scope: { kind: 'view' },
      failure: { error: 'did not answer its health check in time', log: 'boom\ntrace' } });
    fixture.detectChanges();
    expect(root.querySelector('iframe')).toBeNull();
    const failure = root.querySelector('[data-addon-failure]')!;
    expect(failure.textContent).toContain('addons.not_started');
    expect(failure.textContent).toContain('health check');
    expect(failure.querySelector('pre')?.textContent).toBe('boom\ntrace');
  });

  it('routes verified panel requests to the existing handlers', async () => {
    send({ type: 'ready', v: 1, nonce: 'nonce-1' });
    send({ type: 'show_photos', v: 1, nonce: 'nonce-1', paths: ['/p/a.jpg'] });
    send({ type: 'open_photo', v: 1, nonce: 'nonce-1', path: '/p/a.jpg' });
    send({ type: 'refresh', v: 1, nonce: 'nonce-1', paths: ['/p/a.jpg'] });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenCalledWith('ui_show_photos', { paths: ['/p/a.jpg'] });
    expect(execute).toHaveBeenCalledWith('ui_open_photo', { path: '/p/a.jpg' });
    expect(report).toHaveBeenCalledWith({ tool: 'addon:astro', paths: ['/p/a.jpg'], count: 1 });
    send({ type: 'close', v: 1, nonce: 'nonce-1' });
    expect(close).toHaveBeenCalled();
  });
});
