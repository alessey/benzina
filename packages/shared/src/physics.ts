import RAPIER from '@dimforge/rapier3d-deterministic-compat';

export { RAPIER };

let ready: Promise<void> | null = null;

/**
 * Load the Rapier WASM module. Must resolve before creating a SimWorld.
 * We use the deterministic build so client and server produce identical results
 * given identical inputs.
 */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}
