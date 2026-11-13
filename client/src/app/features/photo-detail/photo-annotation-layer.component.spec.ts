import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { I18nService } from '../../core/services/i18n.service';
import { AnnotationView, AnnotationViewService } from '../../core/annotations/annotation-view.service';
import { AnnotationPayload } from './annotations';
import { PhotoAnnotationLayerComponent } from './photo-annotation-layer.component';
import { PhotoAnnotationsState } from './photo-annotations.state';

const payload: AnnotationPayload = {
  version: 1,
  title: 'Sky annotations',
  image: { width: 1000, height: 500 },
  legend: 'ASTAP grade A',
  groups: [
    { id: 'planet', label: 'Planets', default: true },
    { id: 'star', label: 'Stars', default: false },
  ],
  metrics: [{ key: 'mag', label: 'Max magnitude', min: -5, max: 8, step: 0.5, default: 6, direction: 'max' }],
  score: { label: 'Confidence', min: 0, max: 100, default: 65 },
  items: [
    { id: 'uranus', label: 'Uranus', group: 'planet', score: 100, shape: 'point', x: 100, y: 100, r: 5, values: { mag: 5.6 } },
    { id: 'm45', label: 'M45', group: 'planet', score: 70, shape: 'circle', x: 600, y: 300, r: 40, values: { mag: 1.6 } },
    { id: 'orion', label: 'Orion', group: 'planet', score: 100, shape: 'lines', segments: [[[0, 0], [50, 50]]], label_at: [700, 50] },
    { id: 'vega', label: 'Vega', group: 'star', score: 100, shape: 'point', x: 300, y: 400, values: { mag: 0 } },
    { id: 'weak', label: 'Weak', group: 'planet', score: 30, shape: 'point', x: 900, y: 450 },
  ],
};

@Component({
  selector: 'app-annotations-host',
  imports: [PhotoAnnotationLayerComponent],
  providers: [PhotoAnnotationsState],
  template: `<div class="relative"><app-photo-annotation-layer transform="scale(2)" /></div>`,
})
class HostComponent {
  readonly state = inject(PhotoAnnotationsState);
}

describe('photo annotations layer', () => {
  let api: { get: ReturnType<typeof vi.fn> };

  async function render(view: AnnotationView | null = { visible: true }, response: unknown = { annotations: [{ source: 'astro-id', payload }] }) {
    TestBed.resetTestingModule();
    api = { get: vi.fn(() => of(response)) };
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: I18nService, useValue: { t: (k: string, v?: Record<string, unknown>) => (v ? `${k} ${JSON.stringify(v)}` : k), translations: () => ({}) } },
      ],
    });
    if (view) TestBed.inject(AnnotationViewService).set('astro-id', view);
    const fixture = TestBed.createComponent(HostComponent);
    await fixture.componentInstance.state.load('/sky.jpg');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const labels = (el: HTMLElement) => [...el.querySelectorAll('[data-annotation-layer] text')].map((t) => t.textContent!.trim());

  it('reads the photo annotations once and draws the default selection with plain labels', async () => {
    const fixture = await render();
    expect(api.get).toHaveBeenCalledWith('/photo/annotations', { path: '/sky.jpg' });
    const el: HTMLElement = fixture.nativeElement;
    const svg = el.querySelector('[data-annotation-layer]')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 1000 500');
    expect((svg as SVGElement).style.transform).toBe('scale(2)');
    expect(labels(el)).toEqual(['Uranus', 'M45', 'Orion']);
  });

  it('draws each shape in the payload frame', async () => {
    const el: HTMLElement = (await render()).nativeElement;
    const circles = [...el.querySelectorAll('[data-annotation-layer] circle')];
    expect(circles.some((c) => c.getAttribute('cx') === '600' && c.getAttribute('r') === '40')).toBe(true);
    expect(el.querySelector('[data-annotation-layer] path')!.getAttribute('d')).toBe('M0 0L50 50');
  });

  it('filters live as the add-on changes its view, without re-fetching', async () => {
    const fixture = await render();
    TestBed.inject(AnnotationViewService).set('astro-id', {
      visible: true, score: 80, groups: { star: true }, metrics: { mag: 1 },
    });
    fixture.detectChanges();
    expect(labels(fixture.nativeElement)).toEqual(['Orion', 'Vega']);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('shows scores only on request, and the full tooltip on hover', async () => {
    const fixture = await render({ visible: true, show_scores: true });
    expect(labels(fixture.nativeElement)[0]).toBe('Uranus 100');
    TestBed.inject(AnnotationViewService).set('astro-id', { visible: true, show_scores: false });
    fixture.detectChanges();
    const g = fixture.nativeElement.querySelector('[data-annotation]') as SVGGElement;
    g.dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();
    expect(labels(fixture.nativeElement)[0]).toBe('Uranus · Confidence 100 · mag 5.6');
    expect(g.querySelector('title')!.textContent).toBe('Uranus · Confidence 100 · mag 5.6');
  });

  it('is hidden by default: a source with no view draws nothing', async () => {
    const fixture = await render(null);
    expect(fixture.componentInstance.state.annotations().length).toBe(1);
    expect(fixture.nativeElement.querySelector('[data-annotation-layer]')).toBeNull();
  });

  it('draws nothing while the add-on view is not visible, and again when it is', async () => {
    const fixture = await render({ visible: false });
    expect(fixture.nativeElement.querySelector('[data-annotation-layer]')).toBeNull();
    TestBed.inject(AnnotationViewService).set('astro-id', { visible: true });
    fixture.detectChanges();
    expect(labels(fixture.nativeElement)).toEqual(['Uranus', 'M45', 'Orion']);
    TestBed.inject(AnnotationViewService).clear('astro-id');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-annotation-layer]')).toBeNull();
  });

  it('ignores the view of an add-on that wrote no annotations here', async () => {
    const fixture = await render(null);
    TestBed.inject(AnnotationViewService).set('someone-else', { visible: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-annotation-layer]')).toBeNull();
  });

  it('ignores payloads it cannot draw', async () => {
    const fixture = await render({ visible: true }, { annotations: [{ source: 'x', payload: { version: 2, items: [] } }] });
    expect(fixture.componentInstance.state.annotations()).toEqual([]);
  });

  it('drops a response for a photo the user already left', async () => {
    const slow = new Subject<unknown>();
    TestBed.resetTestingModule();
    api = { get: vi.fn(() => slow) };
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }, PhotoAnnotationsState] });
    const state = TestBed.inject(PhotoAnnotationsState);
    const first = state.load('/a.jpg');
    void state.load(null);
    slow.next({ annotations: [{ source: 'astro-id', payload }] });
    slow.complete();
    await first;
    expect(state.annotations()).toEqual([]);
  });
});
