// Small navigation cube in the viewport corner. Click a face, edge or corner to orient the view.

import * as THREE from 'three';
import type { Viewport } from './viewport';

const FACES: { label: string; dir: [number, number, number] }[] = [
  { label: 'RIGHT', dir: [1, 0, 0] },
  { label: 'LEFT', dir: [-1, 0, 0] },
  { label: 'BACK', dir: [0, 1, 0] },
  { label: 'FRONT', dir: [0, -1, 0] },
  { label: 'TOP', dir: [0, 0, 1] },
  { label: 'BOTTOM', dir: [0, 0, -1] },
];

function faceTexture(label: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e5e9f0';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#8b95a5';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 124);
  g.fillStyle = '#2d333c';
  g.font = 'bold 22px Segoe UI, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ViewCube {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  private cube: THREE.Mesh;
  private hover: THREE.Mesh;

  constructor(host: HTMLElement, private vp: Viewport) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(120, 120);
    host.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);

    // BoxGeometry face order: +x, -x, +y, -y, +z, -z
    const mats = FACES.map((f) => new THREE.MeshBasicMaterial({ map: faceTexture(f.label) }));
    // Rotate textures so text reads correctly with Z up.
    const geo = new THREE.BoxGeometry(1.6, 1.6, 1.6);
    this.cube = new THREE.Mesh(geo, mats);
    this.fixUVs(geo);
    this.scene.add(this.cube);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x4b5563 }));
    this.cube.add(edges);

    // axes triad
    const axis = (d: [number, number, number], color: number) => {
      const a = new THREE.ArrowHelper(new THREE.Vector3(...d), new THREE.Vector3(-0.8, -0.8, -0.8), 1.5, color, 0.25, 0.15);
      this.scene.add(a);
    };
    axis([1, 0, 0], 0xef4444);
    axis([0, 1, 0], 0x22c55e);
    axis([0, 0, 1], 0x3b82f6);

    this.hover = new THREE.Mesh(new THREE.SphereGeometry(0.22), new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.7 }));
    this.hover.visible = false;
    this.scene.add(this.hover);

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      const d = this.pickDir(e);
      this.hover.visible = !!d;
      if (d) this.hover.position.copy(d.clone().multiplyScalar(0.95));
    });
    el.addEventListener('pointerleave', () => (this.hover.visible = false));
    el.addEventListener('click', (e) => {
      const d = this.pickDir(e);
      if (d) vp.setView(d);
    });

    vp.onFrame(() => this.render());
  }

  private fixUVs(geo: THREE.BoxGeometry) {
    // For the side faces BoxGeometry's default UV orientation assumes Y-up.
    // Rotate so labels are upright in a Z-up world.
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const rot = (face: number, turns: number) => {
      for (let i = face * 4; i < face * 4 + 4; i++) {
        let u = uv.getX(i) - 0.5, v = uv.getY(i) - 0.5;
        for (let t = 0; t < turns; t++) [u, v] = [-v, u];
        uv.setXY(i, u + 0.5, v + 0.5);
      }
    };
    rot(0, 1); // +x
    rot(1, 3); // -x
    rot(2, 2); // +y
    rot(3, 0); // -y
    rot(5, 2); // -z
    uv.needsUpdate = true;
  }

  private pickDir(e: MouseEvent): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const hit = rc.intersectObject(this.cube, false)[0];
    if (!hit) return null;
    // snap to faces/edges/corners: components near the boundary count
    const p = hit.point.clone().divideScalar(0.8);
    const snap = (x: number) => (Math.abs(x) > 0.6 ? Math.sign(x) : 0);
    const d = new THREE.Vector3(snap(p.x), snap(p.y), snap(p.z));
    if (d.lengthSq() === 0) return null;
    return d.normalize();
  }

  private render() {
    const cam = this.vp.camera;
    const dir = cam.position.clone().sub(this.vp.controls.target).normalize();
    this.camera.position.copy(dir.multiplyScalar(6));
    this.camera.up.copy(cam.up);
    this.camera.quaternion.copy(cam.quaternion);
    this.renderer.render(this.scene, this.camera);
  }
}
