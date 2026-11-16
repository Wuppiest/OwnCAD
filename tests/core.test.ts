import { describe, expect, it } from 'vitest';
import { evaluate, ParamScope } from '../src/model/expr';
import { findProfiles, findRegions } from '../src/sketch/profiles';
import { createEmptyDocument, parseDocument } from '../src/model/document';
import type { SketchFeature } from '../src/model/types';

describe('expressions', () => {
  it('evaluates arithmetic with precedence', () => {
    expect(evaluate('2 + 3 * 4')).toBe(14);
    expect(evaluate('(2 + 3) * 4')).toBe(20);
    expect(evaluate('-2^2')).toBe(-4);
    expect(evaluate('2^3^2')).toBe(512);
    expect(evaluate('10 % 4')).toBe(2);
  });
  it('supports units, constants and functions', () => {
    expect(evaluate('1in')).toBeCloseTo(25.4);
    expect(evaluate('2cm + 5mm')).toBe(25);
    expect(evaluate('sin(90)')).toBeCloseTo(1);
    expect(evaluate('max(1, 7, 3)')).toBe(7);
    expect(evaluate('pi')).toBeCloseTo(Math.PI);
  });
  it('rejects junk', () => {
    expect(() => evaluate('2 +')).toThrow();
    expect(() => evaluate('foo(1)')).toThrow();
    expect(() => evaluate('1/0')).toThrow();
    expect(() => evaluate('alert(1)')).toThrow();
  });
  it('resolves parameters with dependencies and detects cycles', () => {
    const s = new ParamScope([
      { name: 'b', expr: 'a * 2' },
      { name: 'a', expr: '5' },
      { name: 'x', expr: 'y + 1' },
      { name: 'y', expr: 'x + 1' },
    ]);
    expect(s.values.get('b')).toBe(10);
    expect(s.eval('a + b')).toBe(15);
    expect(s.errors.has('x')).toBe(true);
    expect(s.tryEval('x').error).toBeDefined();
  });
});

function sketch(points: [string, number, number][], lines: [string, string][], extra: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id: 's1', type: 'sketch', name: 'S', plane: { kind: 'origin', plane: 'XY', offset: '0' },
    points: points.map(([id, x, y]) => ({ id, x, y })),
    curves: lines.map(([a, b], i) => ({ id: `l${i}`, type: 'line' as const, p1: a, p2: b })),
    constraints: [],
    ...extra,
  };
}

const area = (poly: [number, number][]) => poly.reduce((s, p, i) => s + p[0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * p[1], 0) / 2;

describe('profiles', () => {
  it('finds a rectangle', () => {
    const s = sketch([['a', 0, 0], ['b', 40, 0], ['c', 40, 20], ['d', 0, 20]], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']]);
    const r = findProfiles(s);
    expect(r.loops.length).toBe(1);
    expect(area(r.loops[0])).toBeCloseTo(800);
    expect(r.openCurveIds).toEqual([]);
  });
  it('splits a rectangle divided by a line into two regions', () => {
    const s = sketch(
      [['a', 0, 0], ['b', 20, 0], ['c', 40, 0], ['d', 40, 20], ['e', 20, 20], ['f', 0, 20]],
      [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'a'], ['b', 'e']],
    );
    const r = findProfiles(s);
    expect(r.loops.length).toBe(2);
    expect(r.loops.map(area).reduce((a, b) => a + b)).toBeCloseTo(800);
  });
  it('treats circles as loops and ignores construction and open curves', () => {
    const s = sketch([['a', 0, 0], ['b', 10, 0], ['o', 50, 50]], [['a', 'b']], {});
    s.curves.push({ id: 'k', type: 'circle', c: 'o', r: 5 });
    s.curves.push({ id: 'k2', type: 'circle', c: 'o', r: 8, construction: true });
    const r = findProfiles(s);
    expect(r.loops.length).toBe(1);
    expect(r.openCurveIds).toEqual(['l0']);
  });
  it('handles a dangling edge inside a closed loop', () => {
    const s = sketch(
      [['a', 0, 0], ['b', 10, 0], ['c', 10, 10], ['d', 0, 10], ['e', 5, 5]],
      [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['a', 'e']],
    );
    const r = findProfiles(s);
    expect(r.loops.length).toBe(1);
    expect(Math.abs(area(r.loops[0]))).toBeCloseTo(100);
  });
});

describe('intersections', () => {
  it('splits regions at T-junctions (line ending on another line)', () => {
    const s = sketch(
      [['a', 0, 0], ['b', 40, 0], ['c', 40, 20], ['d', 0, 20], ['m1', 20, 0], ['m2', 20, 20]],
      [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['m1', 'm2']],
    );
    const r = findRegions(s);
    expect(r.length).toBe(2);
    r.forEach((x) => expect(x.area).toBeCloseTo(400));
  });
  it('splits regions where lines cross without shared points', () => {
    const s = sketch(
      [['a', 0, 0], ['b', 40, 0], ['c', 40, 20], ['d', 0, 20], ['x1', 20, -5], ['x2', 20, 25], ['y1', -5, 10], ['y2', 45, 10]],
      [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a'], ['x1', 'x2'], ['y1', 'y2']],
    );
    const r = findRegions(s);
    expect(r.length).toBe(4);
    r.forEach((x) => expect(x.area).toBeCloseTo(200));
  });
  it('splits a circle crossed by a line', () => {
    const s = sketch([['o', 0, 0], ['p', -20, 0], ['q', 20, 0]], [['p', 'q']]);
    s.curves.push({ id: 'k', type: 'circle', c: 'o', r: 10 });
    const r = findRegions(s);
    expect(r.length).toBe(2);
    const total = r.reduce((a, x) => a + x.area, 0);
    expect(total).toBeCloseTo(Math.PI * 100, 0);
  });
});

describe('regions', () => {
  it('splits a rectangle with a hole into "rect minus circle" and "circle"', () => {
    const s = sketch([['a', 0, 0], ['b', 40, 0], ['c', 40, 20], ['d', 0, 20], ['o', 20, 10]], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']]);
    s.curves.push({ id: 'k', type: 'circle', c: 'o', r: 5 });
    const r = findRegions(s);
    expect(r.length).toBe(2);
    const areas = r.map((x) => x.area).sort((p, q) => p - q);
    expect(areas[0]).toBeCloseTo(Math.PI * 25, 0);
    expect(areas[1]).toBeCloseTo(800 - Math.PI * 25, 0);
    const outer = r.find((x) => x.polys.length === 2)!;
    expect(outer).toBeDefined();
    // label point lies inside the region, outside the hole
    expect(Math.hypot(outer.label[0] - 20, outer.label[1] - 10)).toBeGreaterThan(5);
  });
  it('treats side-by-side regions independently', () => {
    const s = sketch(
      [['a', 0, 0], ['b', 20, 0], ['c', 40, 0], ['d', 40, 20], ['e', 20, 20], ['f', 0, 20]],
      [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'a'], ['b', 'e']],
    );
    const r = findRegions(s);
    expect(r.length).toBe(2);
    r.forEach((x) => {
      expect(x.polys.length).toBe(1);
      expect(x.area).toBeCloseTo(400);
    });
  });
});

describe('document', () => {
  it('round-trips through JSON', () => {
    const d = createEmptyDocument();
    d.features.push({ id: 'f1', type: 'primitive', name: 'Box1', shape: 'box', size: ['10', '10', '10'], position: ['0', '0', '0'], rotation: ['0', '0', '0'], centered: false, op: 'new', target: 'auto' });
    const back = parseDocument(JSON.parse(JSON.stringify(d)));
    expect(back).toEqual(d);
  });
  it('rejects foreign files', () => {
    expect(() => parseDocument({ hello: 1 })).toThrow();
  });
});
