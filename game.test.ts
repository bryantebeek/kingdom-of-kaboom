import { expect, test } from 'bun:test';
import { Game, W, HEROES, botThink } from './game';

// Walls are random per round; tests that depend on exact tiles use the classic pillar grid.
const classic = g => g.grid.map((_, i) => {
  const x = i % W, y = Math.floor(i / W);
  return x === 0 || y === 0 || x === W - 1 || y === 12 || (x % 2 === 0 && y % 2 === 0) ? '#' : '.';
});

test('bomb kills in range, destroys a block, chains, and awards the round', () => {
  const g = new Game();
  g.join('a', 'A');
  g.join('b', 'B');
  g.grid = classic(g);
  const [a, b] = g.players.values();
  expect(a.range).toBe(1); // everyone starts with the short blast
  Object.assign(a, { x: 1, y: 1, range: 2 });
  Object.assign(b, { x: 5, y: 1 });
  g.grid[g.idx(1, 3)] = '+';
  g.grid[g.idx(1, 5)] = '+';

  g.input('a', { t: 'bomb' }); // (1,1), range 2
  g.bombs.push({ id: 99, x: 3, y: 1, owner: 'x', t: 99, range: 2 }); // chained, reaches b at (5,1)
  Object.assign(a, { x: 5, y: 3 }); // step out of every blast line
  for (let t = 0; t < 2.6; t += 1 / 30) g.tick(1 / 30);

  expect(g.bombs).toHaveLength(0);
  expect(g.grid[g.idx(1, 3)]).toBe('.'); // destroyed
  expect(g.grid[g.idx(1, 5)]).toBe('+'); // flame stopped at the first block
  expect(b.alive).toBe(false);
  expect(a.score).toBe(1);
  const ev = g.snapshot().ev.map((e: any) => e.e);
  expect(ev.filter((e: string) => e === 'boom')).toHaveLength(2);
  expect(ev).toContain('block');
  expect(ev).toContain('kill');
  expect(g.grid[W]).toBe('#');
  g.input('b', { t: 'dir', d: 'toString' });
  expect(b.dir).toBeNull();
});

test('last player standing wins', () => {
  const g = new Game();
  g.join('a', 'A');
  g.join('b', 'B');
  g.players.get('b')!.alive = false;
  g.tick(1 / 30);
  expect(g.players.get('a')!.score).toBe(1);
  expect(g.snapshot().msg).toBe('A wins!');
});

test('glides smoothly, finishes the step on release, stops at walls', () => {
  const g = new Game();
  g.join('a', 'A');
  g.grid = classic(g);
  const a = g.players.get('a')!;
  Object.assign(a, { x: 1, y: 1 });
  g.input('a', { t: 'dir', d: 'right' });
  g.tick(0.1);
  expect(a.x).toBeCloseTo(1.5); // mid-tile, not a hop
  g.input('a', { t: 'dir', d: null });
  g.tick(0.2);
  expect([a.x, a.m]).toEqual([2, null]); // released: finished to the center and stopped
  g.input('a', { t: 'dir', d: 'up' });
  g.tick(0.5);
  expect([a.x, a.y]).toEqual([2, 1]); // wall above: no movement
  g.input('a', { t: 'dir', d: 'left' });
  g.tick(0.1);
  g.input('a', { t: 'dir', d: 'right' });
  g.tick(0.1);
  expect(a.x).toBeCloseTo(2); // reversed instantly mid-tile
});

test('bot bombs a crate and survives its own blast', () => {
  const g = new Game();
  g.join('bot', 'Bot');
  g.join('x', 'Idle');
  g.grid = classic(g);
  g.grid[g.idx(1, 3)] = '+';
  const bot = g.players.get('bot'), idle = g.players.get('x');
  Object.assign(bot, { x: 1, y: 1 });
  Object.assign(idle, { x: 13, y: 11 });
  let t = 0;
  for (; t < 6 && g.grid[g.idx(1, 3)] === '+'; t += 1 / 30) { botThink(g, 'bot'); g.tick(1 / 30); }
  expect(g.grid[g.idx(1, 3)]).toBe('.'); // crate gone
  for (let i = 0; i < 30; i++) { botThink(g, 'bot'); g.tick(1 / 30); }
  expect(bot.alive).toBe(true); // got out of its own blast
});

test('bot-only matches keep fighting and rounds keep ending', () => {
  const g = new Game();
  for (const id of ['a', 'b', 'c']) g.join(id, id);
  g.reset();
  let rounds = 0, booms = 0;
  for (let t = 0; t < 600; t += 1 / 30) {
    for (const id of ['a', 'b', 'c']) botThink(g, id);
    const before = g.overT;
    g.tick(1 / 30);
    booms += g.snapshot().ev.filter(e => e.e === 'boom').length;
    if (!before && g.overT) rounds++;
  }
  expect(booms).toBeGreaterThan(100); // bots keep bombing: no passive stand-offs
  expect(rounds).toBeGreaterThanOrEqual(3); // and rounds end: no clock, so someone has to win
});

test('with no crates left, potions keep appearing on open floor, faster and faster', () => {
  const g = new Game();
  g.join('a', 'A');
  g.join('b', 'B');
  g.grid = classic(g);
  const [a, b] = g.players.values();
  Object.assign(a, { x: 1, y: 1 });
  Object.assign(b, { x: 13, y: 11 });
  const at = [];
  for (let t = 0; t < 20; t += 1 / 30) {
    const n = g.items.size;
    g.tick(1 / 30);
    if (g.items.size > n) at.push(t);
  }
  expect(at.length).toBeGreaterThan(10);
  expect(at[1] - at[0]).toBeGreaterThan(at.at(-1) - at.at(-2)); // speeding up
  for (const [k] of g.items) expect(g.grid[k]).toBe('.');
  expect(g.overT).toBe(0); // no clock ends the round
});

test('wall layouts vary, stay symmetric, keep spawns open and everything reachable', () => {
  const g = new Game(), layouts = new Set();
  for (let i = 0; i < 200; i++) {
    const w = g.makeWalls();
    layouts.add(w.join(''));
    for (let y = 0; y < 13; y++) for (let x = 0; x < W; x++) {
      expect(w[y * W + x]).toBe(w[(12 - y) * W + (W - 1 - x)]); // mirrored
      if (x === 0 || y === 0 || x === W - 1 || y === 12) expect(w[y * W + x]).toBe('#'); // border intact
    }
    for (const [x, y] of [[1, 1], [2, 1], [3, 1], [1, 2], [1, 3], [13, 11], [7, 1], [1, 5]]) expect(w[y * W + x]).toBe('.');
    const open = w.filter(c => c === '.').length, seen = new Set([W + 1]), q = [W + 1];
    for (let k; (k = q.shift()) !== undefined;) for (const n of [k - 1, k + 1, k - W, k + W]) if (w[n] === '.' && !seen.has(n)) { seen.add(n); q.push(n); }
    expect(seen.size).toBe(open); // no sealed-off pockets
  }
  expect(layouts.size).toBeGreaterThan(150); // actually varied
});

test('two characters never share a tile', () => {
  const g = new Game();
  g.join('a', 'A');
  g.join('b', 'B');
  g.grid = classic(g);
  const a = g.players.get('a'), b = g.players.get('b');
  Object.assign(a, { x: 1, y: 1 });
  Object.assign(b, { x: 3, y: 1 }); // same corridor, one tile apart
  g.input('a', { t: 'dir', d: 'right' });
  g.input('b', { t: 'dir', d: 'left' });
  for (let i = 0; i < 30; i++) {
    g.tick(1 / 30);
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(1 - 1e-9); // never overlapping
  }
  expect([a.x, b.x]).toEqual([2, 3]); // a claimed the middle tile first; b stays put
});

test('remote players join once with a clean name, then send inputs', () => {
  const g = new Game();
  g.receive('a', { t: 'join', name: '  Lancelot of the Very Long Name ' });
  g.receive('a', { t: 'join', name: 'Impostor' });
  g.receive('b', { t: 'join' });
  g.receive('a', null);
  g.receive('a', { t: 'dir', d: 'left' });
  expect([...g.players.values()].map(p => p.name)).toEqual(['Lancelot of the ', 'anon']);
  expect(g.players.get('a').dir).toBe('left');
});

test('a newcomer resets the scores; someone rejoining keeps theirs', () => {
  const g = new Game();
  g.receive('a', { t: 'join', name: 'A', key: 'ka' });
  g.receive('b', { t: 'join', name: 'B', key: 'kb' });
  g.players.get('a').score = 3;
  g.players.get('b').score = 2;
  g.leave('b');
  g.receive('b2', { t: 'join', name: 'B', key: 'kb' }); // same person, new connection
  expect([g.players.get('a').score, g.players.get('b2').score]).toEqual([3, 2]);
  g.leave('b2');
  g.receive('c', { t: 'join', name: 'C', key: 'kc' }); // someone new
  expect([g.players.get('a').score, g.players.get('c').score]).toEqual([0, 0]);
  g.receive('b3', { t: 'join', name: 'B', key: 'kb' }); // was away for the reset: starts over too, but isn't new
  g.players.get('a').score = 1;
  expect(g.players.get('b3').score).toBe(0);
  expect(g.players.get('a').score).toBe(1);
});

test('first to N wins the tourney: podium for the top 3, then a fresh tourney', () => {
  const g = new Game();
  for (const id of ['a', 'b', 'c', 'd']) g.join(id, id.toUpperCase());
  g.firstTo = 2;
  const [a, b, c, d] = g.players.values();
  Object.assign(b, { score: 1 }); Object.assign(c, { score: 0 }); Object.assign(d, { score: 1 });
  a.score = 1;
  for (const p of [b, c, d]) p.alive = false; // a wins this round: 2 wins
  g.tick(1 / 30);
  expect(a.score).toBe(2);
  expect(g.podium).toEqual(['a', 'b', 'd']); // ties keep join order
  expect(g.snapshot().msg).toBe('A is champion!');
  expect(g.grid.includes('+')).toBe(false); // arena cleared for the ceremony
  expect([a.x, a.y, a.alive, c.alive]).toEqual([7, 6, true, false]);
  for (let t = 0; t < 10.1; t += 0.1) g.tick(0.1);
  expect(g.podium).toBeNull();
  expect([...g.players.values()].map(p => p.score)).toEqual([0, 0, 0, 0]);
});

test('every player gets a different hero until they run out', () => {
  const g = new Game();
  for (let i = 0; i < HEROES; i++) g.join(`p${i}`, `P${i}`);
  expect(new Set([...g.players.values()].map(p => p.look)).size).toBe(HEROES);
  g.join('extra', 'Extra');
  expect(g.players.get('extra').look).toBeLessThan(HEROES);
});
