// Loads the manifold-3d WASM solid kernel.

import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { ManifoldToplevel } from 'manifold-3d';

let wasm: ManifoldToplevel | null = null;

export async function initKernel(): Promise<ManifoldToplevel> {
  if (wasm) return wasm;
  const m = await Module({ locateFile: () => wasmUrl });
  m.setup();
  m.setMinCircularAngle(3);
  m.setMinCircularEdgeLength(0.25);
  wasm = m;
  return m;
}

export function kernel(): ManifoldToplevel {
  if (!wasm) throw new Error('Kernel not initialised');
  return wasm;
}
