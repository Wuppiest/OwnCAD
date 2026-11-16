// Document store: owns the CadDocument, undo/redo history and autosave.

import type { CadDocument, Feature, FeatureType, SketchFeature } from './types';

const AUTOSAVE_KEY = 'owncad.autosave.v1';
const MAX_HISTORY = 200;

export function createEmptyDocument(): CadDocument {
  return {
    format: 'owncad',
    version: 1,
    name: 'Untitled',
    units: 'mm',
    params: [
      { name: 'width', expr: '40' },
      { name: 'depth', expr: '20' },
      { name: 'height', expr: '10' },
    ],
    features: [],
    rollback: null,
    hiddenBodies: [],
    nextId: 1,
  };
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Validates & upgrades a loaded JSON object. Throws on invalid input. */
export function parseDocument(json: unknown): CadDocument {
  const d = json as Partial<CadDocument>;
  if (!d || d.format !== 'owncad' || !Array.isArray(d.features)) throw new Error('Not an OwnCAD project file');
  return {
    ...createEmptyDocument(),
    ...d,
    params: Array.isArray(d.params) ? d.params : [],
    hiddenBodies: Array.isArray(d.hiddenBodies) ? d.hiddenBodies : [],
    rollback: typeof d.rollback === 'number' ? d.rollback : null,
    nextId: typeof d.nextId === 'number' ? d.nextId : 1000,
  } as CadDocument;
}

type Listener = (reason: string) => void;

export class DocStore {
  doc: CadDocument;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners: Listener[] = [];
  private gestureSnapshot: string | null = null;
  dirty = false;

  constructor(doc?: CadDocument) {
    this.doc = doc ?? createEmptyDocument();
  }

  onChange(l: Listener) {
    this.listeners.push(l);
  }

  emit(reason: string) {
    for (const l of this.listeners) l(reason);
    this.autosave();
  }

  /** Generate a unique id inside the document. */
  newId(prefix = 'f'): string {
    return `${prefix}${this.doc.nextId++}`;
  }

  /** Apply a mutation as one undoable step. */
  commit(reason: string, mutate: (doc: CadDocument) => void) {
    const before = JSON.stringify(this.doc);
    mutate(this.doc);
    const after = JSON.stringify(this.doc);
    if (before === after) return;
    if (this.gestureSnapshot === null) {
      this.pushUndo(before);
    }
    this.dirty = true;
    this.emit(reason);
  }

  /** Begin a multi-step gesture (e.g. drag); all changes until endGesture become one undo step. */
  beginGesture() {
    if (this.gestureSnapshot === null) this.gestureSnapshot = JSON.stringify(this.doc);
  }

  endGesture(reason = 'gesture') {
    if (this.gestureSnapshot === null) return;
    const before = this.gestureSnapshot;
    this.gestureSnapshot = null;
    if (before !== JSON.stringify(this.doc)) {
      this.pushUndo(before);
      this.dirty = true;
      this.emit(reason);
    }
  }

  cancelGesture() {
    if (this.gestureSnapshot === null) return;
    this.doc = JSON.parse(this.gestureSnapshot);
    this.gestureSnapshot = null;
    this.emit('cancel');
  }

  /** Change without creating an undo step (for derived state, e.g. solver output). */
  silent(mutate: (doc: CadDocument) => void) {
    mutate(this.doc);
  }

  private pushUndo(snapshot: string) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(s);
    this.emit('undo');
    return true;
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(s);
    this.emit('redo');
    return true;
  }

  /** Replace the whole document (new / open). Clears history. */
  replace(doc: CadDocument) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.emit('replace');
  }

  // ---------------------------------------------------------- queries

  feature(id: string): Feature | undefined {
    return this.doc.features.find((f) => f.id === id);
  }

  sketch(id: string): SketchFeature | undefined {
    const f = this.feature(id);
    return f?.type === 'sketch' ? f : undefined;
  }

  /** Features that are not rolled back. */
  activeFeatures(): Feature[] {
    const n = this.doc.rollback ?? this.doc.features.length;
    return this.doc.features.slice(0, n);
  }

  isRolledBack(id: string): boolean {
    const idx = this.doc.features.findIndex((f) => f.id === id);
    return this.doc.rollback !== null && idx >= this.doc.rollback;
  }

  nextName(type: FeatureType): string {
    const base = { sketch: 'Sketch', extrude: 'Extrude', revolve: 'Revolve', primitive: 'Primitive', boolean: 'Combine', transform: 'Move', pattern: 'Pattern', mirror: 'Mirror' }[type];
    let n = 1;
    const names = new Set(this.doc.features.map((f) => f.name));
    while (names.has(`${base}${n}`)) n++;
    return `${base}${n}`;
  }

  /** Insert a feature at the rollback marker (or the end). */
  insertFeature(doc: CadDocument, f: Feature) {
    if (doc.rollback === null) doc.features.push(f);
    else {
      doc.features.splice(doc.rollback, 0, f);
      doc.rollback++;
    }
  }

  // ---------------------------------------------------------- autosave

  private autosaveTimer: number | undefined;
  private autosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.doc));
      } catch {
        /* storage unavailable — ignore */
      }
    }, 400);
  }

  static loadAutosave(): CadDocument | null {
    try {
      const s = localStorage.getItem(AUTOSAVE_KEY);
      return s ? parseDocument(JSON.parse(s)) : null;
    } catch {
      return null;
    }
  }

  static clearAutosave() {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      /* ignore */
    }
  }
}
