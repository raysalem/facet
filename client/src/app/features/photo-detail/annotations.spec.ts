import {
  ANNOTATION_LABEL_SCALE, ANNOTATION_SETTINGS_KEY, AnnotationItem, AnnotationPayload, annotationTooltip,
  defaultAnnotationSettings, filterAnnotationItems, isDrawablePayload, layoutAnnotations, mergeAnnotationSettings,
  readAnnotationSettings, readAnnotationsEnabled, writeAnnotationSettings, writeAnnotationsEnabled,
} from './annotations';

function payload(items: AnnotationItem[], over: Partial<AnnotationPayload> = {}): AnnotationPayload {
  return {
    version: 1,
    title: 'Sky',
    image: { width: 1000, height: 500 },
    groups: [
      { id: 'planet', label: 'Planets', default: true },
      { id: 'star', label: 'Stars', default: false },
    ],
    metrics: [{ key: 'mag', label: 'Max magnitude', min: -5, max: 8, step: 0.5, default: 6, direction: 'max' }],
    score: { label: 'Confidence', min: 0, max: 100, default: 65 },
    items,
    ...over,
  };
}

const uranus: AnnotationItem = { id: 'uranus', label: 'Uranus', group: 'planet', score: 100, shape: 'point', x: 100, y: 100, r: 5, values: { mag: 5.6 } };
const faint: AnnotationItem = { id: 'faint', label: 'Faint', group: 'planet', score: 90, shape: 'point', x: 600, y: 100, values: { mag: 7.5 } };
const weak: AnnotationItem = { id: 'weak', label: 'Weak', group: 'planet', score: 40, shape: 'point', x: 800, y: 300 };
const vega: AnnotationItem = { id: 'vega', label: 'Vega', group: 'star', score: 100, shape: 'point', x: 300, y: 300, values: { mag: 0 } };
const nomag: AnnotationItem = { id: 'nomag', label: 'NoMag', group: 'planet', score: 80, shape: 'circle', x: 400, y: 400, r: 30 };
const belt: AnnotationItem = { id: 'belt', label: 'Belt', group: 'planet', score: 95, shape: 'lines', segments: [[[0, 0], [10, 10]]], label_at: [5, 5] };
const alnilam: AnnotationItem = { id: 'alnilam', label: 'Alnilam', group: 'planet', score: 99, shape: 'point', x: 6, y: 6, member_of: 'belt' };

const ids = (items: AnnotationItem[]) => items.map((i) => i.id);

describe('annotation settings', () => {
  it('defaults honour group defaults, slider defaults, and plain labels', () => {
    expect(defaultAnnotationSettings(payload([]))).toEqual({
      groups: { planet: true, star: false }, score: 65, metrics: { mag: 6 }, showScores: false, showMembers: false,
    });
  });

  it('a metric without a default starts at its max, a payload without score has none', () => {
    const p = payload([], { metrics: [{ key: 'm', min: 0, max: 3 }], score: undefined });
    expect(defaultAnnotationSettings(p).metrics).toEqual({ m: 3 });
    expect(defaultAnnotationSettings(p).score).toBeNull();
  });

  it('merge keeps valid stored values, clamps ranges and ignores junk', () => {
    const p = payload([]);
    const merged = mergeAnnotationSettings(p, {
      groups: { star: true, gone: true, planet: 'yes' }, score: 500, metrics: { mag: -9, other: 2 }, showScores: true, showMembers: 1,
    });
    expect(merged).toEqual({ groups: { planet: true, star: true }, score: 100, metrics: { mag: -5 }, showScores: true, showMembers: false });
    expect(mergeAnnotationSettings(p, 'nonsense')).toEqual(defaultAnnotationSettings(p));
  });
});

describe('filterAnnotationItems', () => {
  const p = payload([uranus, faint, weak, vega, nomag]);

  it('applies group, score and metric filters with the payload defaults', () => {
    expect(ids(filterAnnotationItems(p, defaultAnnotationSettings(p)))).toEqual(['uranus', 'nomag']);
  });

  it('a group toggle shows its items', () => {
    const s = { ...defaultAnnotationSettings(p), groups: { planet: true, star: true } };
    expect(ids(filterAnnotationItems(p, s))).toContain('vega');
  });

  it('lowering the score and raising the magnitude limit lets more through', () => {
    const s = { ...defaultAnnotationSettings(p), score: 0, metrics: { mag: 8 } };
    expect(ids(filterAnnotationItems(p, s))).toEqual(['uranus', 'faint', 'weak', 'nomag']);
  });

  it('an item without the metric value is not filtered by it', () => {
    const s = { ...defaultAnnotationSettings(p), metrics: { mag: -5 } };
    expect(ids(filterAnnotationItems(p, s))).toEqual(['nomag']);
  });

  it('a min-direction metric keeps values at or above the slider', () => {
    const q = payload([uranus, faint], { metrics: [{ key: 'mag', min: 0, max: 10, default: 6, direction: 'min' }] });
    expect(ids(filterAnnotationItems(q, defaultAnnotationSettings(q)))).toEqual(['faint']);
  });

  it('members hide while their parent shows, unless Show members is on', () => {
    const q = payload([belt, alnilam]);
    expect(ids(filterAnnotationItems(q, defaultAnnotationSettings(q)))).toEqual(['belt']);
    expect(ids(filterAnnotationItems(q, { ...defaultAnnotationSettings(q), showMembers: true }))).toEqual(['belt', 'alnilam']);
    // Parent filtered out: the member stands on its own.
    expect(ids(filterAnnotationItems(q, { ...defaultAnnotationSettings(q), score: 96 }))).toEqual(['alnilam']);
  });

  it('an item of an undeclared group is shown', () => {
    const q = payload([{ ...uranus, group: 'comet' }]);
    expect(filterAnnotationItems(q, defaultAnnotationSettings(q))).toHaveLength(1);
  });
});

describe('layoutAnnotations', () => {
  const order = ['planet', 'star'];

  it('labels are plain unless Show scores is on', () => {
    const p = payload([uranus]);
    expect(layoutAnnotations([uranus], p, defaultAnnotationSettings(p), order)[0].text).toBe('Uranus');
    expect(layoutAnnotations([uranus], p, { ...defaultAnnotationSettings(p), showScores: true }, order)[0].text).toBe('Uranus 100');
  });

  it('the tooltip carries the label, score and values', () => {
    expect(annotationTooltip(uranus, payload([]))).toBe('Uranus · Confidence 100 · mag 5.6');
  });

  it('skips a label that overlaps a higher-scored one, keeping its marker', () => {
    const near: AnnotationItem = { ...uranus, id: 'near', label: 'Near', score: 50, y: 102 };
    const p = payload([near, uranus]);
    const drawn = layoutAnnotations([near, uranus], p, defaultAnnotationSettings(p), order);
    expect(drawn.map((d) => [d.id, d.labelPlaced])).toEqual([['near', false], ['uranus', true]]);
  });

  it('places labels that do not overlap', () => {
    const p = payload([uranus, faint]);
    expect(layoutAnnotations([uranus, faint], p, defaultAnnotationSettings(p), order).every((d) => d.labelPlaced)).toBe(true);
  });

  it('builds path data for lines and centres their label on label_at', () => {
    const p = payload([belt]);
    const [d] = layoutAnnotations([belt], p, defaultAnnotationSettings(p), order);
    expect(d.d).toBe('M0 0L10 10');
    expect(d.labelY).toBe(5);
    expect(d.labelX).toBeLessThan(5);
  });

  it('gives a tiny point a visible marker and colours by group order', () => {
    const p = payload([vega]);
    const [d] = layoutAnnotations([vega], p, defaultAnnotationSettings(p), order);
    expect(d.r).toBeGreaterThan(0);
    expect(d.color).toBe(1);
    expect(ANNOTATION_LABEL_SCALE).toBeGreaterThan(0);
  });
});

describe('isDrawablePayload', () => {
  it('accepts v1 and refuses anything else', () => {
    expect(isDrawablePayload(payload([]))).toBe(true);
    expect(isDrawablePayload({ ...payload([]), version: 2 })).toBe(false);
    expect(isDrawablePayload({ ...payload([]), image: { width: 0, height: 1 } })).toBe(false);
    expect(isDrawablePayload(null)).toBe(false);
  });
});

describe('annotation storage', () => {
  function memory(): Storage {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; },
    } as Storage;
  }

  it('round-trips settings per source', () => {
    const store = memory();
    const p = payload([]);
    writeAnnotationSettings('astro-id', { ...defaultAnnotationSettings(p), score: 10 }, store);
    expect(store.getItem(ANNOTATION_SETTINGS_KEY + 'astro-id')).toContain('"score":10');
    expect(readAnnotationSettings('astro-id', p, store).score).toBe(10);
    expect(readAnnotationSettings('other', p, store).score).toBe(65);
  });

  it('survives storage that throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } as unknown as Storage;
    const p = payload([]);
    expect(readAnnotationSettings('x', p, broken)).toEqual(defaultAnnotationSettings(p));
    expect(() => writeAnnotationSettings('x', defaultAnnotationSettings(p), broken)).not.toThrow();
    expect(readAnnotationsEnabled(broken)).toBe(false);
    expect(() => writeAnnotationsEnabled(true, broken)).not.toThrow();
  });

  it('remembers whether the overlay is on', () => {
    const store = memory();
    expect(readAnnotationsEnabled(store)).toBe(false);
    writeAnnotationsEnabled(true, store);
    expect(readAnnotationsEnabled(store)).toBe(true);
  });
});
