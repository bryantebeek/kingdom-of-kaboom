export const W = 15, H = 13;
const SPAWNS = [[1, 1], [13, 11], [13, 1], [1, 11], [7, 1], [7, 11], [1, 5], [13, 5]];
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ecf0f1'];
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const FLAME = 0.3; // seconds a blast stays deadly
const ROUND_TIME = 180; // then it's a draw, so a round can't stall forever

// Player: { id, name, color, x, y, alive, maxBombs, range, delay, dir, m, score }
// x/y are floats: players glide between tile centers, `m` is the current glide direction.

export class Game {
  grid = []; // '#' wall, '+' breakable, '.' empty
  players = new Map();
  bombs = [];
  flames = [];
  items = new Map(); // tile -> 'b' +bomb, 'r' +range, 's' +speed
  roundSize = 0;
  round = 0;
  ev = []; // one-shot events for client effects, drained by snapshot()
  overT = 0;
  msg = '';
  bombId = 0;
  rand = Math.random;

  idx(x, y) { return y * W + x; }
  bombAt(x, y) { return this.bombs.find(b => b.x === x && b.y === y); }
  free(x, y) { return this.grid[this.idx(x, y)] === '.' && !this.bombAt(x, y); }

  // A fresh wall layout per round: the classic pillar grid with random gaps and extra walls,
  // mirrored four ways so every corner spawn is equally fair. Spawns stay open and every
  // open tile stays reachable (retried until it is).
  makeWalls() {
    for (;;) {
      const keep = 0.55 + this.rand() * 0.4, extra = 0.04 + this.rand() * 0.12;
      const quad = Array.from({ length: H }, () => Array.from({ length: W }, () => this.rand()));
      const g = [];
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const qx = Math.min(x, W - 1 - x), qy = Math.min(y, H - 1 - y), r = quad[qy][qx];
        const border = qx === 0 || qy === 0, pillar = qx % 2 === 0 && qy % 2 === 0;
        g.push(border || (pillar ? r < keep : r < extra) ? '#' : '.');
      }
      const clear = (x, y) => { // and its mirror images, to stay symmetric
        if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) return;
        for (const [mx, my] of [[x, y], [W - 1 - x, y], [x, H - 1 - y], [W - 1 - x, H - 1 - y]]) g[this.idx(mx, my)] = '.';
      };
      for (const [sx, sy] of SPAWNS) for (let d = -2; d <= 2; d++) { clear(sx + d, sy); clear(sx, sy + d); } // room to dodge the first bomb
      const open = g.filter(c => c === '.').length, seen = new Set([this.idx(...SPAWNS[0])]), queue = [...seen];
      for (let k; (k = queue.shift()) !== undefined;) for (const n of [k - 1, k + 1, k - W, k + W])
        if (g[n] === '.' && !seen.has(n)) { seen.add(n); queue.push(n); }
      if (seen.size === open) return g;
    }
  }

  reset() {
    this.grid = this.makeWalls().map(c => (c === '.' && this.rand() < 0.7 ? '+' : c));
    this.bombs = []; this.flames = []; this.items.clear(); this.overT = 0; this.msg = ''; this.round++; this.roundT = 0;
    [...this.players.values()].forEach((p, i) => {
      Object.assign(p, { alive: i < SPAWNS.length, maxBombs: 1, range: 1, delay: 0.2, m: null });
      if (!p.alive) return; // ponytail: >8 players spectate, add spawns if the team grows
      [p.x, p.y] = SPAWNS[i];
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = this.idx(p.x + dx, p.y + dy);
        if (this.grid[k] === '+') this.grid[k] = '.';
      }
    });
    this.roundSize = [...this.players.values()].filter(p => p.alive).length;
  }

  join(id, name) {
    const used = new Set([...this.players.values()].map(p => p.color));
    this.players.set(id, {
      id, name, color: COLORS.find(c => !used.has(c)) ?? '#888', x: 0, y: 0, alive: false,
      maxBombs: 1, range: 1, delay: 0.2, dir: null, m: null, score: 0,
    });
    // nobody to fight yet: start fresh; otherwise wait for next round
    if ([...this.players.values()].filter(p => p.alive).length <= 1) this.reset();
  }

  leave(id) { this.players.delete(id); }

  input(id, m) {
    const p = this.players.get(id);
    if (!p) return;
    if (m.t === 'dir') p.dir = Object.hasOwn(DIRS, m.d) ? m.d : null;
    const x = Math.round(p.x), y = Math.round(p.y);
    if (m.t === 'bomb' && p.alive && !this.overT && !this.bombAt(x, y)
      && this.bombs.filter(b => b.owner === id).length < p.maxBombs) {
      this.bombs.push({ id: ++this.bombId, x, y, owner: id, t: 2.5, range: p.range });
      this.ev.push({ e: 'place', x, y });
    }
  }

  explode(b) {
    this.bombs.splice(this.bombs.indexOf(b), 1);
    this.flames.push({ x: b.x, y: b.y, t: FLAME, owner: b.owner });
    this.ev.push({ e: 'boom', x: b.x, y: b.y });
    for (const [dx, dy] of Object.values(DIRS)) for (let i = 1; i <= b.range; i++) {
      const x = b.x + dx * i, y = b.y + dy * i, k = this.idx(x, y);
      if (this.grid[k] === '#') break;
      this.flames.push({ x, y, t: FLAME, owner: b.owner });
      if (this.grid[k] === '+') {
        this.grid[k] = '.';
        this.ev.push({ e: 'block', x, y });
        if (this.rand() < 0.3) this.items.set(k, 'brs'[Math.floor(this.rand() * 3)]);
        break;
      }
      this.items.delete(k);
      const other = this.bombAt(x, y);
      if (other) other.t = 0;
    }
  }

  // Glide toward tile centers. Turns happen at centers (with a little grace just past one),
  // reversing is instant, and letting go finishes the step to the next center.
  move(p, dt) {
    let budget = dt / p.delay;
    while (budget > 1e-9) {
      if (p.m && p.dir === OPPOSITE[p.m]) p.m = p.dir;
      if (p.m && p.dir && p.dir !== p.m) { // late turn: snap back if we only just passed a center
        const bx = DIRS[p.m][0] > 0 ? Math.floor(p.x) : DIRS[p.m][0] < 0 ? Math.ceil(p.x) : p.x;
        const by = DIRS[p.m][1] > 0 ? Math.floor(p.y) : DIRS[p.m][1] < 0 ? Math.ceil(p.y) : p.y;
        if (Math.abs(p.x - bx) + Math.abs(p.y - by) < 0.25 && this.free(bx + DIRS[p.dir][0], by + DIRS[p.dir][1])) { p.x = bx; p.y = by; }
      }
      const cx = Math.round(p.x), cy = Math.round(p.y);
      const atCenter = Math.abs(p.x - cx) + Math.abs(p.y - cy) < 1e-6;
      if (atCenter) {
        p.x = cx; p.y = cy;
        p.m = p.dir && this.free(cx + DIRS[p.dir][0], cy + DIRS[p.dir][1]) ? p.dir : null;
        if (!p.m) return;
      }
      const [dx, dy] = DIRS[p.m];
      const dist = atCenter ? 1 : dx > 0 ? Math.ceil(p.x) - p.x : dx < 0 ? p.x - Math.floor(p.x) : dy > 0 ? Math.ceil(p.y) - p.y : p.y - Math.floor(p.y);
      const step = Math.min(dist, budget);
      p.x += dx * step; p.y += dy * step;
      budget -= step;
    }
  }

  tick(dt) {
    if (!this.players.size) return;
    if (this.overT > 0) { if ((this.overT -= dt) <= 0) this.reset(); return; }

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      this.move(p, dt);
      const x = Math.round(p.x), y = Math.round(p.y), k = this.idx(x, y), it = this.items.get(k);
      if (!it) continue;
      this.items.delete(k);
      this.ev.push({ e: 'pickup', x, y, k: it });
      if (it === 'b') p.maxBombs++;
      else if (it === 'r') p.range++;
      else p.delay = Math.max(0.1, p.delay - 0.025);
    }

    for (const b of this.bombs) b.t -= dt;
    for (let b; (b = this.bombs.find(b => b.t <= 0));) this.explode(b);
    for (const f of this.flames) f.t -= dt;
    this.flames = this.flames.filter(f => f.t > 0);

    const hot = new Map(this.flames.map(f => [this.idx(f.x, f.y), f.owner]));
    for (const p of this.players.values()) {
      const owner = hot.get(this.idx(Math.round(p.x), Math.round(p.y)));
      if (!p.alive || owner === undefined) continue;
      p.alive = false;
      p.m = null; // the dead don't glide
      const k = this.players.get(owner);
      this.ev.push({ e: 'kill', v: p.name, vc: p.color, k: k?.name ?? '???', kc: k?.color ?? '#888', self: owner === p.id });
    }

    const alive = [...this.players.values()].filter(p => p.alive);
    if ((this.roundT += dt) >= ROUND_TIME) { this.msg = "Time's up!"; this.overT = 3; return; }
    if (this.roundSize >= 2 ? alive.length <= 1 : alive.length === 0) {
      if (alive[0]) { alive[0].score++; this.msg = `${alive[0].name} wins!`; }
      else this.msg = this.roundSize >= 2 ? 'Draw!' : 'Game over';
      this.overT = 3;
    }
  }

  // Tiles a bomb's flames will reach (stops at walls, includes the first crate).
  blast(b) {
    const out = [this.idx(b.x, b.y)];
    for (const [dx, dy] of Object.values(DIRS)) for (let i = 1; i <= b.range; i++) {
      const k = this.idx(b.x + dx * i, b.y + dy * i), c = this.grid[k];
      if (c === '#') break;
      out.push(k);
      if (c === '+') break;
    }
    return out;
  }

  // Seconds until each threatened tile is on fire (chain reactions included; burning now = 0).
  danger(extra = []) {
    const bombs = [...this.bombs, ...extra].map(b => ({ ...b }));
    for (let changed = true; changed;) {
      changed = false;
      for (const a of bombs) for (const k of this.blast(a)) for (const b of bombs)
        if (this.idx(b.x, b.y) === k && b.t > a.t) { b.t = a.t; changed = true; }
    }
    const t = new Map();
    for (const b of bombs) for (const k of this.blast(b)) t.set(k, Math.min(t.get(k) ?? Infinity, b.t));
    for (const f of this.flames) t.set(this.idx(f.x, f.y), 0);
    return t;
  }

  snapshot() {
    const ev = this.ev;
    this.ev = [];
    return {
      round: this.round, ev, timeLeft: Math.ceil(ROUND_TIME - this.roundT),
      grid: this.grid.join(''),
      players: [...this.players.values()].map(({ id, name, color, x, y, alive, score, delay, maxBombs, range, m, dir }) =>
        ({ id, name, color, x: +x.toFixed(3), y: +y.toFixed(3), alive, score, delay, maxBombs, range, m, d: dir })),
      bombs: this.bombs.map(({ id, x, y, t }) => ({ id, x, y, t: Math.round(t * 100) / 100 })),
      flames: this.flames.map(f => [f.x, f.y]),
      items: [...this.items],
      msg: this.overT > 0 ? this.msg : '',
    };
  }
}

// ---------- bots ----------
// Plays through game.input like a human. Every tick: flee if the tile is about to burn, otherwise
// grab nearby potions, walk to a spot where a bomb hits a crate or rival, and only drop it if an
// escape route exists. Plans from the tile center it's heading into, so turns land exactly there.
export function botThink(game, id) {
  const p = game.players.get(id);
  if (!p?.alive || game.overT) return;
  const [mx, my] = p.m ? DIRS[p.m] : [0, 0];
  const sx = mx > 0 ? Math.ceil(p.x) : mx < 0 ? Math.floor(p.x) : Math.round(p.x);
  const sy = my > 0 ? Math.ceil(p.y) : my < 0 ? Math.floor(p.y) : Math.round(p.y);
  const start = game.idx(sx, sy), speed = 1 / p.delay;
  const danger = game.danger();

  // BFS over walkable tiles; `ok(k, seconds)` decides whether a tile may be entered at that arrival time.
  const reach = ok => {
    const seen = new Map([[start, { d: 0, dir: null }]]), queue = [start];
    for (let k; (k = queue.shift()) !== undefined;) {
      const { d, dir } = seen.get(k), x = k % W, y = (k - x) / W;
      for (const [name, [dx, dy]] of Object.entries(DIRS)) {
        const n = game.idx(x + dx, y + dy);
        if (seen.has(n) || game.grid[n] !== '.' || game.bombAt(x + dx, y + dy) || !ok(n, (d + 1) / speed)) continue;
        seen.set(n, { d: d + 1, dir: dir ?? name });
        queue.push(n);
      }
    }
    return seen;
  };
  const passable = map => (k, t) => !map.has(k) || t < map.get(k) - 0.25; // cross before it burns
  const go = dir => { if (p.dir !== dir) game.input(id, { t: 'dir', d: dir }); };
  const nearest = (seen, want) => [...seen].sort((a, b) => a[1].d - b[1].d).find(([k]) => want(k)); // closest first, stops early

  const brain = p.bot ??= { calm: true, wait: 0 };
  if (danger.has(start)) { // run to the closest tile no blast will reach
    if (brain.calm) { brain.calm = false; brain.wait = 2 + Math.floor(Math.random() * 8); } // human-ish reaction time
    if (brain.wait-- > 0) return;
    const seen = reach(passable(danger));
    const safe = nearest(seen, k => !danger.has(k));
    return go(safe ? safe[1].dir : null);
  }
  brain.calm = true;

  const enemies = new Set([...game.players.values()].filter(o => o.alive && o !== p).map(o => game.idx(Math.round(o.x), Math.round(o.y))));
  const hits = k => {
    const b = { x: k % W, y: Math.floor(k / W), range: p.range };
    return game.blast(b).some(n => game.grid[n] === '+' || enemies.has(n));
  };
  const canEscape = k => {
    const bomb = { x: k % W, y: Math.floor(k / W), range: p.range, t: 2.5 };
    const future = game.danger([bomb]), seen = reach(passable(future));
    return !!nearest(seen, n => !future.has(n) && seen.get(n).d / speed < 2);
  };

  const here = game.idx(Math.round(p.x), Math.round(p.y));
  const mine = game.bombs.filter(b => b.owner === id).length;
  if (here === start && mine < p.maxBombs && !game.bombAt(sx, sy) && hits(start) && canEscape(start)) {
    game.input(id, { t: 'bomb' });
    return;
  }

  const seen = reach(k => !danger.has(k)); // stroll only through tiles no bomb threatens
  const goal = nearest(seen, k => game.items.has(k) && seen.get(k).d <= 8)
    ?? nearest(seen, k => hits(k) && canEscape(k))
    ?? nearest(seen, k => [...enemies].some(e => Math.abs(e % W - k % W) + Math.abs(Math.floor(e / W) - Math.floor(k / W)) <= 2));
  go(goal && goal[0] !== start ? goal[1].dir : null);
}
