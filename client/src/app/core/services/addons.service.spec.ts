import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AddonsService } from './addons.service';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { ScanService } from './scan.service';

describe('AddonsService.sync', () => {
  const canLaunch = signal(false);
  let get: ReturnType<typeof vi.fn>;
  let service: AddonsService;
  const astro = { id: 'astro', name: 'Astro', icon: 'star', slots: ['sidebar'] };

  beforeEach(() => {
    canLaunch.set(false);
    get = vi.fn((url: string) => of(url === '/addons/names' ? { addons: [astro] } : { addons: [{ ...astro, mode: 'supervised' }], refused: [], addons_dir: '' }));
    TestBed.configureTestingModule({ providers: [
      { provide: ApiService, useValue: { get } },
      { provide: AuthService, useValue: { hasFeature: (key: string) => key === 'addons' } },
      { provide: ScanService, useValue: { canLaunch } },
    ] });
    service = TestBed.inject(AddonsService);
  });

  it('reads only the names while locked, the full list once unlocked (#389), and drops it again on lock', async () => {
    service.sync();
    await vi.waitFor(() => expect(service.names()).toEqual([astro]));
    expect(get).toHaveBeenCalledExactlyOnceWith('/addons/names');
    expect(service.list()).toBeNull();
    canLaunch.set(true);
    service.sync();
    await vi.waitFor(() => expect(service.list()?.addons[0].id).toBe('astro'));
    expect(get).toHaveBeenLastCalledWith('/addons');
    service.sync();
    expect(get).toHaveBeenCalledTimes(2);
    canLaunch.set(false);
    service.sync();
    expect(service.list()).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
