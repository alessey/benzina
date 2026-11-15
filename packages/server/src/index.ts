import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { initPhysics } from '@benzina/shared';
import { Lobby } from './lobby';
import type { Connection } from './room';

const PORT = Number(process.env.PORT ?? 2567);
const DEV = process.env.NODE_ENV !== 'production';
/** Skip snapshots to a client whose socket has this much unsent data (slow link). */
const MAX_BUFFERED_BYTES = 64 * 1024;

await initPhysics();

const lobby = new Lobby({ allowTuning: DEV });
lobby.start();

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: lobby.roomCount }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const code = url.searchParams.get('room');
  const name = url.searchParams.get('name') ?? '';
  const bots = Math.max(0, Math.min(7, Number(url.searchParams.get('bots') ?? 0) || 0));

  const conn: Connection = {
    send(data) {
      if (ws.readyState !== ws.OPEN) return;
      if (typeof data !== 'string' && ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
      ws.send(data);
    },
  };

  const room = lobby.findRoom(code, { bots });
  const id = room.join(conn, name);
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
