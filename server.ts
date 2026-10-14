import { Game } from './game.js'; // same rules the browser runs locally; this server is only needed for ?online

const game = new Game();
game.reset(); // crates behind the title screen
let nextId = 1;

const server = Bun.serve<{ id: string }>({
  port: Number(process.env.PORT) || 3000,
  hostname: '0.0.0.0',
  fetch(req, server) {
    if (server.upgrade(req, { data: { id: String(nextId++) } })) return;
    const path = new URL(req.url).pathname;
    if (/^\/(game\.js|assets\/[\w-]+\.(glb|png))$/.test(path)) return new Response(Bun.file(import.meta.dir + path));
    return new Response(Bun.file(import.meta.dir + '/index.html'));
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ t: 'hello', id: ws.data.id }));
      ws.subscribe('game');
    },
    message(ws, raw) {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      game.receive(ws.data.id, m);
    },
    close(ws) { game.leave(ws.data.id); },
  },
});

setInterval(() => {
  game.tick(1 / 30);
  server.publish('game', JSON.stringify(game.snapshot()));
}, 1000 / 30);

console.log(`Bomberman on http://localhost:${server.port}`);
