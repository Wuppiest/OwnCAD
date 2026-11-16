# OwnCAD

A browser-based **parametric 3D CAD** application. Sketch on planes or faces, constrain and dimension your sketches, and build solids from a fully editable feature history.

Built with TypeScript + Vite, [Three.js](https://threejs.org) for the viewport, [manifold-3d](https://github.com/elalish/manifold) (WASM) as the solid kernel, and FreeCAD's [planegcs](https://github.com/Salusoft89/planegcs) (WASM) as the 2D constraint solver.

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static build in dist/ (works from any sub-path, e.g. GitHub Pages)
npm test         # unit tests (Vitest)
```

## Features

**Viewport** – orbit (left drag; right drag while sketching), pan (middle drag or Shift + drag), zoom to cursor (wheel), view cube, standard views, fit all, perspective/orthographic, adaptive grid.

**Sketching** – on the XY / XZ / YZ planes (with offset) or on any planar face of a body (press **S** while hovering a face).
- Tools: line (chained), rectangle, center rectangle, circle, center arc, 3-point arc, polygon, point, fillet, trim, mirror, project model edges
- Regions are detected at every intersection and T-junction, so crossing lines split profiles
- Snapping: endpoints, midpoints, intersections, curves, model edges, grid, horizontal/vertical alignment; Shift = orthogonal
- Numeric input while drawing: just type (length/angle, width/height, diameter, …), Tab to switch fields, Enter to confirm
- Constraints: coincident, point-on-curve, horizontal, vertical, parallel, perpendicular, equal, tangent, midpoint, symmetric, concentric, fix
- Dimensions: aligned / horizontal / vertical distance, point-to-line, radius, diameter, angle — values accept expressions and parameters; reference (driven) dimensions
- Live degrees-of-freedom display, conflict detection, closed profiles shaded

**Features** – Extrude (one side / reversed / symmetric, taper, pick individual profile regions), Revolve (about sketch axes or any sketch line), Box / Cylinder / Sphere / Cone / Torus, Combine (union / subtract / intersect), Move / Rotate / Scale / Copy (with drag gizmo), linear (2-direction) and circular patterns, Mirror. Each feature can create a new body, join, cut or intersect; "Automatic" targets the bodies the feature touches.

**Parametric** – parameter table with expressions (`width * 2`, `1in`, `sqrt(2)*10`, …), editable history, suppress, reorder, rollback marker, rename.

**Editing** – selection, delete, undo/redo for everything, measure tool (with vertex snapping), body properties (volume, area, bounding box, mass estimate).

**Files** – save/load `.owncad.json` projects, autosave to the browser; export STL, OBJ, GLB, PNG; export sketches as DXF / SVG.

## Project layout

```
src/
  model/      document model, undo/redo store, expression evaluator
  kernel/     manifold-3d loader and history regeneration
  sketch/     sketch editor, solver bridge, profile detection, geometry helpers
  view/       Three.js viewport and view cube
  ui/         ribbon icons, feature tree, properties, parameters, numeric input
  io/         save/load and exporters
tests/        unit tests
```

## Known limitations (v1)

- Mesh-based kernel: no STEP/IGES export, no edge fillets/chamfers on solids (sketch fillets are supported).
- Sketches on faces store the face plane at creation time (not re-attached if the face moves).
