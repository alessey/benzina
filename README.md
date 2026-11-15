# Benzina

Multiplayer arcade racing in the browser. Three.js for rendering, Rapier (deterministic WASM build) for physics,
and eventually a Node + Colyseus server that runs the same simulation authoritatively.

## Running

```sh
npm install
npm run dev          # http://localhost:5173  (add ?bot to watch the autopilot drive)
npm test             # simulation tests (determinism, walls, bot completes a lap)
npm run typecheck
```

Controls: W/↑ throttle · S/↓ brake/reverse · A/D or ←/→ steer · Space handbrake · R reset.
A standard gamepad works too (RT/LT, left stick, A handbrake, Y reset).

The **Handling (dev)** panel, top right, tweaks car tuning live; values persist in localStorage.

## Layout

```
packages/
  shared/   Simulation used by both client and server. No rendering, no DOM.
    config.ts   tick rate (60 Hz) and arcade tuning parameters
    input.ts    CarInput, the per-tick controls (this is what clients will send)
    track.ts    tracks from a closed spline → centre line, edges, wall segments
    car.ts      arcade car controller (one rigid body, roll/pitch locked)
    world.ts    SimWorld: physics world + track + cars, fixed-step `step(inputs)`
    state.ts    CarState snapshot (what server snapshots will carry)
    bot.ts      autopilot, used by tests and future headless bot clients
  client/   Vite + Three.js browser game
    main.ts         fixed-timestep loop with render interpolation
    scene.ts        lights, road/curb/wall/tree meshes generated from the track
    carView.ts      low-poly car mesh following sim state
    chaseCamera.ts  smoothed third-person camera
    input.ts        keyboard + gamepad → CarInput
    lapTimer.ts     local lap timing (server will own this later)
```

## Design notes

- **One simulation, two places.** `SimWorld` is pure TypeScript + Rapier and runs unchanged in the
  browser and in Node. Same inputs → bit-identical state (enforced by a test).
- **Arcade car model.** Each car is one dynamic body with roll/pitch locked and zero friction.
  Rapier does gravity and collisions; each tick the controller rewrites velocity for acceleration,
  grip and steering. The whole car state is position, rotation, velocities and one steering value,
  which keeps prediction and reconciliation manageable.
- **Fixed 60 Hz tick**, rendering interpolates between ticks.

## Roadmap

1. ✅ Local arcade car on a test track, tuning panel, lap timer
2. Server (Node + Colyseus) runs `SimWorld`; client prediction + reconciliation; netcode debug overlay
3. Car-to-car collisions: forward-predict remote cars, tune bump response, correction smoothing
4. Race flow: lobby → countdown → race → results; checkpoints, positions, room codes
5. Art, sound, more tracks
6. Accounts, leaderboards, multiple regions
