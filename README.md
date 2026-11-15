# Benzina

Multiplayer arcade racing in the browser (desktop and mobile). Three.js for rendering, Rapier
(deterministic WASM build) for physics, and a Node + `ws` server that runs the same simulation
authoritatively while clients predict.

## Running

```sh
npm install
npm run dev          # game server (:2567) + client (http://localhost:5173), Ctrl+C stops both
npm test             # simulation + netcode tests
npm run typecheck
npm run bots -- --room ABCD --count 3   # headless bot clients join a room over the network
```

Open http://localhost:5173 and you're dropped into a room; the URL gains `?room=CODE`, so share it to
invite others. Vite listens on your LAN, so a phone on the same Wi-Fi can open the "Network" URL it prints.
The client always talks to `/ws` on its own origin; in dev, Vite proxies that to the game server.

URL options:

| Option | Effect |
|---|---|
| `?room=CODE` | join or create a specific room (otherwise quick-play) |
| `?name=NAME` | driver name |
| `?bots=N` | server-side bots when creating a room |
| `?offline` | single player, no server |
| `?bot` | autopilot drives your car |
| `?debug` | show the netcode overlay (toggle with <code>`</code> or F3) |
| `?lag=MS&jitter=MS&loss=PCT` | simulate a bad network (round-trip lag; loss = TCP-style stalls) |

Controls: W/↑ throttle · S/↓ brake/reverse · A/D or ←/→ steer · Space handbrake · R reset.
A standard gamepad works too (RT/LT, left stick, A handbrake, Y reset). Touch controls are next.

The **Handling (dev)** panel, top right, tweaks car tuning live. Offline, values persist in
localStorage; online, changes apply to everyone in the room (dev server only).

## Layout

```
packages/
  shared/   Simulation used by both client and server. No rendering, no DOM.
    config.ts   tick rate (60 Hz) and arcade tuning parameters
    input.ts    CarInput, the per-tick controls (this is what clients will send)
    track.ts    tracks from a closed spline → centre line, edges, wall segments
    car.ts      arcade car controller (one rigid body, roll/pitch locked)
    world.ts    SimWorld: physics world + track + cars, fixed-step `step(inputs)`
    state.ts    CarState snapshot
    protocol.ts binary input/snapshot codecs, JSON control messages, input quantization
    predictor.ts client prediction + reconciliation (no rendering, no sockets)
    bot.ts      autopilot, used by tests, server bots and headless bot clients
  server/   Node game server
    index.ts       HTTP + WebSocket entry point (/ws, /health)
    lobby.ts       rooms by code, quick-play, single fixed-rate tick loop
    room.ts        one race: authoritative SimWorld, per-player input queues, snapshots
    botClients.ts  headless network bots (npm run bots)
  client/   Vite + Three.js browser game
    main.ts         frame loop: poll snapshot → fixed ticks → render
    session.ts      OfflineSession / OnlineSession behind one interface
    net/            WebSocket connection, network condition simulator, stats
    carRenderer.ts  draws all cars, interpolates ticks, smooths corrections
    debugOverlay.ts netcode stats + server "ghost" boxes
    scene.ts        lights, road/curb/wall/tree meshes generated from the track
    carView.ts      low-poly car mesh
    chaseCamera.ts  smoothed third-person camera
    input.ts        keyboard + gamepad → CarInput
    lapTimer.ts     local lap timing (server will own this later)
```

## Design notes

- **One simulation, two places.** `SimWorld` is pure TypeScript + Rapier and runs unchanged in the
  browser and in Node. Same inputs → bit-identical state (enforced by a test).
- **Arcade car model.** Each car is one dynamic body with roll/pitch locked, hovering ~12 cm above
  the road on a raycast spring. Rapier does gravity and collisions; each tick the controller
  rewrites velocity for suspension, acceleration, grip and steering. Hovering matters for netcode:
  resting on the ground goes through Rapier's contact solver, whose internal state can't be restored
  from a snapshot, and that alone produced 35 cm prediction errors. The spring depends only on
  position and velocity, so re-simulation reproduces the server exactly (sub-millimetre, tested).
- **Fixed 60 Hz tick** on both sides; rendering interpolates between ticks.

### Netcode

- Clients send one 8-byte input per tick (quantized, and the client predicts with the quantized value).
  The server sends a ~84-byte-per-car snapshot at 30 Hz (~3 KB/s solo, ~10 KB/s with four cars).
- **Server: one input per tick, always.** Each tick consumes the next input seq for each player. If it
  hasn't arrived, the server simulates with a guess (the previous input) and discards the real one
  when it turns up late. Client and server timelines stay aligned 1:1, so a network stall only costs
  guess-vs-reality error. (Before this, a 2% loss stall caused 8 m corrections; now ~25 cm worst case.)
- **Client: predict everything.** On each snapshot, every car is reset to the server state and the
  unacknowledged local inputs are replayed. Remote cars replay with their last known input, which
  forward-predicts them to the present, so collisions happen where cars actually are.
- **Time sync.** Snapshots report how many of your inputs the server has queued; the client runs its
  clock up to ±5% fast or slow to keep about 2 queued, just ahead of when they're needed.
- **Smoothing.** Corrections become a visual offset that decays over ~100 ms; teleports (>6 m) snap.
- Tested in-process (`packages/server/test/netcode.test.ts`): real Room + Predictor over a fake link
  with latency and TCP-style stalls.

## Roadmap

1. ✅ Local arcade car on a test track, tuning panel, lap timer
2. ✅ Server runs `SimWorld`; client prediction + reconciliation; rooms; debug overlay; bots
   - Next: mobile pass (touch controls, performance, layout); mobile is required for v1
3. Car-to-car collisions: tune bump response and remote-car prediction (forward prediction is in place)
4. Race flow: lobby → countdown → race → results; checkpoints, positions, room codes
5. Art, sound, more tracks
6. Accounts, leaderboards, multiple regions
