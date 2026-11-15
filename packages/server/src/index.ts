import { createServer } from 'node:http';
import { staticHandler } from './static';
import { WebSocketServer, type WebSocket } from 'ws';
import { initPhysics, parseCarChoice } from '@benzina/shared';
import { Lobby } from './lobby';
import type { Connection } from './room';

const PORT = Number(process.env.PORT ?? 2567);
const DEV = process.env.NODE_ENV !== 'production';
/** Skip snapshots to a client whose socket has this much unsent data (slow link). */
const MAX_BUFFERED_BYTES = 64 * 1024;
/** Built client to serve (production); unset in dev, where Vite serves the client. */
const CLIENT_DIST = process.env.CLIENT_DIST;
/** Basic abuse protection: simultaneous game connections allowed from one IP. */
const MAX_CONNECTIONS_PER_IP = 8;

await initPhysics();

const lobby = new Lobby({ allowTuning: DEV });
lobby.start();

const serveClient = CLIENT_DIST ? staticHandler(CLIENT_DIST) : null;

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: lobby.roomCount }));
    return;
  }
  if (serveClient?.(req, res)) return;
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096 });
const connectionsPerIp = new Map<string, number>();

/** Client IP, as seen through Fly's proxy if present. */
function clientIp(req: import('node:http').IncomingMessage): string {
  const forwarded = req.headers['fly-client-ip'] ?? req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  return (first ?? req.socket.remoteAddress ?? 'unknown').trim();
}

wss.on('connection', (ws: WebSocket, req) => {
  const ip = clientIp(req);
  const open = connectionsPerIp.get(ip) ?? 0;
  if (open >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1008, 'too many connections');
    return;
  }
  connectionsPerIp.set(ip, open + 1);
  ws.on('close', () => {
    const left = (connectionsPerIp.get(ip) ?? 1) - 1;
    if (left <= 0) connectionsPerIp.delete(ip);
    else connectionsPerIp.set(ip, left);
  });

  const url = new URL(req.url ?? '/', 'http://localhost');
  // mode: quick (any public lobby) | create (new private room) | join (by code; default if a code is given)
  const code = url.searchParams.get('room');
  const mode = url.searchParams.get('mode') ?? (code ? 'join' : 'quick');
  const name = url.searchParams.get('name') ?? '';
  const bots = Math.max(0, Math.min(7, Number(url.searchParams.get('bots') ?? 0) || 0));

  const conn: Connection = {
    send(data) {
      if (ws.readyState !== ws.OPEN) return;
      if (typeof data !== 'string' && ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
      ws.send(data);
    },
  };

  const room =
    mode === 'create'
      ? lobby.createPrivate({ bots })
      : mode === 'join' && code
        ? lobby.joinByCode(code, { bots })
        : lobby.quickPlay({ bots });
  // Car choice: ?car=bolide&color=ff3300
  const car = parseCarChoice({ cls: url.searchParams.get('car'), color: parseInt(url.searchParams.get('color') ?? '', 16) });
  const id = room.join(conn, name, car);
  if (id === null) {
    ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
    ws.close();
    lobby.cleanup(room);
    return;
  }
  console.log(`[${room.code}] +${id} (${room.humanCount} humans, ${room.carCount} cars)`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) room.handleBinary(id, data as Buffer);
    else room.handleText(id, data.toString());
  });
  ws.on('close', () => {
    room.leave(id);
    console.log(`[${room.code}] -${id} (${room.humanCount} humans)`);
    lobby.cleanup(room);
  });
});

http.listen(PORT, () => console.log(`benzina server listening on :${PORT} (ws path /ws)`));
