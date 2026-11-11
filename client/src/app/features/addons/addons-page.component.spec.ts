import { signal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { AddonsPageComponent } from './addons-page.component';
import { AddonsService, type AddonList } from '../../core/services/addons.service';
import { I18nService } from '../../core/services/i18n.service';

function listing(): AddonList {
  return {
    addons_dir: 'C:/Facet/data/addons',
    addons: [
      { id: 'astro', name: 'Astro', version: '0.3.0', icon: 'star', facet_api: 1, slots: ['sidebar'],
        permissions: ['photos.read', 'gps.write'], mode: 'external', ui_path: '/', status: 'external', live_tokens: 0 },
      { id: 'local', name: 'Local', version: '1', icon: 'extension', facet_api: 1, slots: ['sidebar'],
        permissions: ['photos.read'], mode: 'supervised', ui_path: '/ui/', status: 'stopped', live_tokens: 0 },
    ],
    refused: [{ directory: 'broken', reason: 'unknown permissions: db.write' }],
  } as AddonList;
}

describe('Add-ons page', () => {
  let fixture: ComponentFixture<AddonsPageComponent>;
  let root: HTMLElement;
  const list = signal<AddonList | null>(null);
  const loadError = signal(false);
  let load: ReturnType<typeof vi.fn>;
  let mintToken: ReturnType<typeof vi.fn>;
  let revokeTokens: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    list.set(null); loadError.set(false);
    load = vi.fn(async () => { list.set(listing()); return list(); });
    mintToken = vi.fn(async (id: string) => ({ id: 7, addon_id: id, level: 'edition', token: 'fct_secret', scopes: [] }));
    revokeTokens = vi.fn(async () => undefined);
    TestBed.configureTestingModule({ imports: [AddonsPageComponent], providers: [
      { provide: AddonsService, useValue: { list, loadError, load, mintToken, revokeTokens } },
      { provide: I18nService, useValue: { t: (key: string, params?: Record<string, unknown>) => key + (params ? ' ' + Object.values(params).join(' ') : ''), translations: signal({}), currentLang: signal('en') } },
    ] });
    fixture = TestBed.createComponent(AddonsPageComponent);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  async function settle() { await Promise.resolve(); await Promise.resolve(); fixture.detectChanges(); }

  it('lists the installed add-ons, their permissions and the refused manifests with the reason', async () => {
    await settle();
    expect(load).toHaveBeenCalled();
    expect(root.querySelector('[data-addons-dir]')?.textContent).toContain('C:/Facet/data/addons');
    expect(root.querySelectorAll('[data-addon]')).toHaveLength(2);
    expect(root.querySelector('[data-addon="astro"]')?.textContent).toContain('addons.permission.gps.write');
    expect(root.querySelector('[data-addon="local"] [data-addon-status]')?.textContent).toContain('addons.status.stopped');
    expect(root.querySelector('[data-addons-refused]')?.textContent).toContain('unknown permissions: db.write');
  });

  it('offers a one-time token only for an external add-on and shows it once', async () => {
    await settle();
    expect(root.querySelector('[data-addon="local"] [data-addon-mint]')).toBeNull();
    (root.querySelector('[data-addon="astro"] [data-addon-mint]') as HTMLButtonElement).click();
    await settle();
    expect(mintToken).toHaveBeenCalledWith('astro');
    expect(root.querySelector('[data-addon="astro"] [data-addon-token]')?.textContent).toBe('fct_secret');
  });

  it('shows an alert when the token cannot be minted', async () => {
    await settle();
    mintToken.mockRejectedValueOnce(new Error('403'));
    (root.querySelector('[data-addon-mint]') as HTMLButtonElement).click();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('addons.token.error');
  });

  it('says so when nothing is installed', async () => {
    load.mockImplementationOnce(async () => { list.set({ addons_dir: '/d', addons: [], refused: [] } as AddonList); return list(); });
    fixture.componentInstance.ngOnInit();
    await settle();
    expect(root.querySelector('[data-addons-empty]')).not.toBeNull();
  });
});
