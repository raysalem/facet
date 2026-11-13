import { TestBed } from '@angular/core/testing';
import { AnnotationViewService } from './annotation-view.service';

describe('AnnotationViewService', () => {
  let service: AnnotationViewService;
  beforeEach(() => {
    TestBed.resetTestingModule();
    service = TestBed.inject(AnnotationViewService);
  });

  it('starts empty: nothing is drawn by default', () => {
    expect(service.views()).toEqual({});
  });

  it('sets a view per source and replaces it on the next set', () => {
    service.set('astro-id', { visible: true });
    service.set('other', { visible: false });
    service.set('astro-id', { visible: true, score: 80 });
    expect(service.views()).toEqual({ 'astro-id': { visible: true, score: 80 }, other: { visible: false } });
  });

  it('clear removes only that source, and clearing an unknown source changes nothing', () => {
    service.set('astro-id', { visible: true });
    service.set('other', { visible: true });
    service.clear('astro-id');
    expect(Object.keys(service.views())).toEqual(['other']);
    const before = service.views();
    service.clear('nope');
    expect(service.views()).toBe(before);
  });
});
