// Three.js viewport: cameras, controls, body display, picking.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { BodyMesh } from '../kernel/regenerate';
import type { Frame, SketchFeature, Vec2, Vec3 } from '../model/types';
import { pointMap, tessellate, toWorld } from '../sketch/geom';

export interface PickHit {
  bodyId: string;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  faceId: number;
  planar: boolean;
}

const BODY_COLOR = 0xb8c4d4;
const SELECT_COLOR = 0x60a5fa;
const HOVER_COLOR = 0xfbbf24;

export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  persp: THREE.PerspectiveCamera;
  ortho: THREE.OrthographicCamera;
  camera: THREE.Camera;
  controls: OrbitControls;
  host: HTMLElement;
  labelLayer: HTMLDivElement;

  bodiesGroup = new THREE.Group();
  sketchesGroup = new THREE.Group();
  overlayGroup = new THREE.Group();
  planesGroup = new THREE.Group();
  grid: THREE.Group;

  private bodyMeshes = new Map<string, THREE.Mesh>();
  private faceHighlight: THREE.Mesh;
  private frameHooks: (() => void)[] = [];
  selectedBodies = new Set<string>();
  hoverBody: string | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    host.appendChild(this.renderer.domElement);
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'label-layer';
    host.appendChild(this.labelLayer);

    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.persp = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    this.persp.up.set(0, 0, 1);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    this.ortho.up.set(0, 0, 1);
    this.camera = this.persp;
    this.persp.position.set(120, -160, 110);
    this.controls = this.makeControls();

    // lights
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.5);
    d1.position.set(1, -2, 3);
    const d2 = new THREE.DirectionalLight(0xffffff, 0.6);
    d2.position.set(-2, 1, -1);
    this.persp.add(d1, d2); // lights follow the camera
    this.ortho.add(d1.clone(), d2.clone());
    this.scene.add(this.persp, this.ortho);

    this.grid = this.makeGrid(200, 10);
    this.scene.add(this.grid, this.makeAxes(), this.bodiesGroup, this.sketchesGroup, this.planesGroup, this.overlayGroup);

    this.faceHighlight = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: HOVER_COLOR, transparent: true, opacity: 0.45, depthTest: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.faceHighlight.visible = false;
    this.faceHighlight.renderOrder = 5;
    this.overlayGroup.add(this.faceHighlight);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.updateGrid();
    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      this.updateGrid();
      this.renderer.render(this.scene, this.camera);
      for (const h of this.frameHooks) h();
    };
    loop();
  }

  private makeControls() {
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = false;
    c.zoomToCursor = true;
    c.screenSpacePanning = true;
    c.mouseButtons = { LEFT: this.leftOrbit ? THREE.MOUSE.ROTATE : (null as any), MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    c.rotateSpeed = 0.8;
    this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    return c;
  }

  onFrame(h: () => void) {
    this.frameHooks.push(h);
  }

  /** Left mouse drag orbits (model mode); in sketch mode the left button draws. Shift/Ctrl + left drag pans. */
  leftOrbit = true;
  setLeftOrbit(on: boolean) {
    this.leftOrbit = on;
    this.controls.mouseButtons.LEFT = on ? THREE.MOUSE.ROTATE : (null as any);
  }

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  private updateOrthoFrustum() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    const dist = this.ortho.position.distanceTo(this.controls?.target ?? new THREE.Vector3());
    const halfH = Math.max(1, dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)));
    this.ortho.top = halfH;
    this.ortho.bottom = -halfH;
    this.ortho.left = (-halfH * w) / h;
    this.ortho.right = (halfH * w) / h;
    this.ortho.updateProjectionMatrix();
  }

  get isOrtho() {
    return this.camera === this.ortho;
  }

  setProjection(ortho: boolean) {
    if (ortho === this.isOrtho) return;
    const target = this.controls.target.clone();
    const from = this.camera;
    const to = ortho ? this.ortho : this.persp;
    if (ortho) {
      to.position.copy(from.position);
      this.ortho.zoom = 1;
      this.updateOrthoFrustum();
    } else {
      // convert ortho zoom back into a distance
      const dir = from.position.clone().sub(target);
      dir.setLength(dir.length() / this.ortho.zoom);
      to.position.copy(target).add(dir);
    }
    to.quaternion.copy(from.quaternion);
    this.camera = to;
    this.controls.dispose();
    this.controls = this.makeControls();
    this.controls.target.copy(target);
    this.controls.update();
  }

  // ------------------------------------------------------------ grid / axes

  private makeGrid(size: number, step: number) {
    const g = new THREE.Group();
    const minor = new THREE.GridHelper(size, size / (step / 5), 0x3c4554, 0x3c4554);
    const major = new THREE.GridHelper(size, size / step, 0x56627a, 0x56627a);
    for (const h of [minor, major]) {
      h.rotation.x = Math.PI / 2;
      (h.material as THREE.Material).transparent = true;
      (h.material as THREE.Material).opacity = h === minor ? 0.35 : 0.6;
      (h.material as THREE.Material).depthWrite = false;
    }
    g.add(minor, major);
    g.renderOrder = -1;
    return g;
  }

  private gridFrame: Frame | undefined;
  private gridKey = '';
  gridVisible = true;

  /** Sets the plane the grid lies on; spacing and extent adapt to the zoom level automatically. */
  setGrid(frame?: Frame) {
    this.gridFrame = frame;
    this.gridKey = '';
    this.updateGrid();
  }

  private updateGrid() {
    const f = this.gridFrame ?? { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as Frame;
    const target = this.controls.target;
    const px = this.pixelSize(target) || 0.1;
    // major spacing: smallest power of 10 that is at least ~50 px on screen
    const major = Math.pow(10, Math.ceil(Math.log10(Math.max(px * 50, 1e-3))));
    // center the grid near the view target (snapped to major lines), in plane coordinates
    const o = new THREE.Vector3(...f.origin);
    const rel = target.clone().sub(o);
    const cx = Math.round(rel.dot(new THREE.Vector3(...f.x)) / (major * 10)) * major * 10;
    const cy = Math.round(rel.dot(new THREE.Vector3(...f.y)) / (major * 10)) * major * 10;
    const key = `${major}|${cx}|${cy}|${f.origin}|${f.z}`;
    if (key === this.gridKey) return;
    this.gridKey = key;
    this.scene.remove(this.grid);
    this.grid.traverse((g) => (g as any).geometry?.dispose?.());
    const size = major * 80;
    const g = new THREE.Group();
    const minor = new THREE.GridHelper(size, 400, 0x3c4554, 0x3c4554);
    const maj = new THREE.GridHelper(size, 80, 0x56627a, 0x56627a);
    for (const h of [minor, maj]) {
      h.rotation.x = Math.PI / 2;
      const mat = h.material as THREE.Material;
      mat.transparent = true;
      mat.opacity = h === minor ? 0.3 : 0.6;
      mat.depthWrite = false;
    }
    g.add(minor, maj);
    g.position.set(cx, cy, 0);
    const wrap = new THREE.Group();
    wrap.add(g);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z));
    m.setPosition(...f.origin);
    wrap.applyMatrix4(m);
    wrap.visible = this.gridVisible;
    this.grid = wrap;
    this.scene.add(this.grid);
  }

  setGridVisible(v: boolean) {
    this.gridVisible = v;
    this.grid.visible = v;
  }

  private makeAxes() {
    const g = new THREE.Group();
    const L = 30;
    const mk = (dir: Vec3, color: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...dir).multiplyScalar(L)]);
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 }));
    };
    g.add(mk([1, 0, 0], 0xef4444), mk([0, 1, 0], 0x22c55e), mk([0, 0, 1], 0x3b82f6));
    const o = new THREE.Mesh(new THREE.SphereGeometry(0.8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    g.add(o);
    g.renderOrder = 10;
    return g;
  }

  // ------------------------------------------------------------ bodies

  setBodies(bodies: BodyMesh[], hidden: Set<string>) {
    for (const m of this.bodyMeshes.values()) {
      m.geometry.dispose();
      (m.children[0] as THREE.LineSegments)?.geometry.dispose();
    }
    this.bodiesGroup.clear();
    this.bodyMeshes.clear();
    for (const b of bodies) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(b.indices, 1));
      if (b.normals) geo.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
      else geo.computeVertexNormals();
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      geo.userData.faceIds = b.faceIds;
      const mat = new THREE.MeshStandardMaterial({ color: BODY_COLOR, metalness: 0.15, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.bodyId = b.id;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), new THREE.LineBasicMaterial({ color: 0x15181d }));
      edges.raycast = () => {};
      mesh.add(edges);
      mesh.visible = !hidden.has(b.id);
      this.bodiesGroup.add(mesh);
      this.bodyMeshes.set(b.id, mesh);
    }
    this.refreshBodyColors();
  }

  setBodyOpacity(opacity: number) {
    for (const m of this.bodyMeshes.values()) {
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.transparent = opacity < 1;
      mat.opacity = opacity;
      mat.depthWrite = opacity >= 1;
    }
  }

  refreshBodyColors() {
    for (const [id, m] of this.bodyMeshes) {
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.color.setHex(this.selectedBodies.has(id) ? SELECT_COLOR : id === this.hoverBody ? 0xd2dbe8 : BODY_COLOR);
    }
  }

  bodyMesh(id: string) {
    return this.bodyMeshes.get(id);
  }

  allBodyMeshes() {
    return [...this.bodyMeshes.values()].filter((m) => m.visible);
  }

  // ------------------------------------------------------------ sketches (inactive display)

  setSketches(sketches: { s: SketchFeature; frame: Frame }[]) {
    this.sketchesGroup.traverse((o) => (o as any).geometry?.dispose?.());
    this.sketchesGroup.clear();
    for (const { s, frame } of sketches) {
      const pts = pointMap(s);
      for (const c of s.curves) {
        // lifted slightly off the plane so lines on a face don't z-fight
        const poly = tessellate(c, pts).map((p) => new THREE.Vector3(...toWorld(frame, p, 0.01)));
        const geo = new THREE.BufferGeometry().setFromPoints(poly);
        const mat = c.construction
          ? new THREE.LineDashedMaterial({ color: 0x9ca3af, dashSize: 2, gapSize: 1.5 })
          : new THREE.LineBasicMaterial({ color: 0xf59e0b });
        const line = new THREE.Line(geo, mat);
        if (c.construction) line.computeLineDistances();
        line.userData.sketchId = s.id;
        this.sketchesGroup.add(line);
      }
    }
  }

  // ------------------------------------------------------------ profile regions (for extrude/revolve)

  regionsGroup = new THREE.Group();

  setRegions(frame: Frame | null, regions: { polys: Vec2[][]; label: Vec2 }[], selected: Set<number>, allSelected: boolean) {
    this.regionsGroup.traverse((o) => (o as any).geometry?.dispose?.());
    this.regionsGroup.clear();
    if (!this.regionsGroup.parent) this.scene.add(this.regionsGroup);
    if (!frame) return;
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.x), new THREE.Vector3(...frame.y), new THREE.Vector3(...frame.z));
    m.setPosition(...toWorld(frame, [0, 0], 0.02));
    regions.forEach((r, i) => {
      const shape = new THREE.Shape(r.polys[0].map((p) => new THREE.Vector2(p[0], p[1])));
      for (const h of r.polys.slice(1)) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
      const on = allSelected || selected.has(i);
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({ color: on ? 0x3b82f6 : 0x94a3b8, transparent: true, opacity: on ? 0.4 : 0.15, side: THREE.DoubleSide, depthWrite: false, depthTest: false }),
      );
      mesh.applyMatrix4(m);
      mesh.userData.regionIndex = i;
      mesh.renderOrder = 8;
      this.regionsGroup.add(mesh);
    });
  }

  pickRegion(ev: { clientX: number; clientY: number }): number | null {
    const hits = this.ray(ev).intersectObjects(this.regionsGroup.children, false);
    return hits.length ? hits[0].object.userData.regionIndex : null;
  }

  // ------------------------------------------------------------ origin planes

  showOriginPlanes(show: boolean) {
    this.planesGroup.clear();
    if (!show) return;
    const mk = (name: string, rot: THREE.Euler, color: number) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(60, 60),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
      );
      m.rotation.copy(rot);
      m.position.set(0, 0, 0);
      m.userData.plane = name;
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color }));
      m.add(border);
      return m;
    };
    this.planesGroup.add(
      mk('XY', new THREE.Euler(0, 0, 0), 0x3b82f6),
      mk('XZ', new THREE.Euler(Math.PI / 2, 0, 0), 0x22c55e),
      mk('YZ', new THREE.Euler(0, Math.PI / 2, 0), 0xef4444),
    );
  }

  // ------------------------------------------------------------ picking

  private raycaster = new THREE.Raycaster();

  ndc(ev: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  ray(ev: { clientX: number; clientY: number }) {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    this.raycaster.params.Line = { threshold: 1 };
    return this.raycaster;
  }

  pickPlane(ev: MouseEvent): string | null {
    const hits = this.ray(ev).intersectObjects(this.planesGroup.children, false);
    return hits[0]?.object.userData.plane ?? null;
  }

  pickBody(ev: { clientX: number; clientY: number }): PickHit | null {
    const hits = this.ray(ev).intersectObjects(this.allBodyMeshes(), false);
    const h = hits[0];
    if (!h || h.faceIndex == null) return null;
    const mesh = h.object as THREE.Mesh;
    const faceIds = mesh.geometry.userData.faceIds as Uint32Array;
    const faceId = faceIds[h.faceIndex] ?? 0;
    const normal = h.face!.normal.clone();
    // ensure normal points towards the camera ray origin (outward)
    const tris = this.faceTriangles(mesh, faceId);
    const planar = this.isPlanar(mesh, tris);
    const n = planar ? this.triNormal(mesh, tris[0]) : normal;
    return { bodyId: mesh.userData.bodyId, point: h.point.clone(), normal: n, faceId, planar };
  }

  private faceTriangles(mesh: THREE.Mesh, faceId: number): number[] {
    const ids = mesh.geometry.userData.faceIds as Uint32Array;
    const out: number[] = [];
    for (let i = 0; i < ids.length; i++) if (ids[i] === faceId) out.push(i);
    return out;
  }

  private triNormal(mesh: THREE.Mesh, tri: number) {
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.getIndex()!;
    const a = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(tri * 3));
    const b = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(tri * 3 + 1));
    const c = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(tri * 3 + 2));
    return b.sub(a).cross(c.sub(a)).normalize();
  }

  private isPlanar(mesh: THREE.Mesh, tris: number[]) {
    if (!tris.length) return false;
    const n0 = this.triNormal(mesh, tris[0]);
    return tris.every((t) => this.triNormal(mesh, t).dot(n0) > 0.9999);
  }

  highlightFace(hit: PickHit | null) {
    if (!hit) {
      this.faceHighlight.visible = false;
      return;
    }
    const mesh = this.bodyMeshes.get(hit.bodyId)!;
    const tris = this.faceTriangles(mesh, hit.faceId);
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.getIndex()!;
    const arr = new Float32Array(tris.length * 9);
    let k = 0;
    for (const t of tris)
      for (let j = 0; j < 3; j++) {
        const v = idx.getX(t * 3 + j);
        arr[k++] = pos.getX(v);
        arr[k++] = pos.getY(v);
        arr[k++] = pos.getZ(v);
      }
    this.faceHighlight.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.faceHighlight.geometry = g;
    this.faceHighlight.visible = true;
  }

  /** Nearest mesh vertex to the cursor (in screen space) within px pixels. */
  snapVertex(ev: { clientX: number; clientY: number }, px = 10): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    let best: THREE.Vector3 | null = null, bd = px;
    const v = new THREE.Vector3();
    for (const mesh of this.allBodyMeshes()) {
      const edges = mesh.children[0] as THREE.LineSegments;
      const pos = edges.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const s = this.toScreen(v, r);
        if (!s) continue;
        const d = Math.hypot(s.x - (ev.clientX - r.left), s.y - (ev.clientY - r.top));
        if (d < bd) {
          bd = d;
          best = v.clone();
        }
      }
    }
    return best;
  }

  /** Intersection of the cursor ray with a sketch plane, in local plane coordinates. */
  planePoint(ev: { clientX: number; clientY: number }, frame: Frame): Vec2 | null {
    const ray = this.ray(ev).ray;
    const n = new THREE.Vector3(...frame.z);
    const o = new THREE.Vector3(...frame.origin);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
    const p = new THREE.Vector3();
    if (!ray.intersectPlane(plane, p)) return null;
    const d = p.sub(o);
    return [d.dot(new THREE.Vector3(...frame.x)), d.dot(new THREE.Vector3(...frame.y))];
  }

  /** World units per screen pixel near the given point. */
  pixelSize(at: THREE.Vector3): number {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (this.isOrtho) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / r.height;
    const dist = this.persp.position.distanceTo(at);
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2))) / r.height;
  }

  toScreen(v: THREE.Vector3, rect?: DOMRect): { x: number; y: number } | null {
    const r = rect ?? this.renderer.domElement.getBoundingClientRect();
    const p = v.clone().project(this.camera);
    if (p.z > 1) return null;
    return { x: ((p.x + 1) / 2) * r.width, y: ((1 - p.y) / 2) * r.height };
  }

  // ------------------------------------------------------------ views

  setView(dir: THREE.Vector3, up?: THREE.Vector3, animate = true, frameTo?: { center: THREE.Vector3; radius: number }) {
    const startTarget = this.controls.target.clone();
    const startOffset = this.camera.position.clone().sub(startTarget);
    const startDist = startOffset.length();
    let target = startTarget.clone();
    let dist = startDist;
    if (frameTo) {
      target = frameTo.center.clone();
      dist = (Math.max(frameTo.radius, 5) / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2))) * 1.1;
      if (this.isOrtho) this.ortho.zoom = 1;
    }
    const d = dir.clone().normalize();
    // avoid exact pole (OrbitControls uses world Z up)
    if (Math.abs(d.z) > 0.9999) d.y -= up && up.y < 0 ? -1e-4 : 1e-4;
    d.normalize();
    const apply = (k: number) => {
      const tgt = startTarget.clone().lerp(target, k);
      const dirK = startOffset.clone().normalize().lerp(d, k);
      if (dirK.lengthSq() < 1e-8) dirK.copy(d);
      dirK.normalize().multiplyScalar(startDist + (dist - startDist) * k);
      this.controls.target.copy(tgt);
      this.camera.position.copy(tgt).add(dirK);
      this.camera.lookAt(tgt);
      this.controls.update();
      this.updateOrthoFrustum();
    };
    if (!animate) return apply(1);
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / 250);
      apply(t * (2 - t));
      if (t < 1) requestAnimationFrame(step);
    };
    step();
  }

  fitAll() {
    const box = new THREE.Box3();
    for (const m of this.allBodyMeshes()) box.expandByObject(m);
    for (const c of this.sketchesGroup.children) box.expandByObject(c);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, -10), new THREE.Vector3(50, 50, 10));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 5);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(sphere.center);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.1;
    this.camera.position.copy(sphere.center).add(dir.multiplyScalar(dist));
    if (this.isOrtho) {
      this.ortho.zoom = 1;
      this.updateOrthoFrustum();
    }
    this.controls.update();
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
