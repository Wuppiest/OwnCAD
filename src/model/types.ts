// Core, JSON-serializable document model of OwnCAD.
// All lengths are millimetres, all angles in the UI are degrees.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** A numeric expression, e.g. "10", "width * 2", "25.4mm", "45deg". */
export type Expr = string;

export interface Parameter {
  name: string;
  expr: Expr;
  comment?: string;
}

/** Orthonormal frame describing a sketch plane in world space. */
export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3; // plane normal
}

export type OriginPlane = 'XY' | 'XZ' | 'YZ';

export type SketchPlane =
  | { kind: 'origin'; plane: OriginPlane; offset: Expr }
  | { kind: 'custom'; frame: Frame; label: string; offset: Expr };

// ---------------------------------------------------------------- Sketch

export interface SketchPoint {
  id: string;
  x: number;
  y: number;
  fixed?: boolean;
}

export interface SketchLine { id: string; type: 'line'; p1: string; p2: string; construction?: boolean }
export interface SketchCircle { id: string; type: 'circle'; c: string; r: number; construction?: boolean }
/** Arc runs counter-clockwise from s to e around centre c. */
export interface SketchArc { id: string; type: 'arc'; c: string; s: string; e: string; r: number; construction?: boolean }
export type SketchCurve = SketchLine | SketchCircle | SketchArc;

export type ConstraintType =
  | 'coincident'      // [p, p]
  | 'pointOnCurve'    // [p, line|circle|arc]
  | 'horizontal'      // [line] or [p, p]
  | 'vertical'        // [line] or [p, p]
  | 'parallel'        // [line, line]
  | 'perpendicular'   // [line, line]
  | 'equal'           // [line, line] | [circle/arc, circle/arc]
  | 'tangent'         // [line, circle/arc] | [circle/arc, circle/arc]
  | 'midpoint'        // [p, line]
  | 'symmetric'       // [p, p, line]
  | 'concentric'      // [circle/arc, circle/arc]
  | 'fix'             // [p]
  // dimensions (have a value)
  | 'distance'        // [p, p] | [line] | [p, line]
  | 'hdistance'       // [p, p]   value = p2.x - p1.x
  | 'vdistance'       // [p, p]   value = p2.y - p1.y
  | 'radius'          // [circle|arc]
  | 'diameter'        // [circle|arc]
  | 'angle';          // [line, line] degrees

export interface SketchConstraint {
  id: string;
  type: ConstraintType;
  refs: string[];
  value?: Expr;
  /** Label offset in sketch units relative to the default label position. */
  offset?: Vec2;
  /** Reference (driven) dimension — displayed, not enforced. */
  reference?: boolean;
}

export const DIMENSION_TYPES: ConstraintType[] = ['distance', 'hdistance', 'vdistance', 'radius', 'diameter', 'angle'];

// ---------------------------------------------------------------- Features

export type BodyOp = 'new' | 'join' | 'cut' | 'intersect';

interface FeatureBase {
  id: string;
  name: string;
  suppressed?: boolean;
}

export interface SketchFeature extends FeatureBase {
  type: 'sketch';
  plane: SketchPlane;
  points: SketchPoint[];
  curves: SketchCurve[];
  constraints: SketchConstraint[];
  visible?: boolean;
}

export interface ExtrudeFeature extends FeatureBase {
  type: 'extrude';
  sketch: string;
  distance: Expr;
  direction: 'normal' | 'reverse' | 'symmetric';
  /** Taper by scaling the top profile (1 = straight). */
  taper?: Expr;
  op: BodyOp;
  target: string; // body id or 'auto'
  /** Selected sketch regions (indices from findRegions). Empty/undefined = all loops, nested ones become holes. */
  profiles?: number[];
}

export interface RevolveFeature extends FeatureBase {
  type: 'revolve';
  sketch: string;
  /** 'X' / 'Y' = sketch axes, otherwise the id of a line in the sketch. */
  axis: string;
  angle: Expr;
  op: BodyOp;
  target: string;
  profiles?: number[];
}

export interface PrimitiveFeature extends FeatureBase {
  type: 'primitive';
  shape: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus';
  size: [Expr, Expr, Expr];   // box: x,y,z | cylinder: r,h,- | sphere: r,-,- | cone: r1,r2,h | torus: R,r,-
  position: [Expr, Expr, Expr];
  rotation: [Expr, Expr, Expr];
  centered: boolean;
  op: BodyOp;
  target: string;
}

export interface BooleanFeature extends FeatureBase {
  type: 'boolean';
  op: 'union' | 'subtract' | 'intersect';
  target: string;
  tools: string[];
  keepTools: boolean;
}

export interface TransformFeature extends FeatureBase {
  type: 'transform';
  bodies: string[];
  translate: [Expr, Expr, Expr];
  rotate: [Expr, Expr, Expr];
  scale: Expr;
  copy: boolean;
}

export interface PatternFeature extends FeatureBase {
  type: 'pattern';
  kind: 'linear' | 'circular';
  bodies: string[];
  count: Expr;
  /** linear: direction axis; circular: rotation axis */
  axis: 'X' | 'Y' | 'Z';
  /** linear: spacing between copies; circular: total angle (degrees) */
  spacing: Expr;
  /** circular: axis origin */
  center: [Expr, Expr, Expr];
  /** linear: optional second direction */
  count2?: Expr;
  axis2?: 'X' | 'Y' | 'Z';
  spacing2?: Expr;
  merge: boolean;
}

export interface MirrorFeature extends FeatureBase {
  type: 'mirror';
  bodies: string[];
  plane: OriginPlane;
  offset: Expr;
  merge: boolean;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | PrimitiveFeature
  | BooleanFeature
  | TransformFeature
  | PatternFeature
  | MirrorFeature;

export type FeatureType = Feature['type'];

export interface CadDocument {
  format: 'owncad';
  version: 1;
  name: string;
  units: 'mm';
  params: Parameter[];
  features: Feature[];
  /** Number of active features (features at index >= rollback are rolled back). null = all. */
  rollback: number | null;
  hiddenBodies: string[];
  nextId: number;
}
