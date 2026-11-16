// Project save/load and model/sketch export.

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { BodyMesh } from '../kernel/regenerate';
import type { CadDocument, SketchFeature } from '../model/types';
import { parseDocument } from '../model/document';
import { arcAngles, pointMap, tessellate } from '../sketch/geom';

export function download(name: string, data: BlobPart, mime: string) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const safe = (n: string) => n.replace(/[^\w\-. ]+/g, '_').trim() || 'model';

export function saveProject(doc: CadDocument) {
  download(`${safe(doc.name)}.owncad.json`, JSON.stringify(doc, null, 2), 'application/json');
}

export function openProjectFile(): Promise<CadDocument | null> {
  return new Promise((resolve, reject) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,.owncad,.owncad.json,application/json';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      try {
        const doc = parseDocument(JSON.parse(await f.text()));
        if (doc.name === 'Untitled') doc.name = f.name.replace(/\.owncad\.json$|\.json$/i, '');
        resolve(doc);
      } catch (e) {
        reject(e);
      }
    };
    inp.click();
  });
}

function bodiesToGroup(bodies: BodyMesh[]): THREE.Group {
  const g = new THREE.Group();
  for (const b of bodies) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(b.indices, 1));
    if (b.normals) geo.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
    else geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb8c4d4, metalness: 0.1, roughness: 0.6 }));
    m.name = b.name;
    g.add(m);
  }
  g.updateMatrixWorld(true);
  return g;
}

export async function exportMesh(format: 'stl' | 'obj' | 'glb', bodies: BodyMesh[], name: string): Promise<number> {
  if (!bodies.length) throw new Error('There are no bodies to export');
  const g = bodiesToGroup(bodies);
  const base = safe(name);
  if (format === 'stl') {
    const data = new STLExporter().parse(g, { binary: true }) as DataView;
    download(`${base}.stl`, data.buffer as ArrayBuffer, 'model/stl');
    return data.byteLength;
  }
  if (format === 'obj') {
    const s = new OBJExporter().parse(g);
    download(`${base}.obj`, s, 'text/plain');
    return s.length;
  }
  const buf = (await new GLTFExporter().parseAsync(g, { binary: true })) as ArrayBuffer;
  download(`${base}.glb`, buf, 'model/gltf-binary');
  return buf.byteLength;
}

/** Export a sketch as DXF (R12 ASCII). */
export function sketchToDXF(s: SketchFeature): string {
  const pts = pointMap(s);
  const out: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  const f = (n: number) => n.toFixed(6);
  for (const c of s.curves) {
    const layer = c.construction ? 'CONSTRUCTION' : '0';
    if (c.type === 'line') {
      const a = pts.get(c.p1)!, b = pts.get(c.p2)!;
      out.push('0', 'LINE', '8', layer, '10', f(a.x), '20', f(a.y), '30', '0', '11', f(b.x), '21', f(b.y), '31', '0');
    } else if (c.type === 'circle') {
      const ctr = pts.get(c.c)!;
      out.push('0', 'CIRCLE', '8', layer, '10', f(ctr.x), '20', f(ctr.y), '30', '0', '40', f(c.r));
    } else {
      const { a0, sweep, c: ctr } = arcAngles(c, pts);
      const d = (r: number) => ((r * 180) / Math.PI + 360) % 360;
      out.push('0', 'ARC', '8', layer, '10', f(ctr.x), '20', f(ctr.y), '30', '0', '40', f(c.r), '50', f(d(a0)), '51', f(d(a0 + sweep)));
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

/** Export a sketch as SVG (Y flipped so it looks like the sketch view). */
export function sketchToSVG(s: SketchFeature): string {
  const pts = pointMap(s);
  const polys = s.curves.map((c) => ({ c, p: tessellate(c, pts) }));
  const all = polys.flatMap((x) => x.p);
  if (!all.length) all.push([0, 0]);
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const pad = 5;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const w = maxX - minX, h = maxY - minY;
  const body = polys
    .map(({ c, p }) => {
      const d = p.map((q, i) => `${i ? 'L' : 'M'}${(q[0] - minX).toFixed(4)} ${(maxY - q[1]).toFixed(4)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${c.construction ? '#999' : '#000'}" stroke-width="0.25"${c.construction ? ' stroke-dasharray="1 1"' : ''}/>`;
    })
    .join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(3)}mm" height="${h.toFixed(3)}mm" viewBox="0 0 ${w.toFixed(4)} ${h.toFixed(4)}">\n  ${body}\n</svg>\n`;
}
