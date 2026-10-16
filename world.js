/* R29-Track world builder: turns maps.js data into roads, terrain, surfaces, colliders, checkpoints,
 * spawn points, traffic lanes and Three.js scenery. Physics queries go through world.ground(x, z, y). */
(function (root) {
'use strict';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
function rng(seed) { let a = seed >>> 0 || 1; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function makeNoise(seed) {
  const r = rng(seed), p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const perm = new Uint8Array(512); for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grad = (h, x, y) => { switch (h & 7) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y; case 4: return x; case 5: return -x; case 6: return y; default: return -y; } };
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  function n2(x, y) {
    let X = Math.floor(x), Y = Math.floor(y); x -= X; y -= Y; X &= 255; Y &= 255;
    const u = fade(x), v = fade(y), a = perm[X] + Y, b = perm[X + 1] + Y;
    return lerp(lerp(grad(perm[a], x, y), grad(perm[b], x - 1, y), u), lerp(grad(perm[a + 1], x, y - 1), grad(perm[b + 1], x - 1, y - 1), u), v);
  }
  function fbm(x, y, oct = 4) { let s = 0, a = 0.5, f = 1, n = 0; for (let o = 0; o < oct; o++) { s += a * n2(x * f, y * f); n += a; a *= 0.5; f *= 2.03; } return s / n; }
  return { n2, fbm };
}
// centripetal Catmull-Rom through [x,z] control points, resampled at even spacing
function sampleSpline(ctrl, closed, spacing) {
  const n = ctrl.length, get = i => closed ? ctrl[((i % n) + n) % n] : ctrl[clamp(i, 0, n - 1)];
  const dense = [], segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const d = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-4, 0.5);
    const t0 = 0, t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    const steps = Math.max(4, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / (spacing / 3)));
    for (let k = 0; k < steps; k++) {
      const t = t1 + (t2 - t1) * k / steps;
      const L = (a, b, ta, tb) => [((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta), ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)];
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      dense.push(L(L(A1, A2, t0, t2), L(A2, A3, t1, t3), t1, t2));
    }
  }
  if (!closed) dense.push(ctrl[n - 1]);
  const pts = [dense[0]]; let acc = 0;
  for (let i = 1; i < dense.length + (closed ? 1 : 0); i++) {
    let a = dense[i - 1]; const b = dense[i % dense.length];
    let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (acc + seg >= spacing) { const f = (spacing - acc) / seg; a = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; pts.push(a); seg = Math.hypot(b[0] - a[0], b[1] - a[1]); acc = 0; }
    acc += seg;
  }
  if (closed && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < spacing * 0.6) pts.pop();
  return pts;
}

/* ---------- roads ---------- */
function makeRoad(id, pts, o) {
  const n = pts.length, closed = !!o.closed;
  const r = { id, closed, n, kind: o.kind || 'road', width: o.width, shoulder: o.shoulder ?? 1, surface: o.surface || 'asphalt',
    shoulderSurface: o.shoulderSurface || 'gravel', lanes: o.lanes || 2, laneW: o.laneW || o.width / 2, twoWay: o.twoWay !== false,
    markings: o.markings || 'two-lane', bump: o.bump || null,
    x: new Float64Array(n), z: new Float64Array(n), y: new Float64Array(n), tx: new Float64Array(n), tz: new Float64Array(n),
    s: new Float64Array(n), k: new Float64Array(n), len: 0, guard: new Int8Array(n), wall: new Int8Array(n) };
  for (let i = 0; i < n; i++) { r.x[i] = pts[i][0]; r.z[i] = pts[i][1]; }
  const idx = i => closed ? ((i % n) + n) % n : clamp(i, 0, n - 1);
  for (let i = 0; i < n; i++) {
    const a = idx(i - 1), b = idx(i + 1), dx = r.x[b] - r.x[a], dz = r.z[b] - r.z[a], l = Math.hypot(dx, dz) || 1;
    r.tx[i] = dx / l; r.tz[i] = dz / l;
    if (i > 0) r.s[i] = r.s[i - 1] + Math.hypot(r.x[i] - r.x[i - 1], r.z[i] - r.z[i - 1]);
  }
  r.len = r.s[n - 1] + (closed ? Math.hypot(r.x[0] - r.x[n - 1], r.z[0] - r.z[n - 1]) : 0);
  for (let i = 0; i < n; i++) { // signed curvature, + = turning right
    const a = idx(i - 4), b = idx(i + 4), ds = Math.max(1, (closed ? ((r.s[b] - r.s[a] + r.len) % r.len) : r.s[b] - r.s[a]));
    r.k[i] = (r.tx[a] * r.tz[b] - r.tz[a] * r.tx[b]) / ds;
  }
  r.idx = idx;
  return r;
}
function smoothProfile(r, win, maxGrade, minY = -Infinity) {
  const n = r.n, y = Array.from(r.y), out = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = -win; k <= win; k++) { const j = r.closed ? r.idx(i + k) : i + k; if (j < 0 || j >= n) continue; s += y[j]; c++; } out[i] = Math.max(minY, s / c); }
  if (maxGrade) for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < n; i++) { const ds = r.s[i] - r.s[i - 1]; out[i] = clamp(out[i], out[i - 1] - maxGrade * ds, out[i - 1] + maxGrade * ds); }
    for (let i = n - 2; i >= 0; i--) { const ds = r.s[i + 1] - r.s[i]; out[i] = clamp(out[i], out[i + 1] - maxGrade * ds, out[i + 1] + maxGrade * ds); }
  }
  r.y.set(out);
}

/* spatial hash of road segments, for nearest-road queries */
class RoadHash {
  constructor(cell) { this.cell = cell; this.map = new Map(); this.roads = []; }
  key(ix, iz) { return (ix + 40000) * 80000 + (iz + 40000); }
  add(road, margin) {
    const ri = this.roads.push(road) - 1, c = this.cell, segs = road.closed ? road.n : road.n - 1;
    for (let i = 0; i < segs; i++) {
      const j = road.idx(i + 1);
      const x0 = Math.min(road.x[i], road.x[j]) - margin, x1 = Math.max(road.x[i], road.x[j]) + margin;
      const z0 = Math.min(road.z[i], road.z[j]) - margin, z1 = Math.max(road.z[i], road.z[j]) + margin;
      for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) for (let iz = Math.floor(z0 / c); iz <= Math.floor(z1 / c); iz++) {
        const k = this.key(ix, iz); let a = this.map.get(k); if (!a) this.map.set(k, a = []); a.push(ri * 1048576 + i);
      }
    }
  }
  // nearest point on any road; with `second`, also the nearest point on a different stretch (other road or >120 m away along it)
  query(x, z, second) {
    const a = this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!a) return null;
    let best = null, bd = Infinity;
    const res = [];
    for (let q = 0; q < a.length; q++) {
      const ri = Math.floor(a[q] / 1048576), i = a[q] - ri * 1048576, r = this.roads[ri], j = r.idx(i + 1);
      const ex = r.x[j] - r.x[i], ez = r.z[j] - r.z[i], L2 = ex * ex + ez * ez || 1;
      const t = clamp(((x - r.x[i]) * ex + (z - r.z[i]) * ez) / L2, 0, 1);
      const px = r.x[i] + ex * t, pz = r.z[i] + ez * t, d = Math.hypot(x - px, z - pz);
      if (second) res.push([d, ri, i, t]);
      if (d < bd) { bd = d; best = [d, ri, i, t]; }
    }
    const mk = (b) => {
      const [d, ri, i, t] = b, r = this.roads[ri], j = r.idx(i + 1);
      const ex = r.x[j] - r.x[i], ez = r.z[j] - r.z[i], L = Math.hypot(ex, ez) || 1;
      const lat = (x - r.x[i]) * (-ez / L) + (z - r.z[i]) * (ex / L); // + = right of travel direction
      const s = r.s[i] + t * L;
      let y = r.y[i] + (r.y[j] - r.y[i]) * t;
      if (r.bump) y += r.bump(s);
      return { d, road: r, i, t, lat, s, y, tx: ex / L, tz: ez / L };
    };
    const A = mk(best);
    if (!second) return { a: A };
    let b2 = null, d2 = Infinity;
    for (const c of res) {
      if (c[0] >= d2) continue;
      const r = this.roads[c[1]];
      if (c[1] === best[1]) { let ds = Math.abs(r.s[c[2]] - r.s[best[2]]); if (r.closed) ds = Math.min(ds, r.len - ds); if (ds < 120) continue; }
      d2 = c[0]; b2 = c;
    }
    return { a: A, b: b2 ? mk(b2) : null };
  }
}

/* colliders: segments (walls, rails), circles (rocks, poles, parked cars), boxes (buildings); optional y range */
class ColHash {
  constructor(cell) { this.cell = cell; this.map = new Map(); this.items = []; this.stamp = 0; }
  key(ix, iz) { return (ix + 40000) * 80000 + (iz + 40000); }
  insert(it, x0, z0, x1, z1) {
    it.id = this.items.push(it) - 1; it.st = 0; const c = this.cell;
    for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) for (let iz = Math.floor(z0 / c); iz <= Math.floor(z1 / c); iz++) {
      const k = this.key(ix, iz); let a = this.map.get(k); if (!a) this.map.set(k, a = []); a.push(it);
    }
  }
  seg(ax, az, bx, bz, o = {}) { this.insert({ t: 0, ax, az, bx, bz, y0: o.y0 ?? -1e9, y1: o.y1 ?? 1e9, kind: o.kind || 'wall' }, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)); }
  circ(x, z, r, o = {}) { this.insert({ t: 1, x, z, r, y0: o.y0 ?? -1e9, y1: o.y1 ?? 1e9, kind: o.kind || 'rock' }, x - r, z - r, x + r, z + r); }
  box(x0, z0, x1, z1, o = {}) { this.insert({ t: 2, x0, z0, x1, z1, y0: o.y0 ?? -1e9, y1: o.y1 ?? 1e9, kind: o.kind || 'building' }, x0, z0, x1, z1); }
  query(x, z, r) {
    const out = [], c = this.cell, st = ++this.stamp;
    for (let ix = Math.floor((x - r) / c); ix <= Math.floor((x + r) / c); ix++) for (let iz = Math.floor((z - r) / c); iz <= Math.floor((z + r) / c); iz++) {
      const a = this.map.get(this.key(ix, iz)); if (!a) continue;
      for (const it of a) if (it.st !== st) { it.st = st; out.push(it); }
    }
    return out;
  }
}

/* ---------- shared world object ---------- */
function newWorld(map, opts) {
  const W = {
    map, opts, roads: [], hash: new RoadHash(40), cols: new ColHash(16), checkpoints: [], spawns: [], grid: [],
    lanes: [], decks: [], pools: [], trees: [], rocks: [], group: new THREE.Group(), tiles: null,
    blendCut: 14, blendFill: 30, offSurface: () => 'grass', base: () => 0, flat: false, ocean: false,
    seaLevel: -1e9, bounds: null, minimapLines: [], kmPosts: [], speedCapAt: null, darkAt: null, update: null,
    mainRoad: null, loop: map.mode === 'loop', weather: opts.weather, wet: opts.weather.wet || 0, snow: opts.weather.snow || 0,
    noise: makeNoise(map.gen.seed || 1), rand: rng((map.gen.seed || 1) * 7919),
  };
  W.addRoad = (r, margin) => { W.roads.push(r); W.hash.add(r, margin ?? (r.width / 2 + r.shoulder + Math.max(W.blendCut, W.blendFill) + 4)); return r; };
  W.nearest = (x, z) => { const q = W.hash.query(x, z, false); return q ? q.a : null; };
  W.heightAt = (x, z) => {
    let base = W.base(x, z);
    if (W.flat) return base;
    const q = W.hash.query(x, z, true);
    if (!q) return base;
    if (W.sideTilt) base += W.sideTilt(q.a);
    const a = q.a, ra = a.road, flatA = ra.width / 2 + ra.shoulder, dA = Math.max(0, a.d - flatA);
    if (dA <= 0) return a.y;
    let hr = a.y;
    if (q.b) {
      const rb = q.b.road, dB = Math.max(0, q.b.d - (rb.width / 2 + rb.shoulder));
      const wA = 1 / (dA * dA + 1), wB = 1 / (dB * dB + 1); hr = (a.y * wA + q.b.y * wB) / (wA + wB);
    }
    const BL = base > hr ? W.blendCut : W.blendFill;
    return hr + (base - hr) * smooth(0, BL, dA);
  };
  // physics ground query: height, surface, water depth, nearest road info
  W.ground = (x, z, y = 1e9) => {
    let h, surf, road = null, water = 0, onRoad = false;
    const q = W.flat && !W.useHashWhenFlat ? null : W.nearest(x, z);
    if (q && q.d < q.road.width / 2) { h = q.y; surf = W.roadSurface ? W.roadSurface(q) : q.road.surface; road = q; onRoad = true; }
    else if (q && q.d < q.road.width / 2 + q.road.shoulder) { h = q.y; surf = W.shoulderSurface ? W.shoulderSurface(q) : q.road.shoulderSurface; road = q; }
    else { h = W.heightAt(x, z); surf = W.offSurface(x, z, h, q); road = q; }
    if (W.cityGround) { const g = W.cityGround(x, z); h = g.h; surf = g.surf; onRoad = g.onRoad; road = g.road; }
    for (const d of W.decks) { // garage decks and ramps (multi-level surfaces)
      if (x < d.x0 || x > d.x1 || z < d.z0 || z > d.z1) continue;
      const dy = d.axis === 'x' ? lerp(d.ya, d.yb, (x - d.x0) / (d.x1 - d.x0)) : d.axis === 'z' ? lerp(d.ya, d.yb, (z - d.z0) / (d.z1 - d.z0)) : d.ya;
      if (dy <= y + 0.8 && dy > h) { h = dy; surf = 'concrete'; onRoad = true; }
    }
    for (const p of W.pools) if ((x - p.x) ** 2 + (z - p.z) ** 2 < p.r * p.r && h < p.level) { water = p.level - h; surf = 'water'; }
    return { h, surf, water, road, onRoad };
  };
  return W;
}

/* ---------- terrain tiles (lazy, built around the camera) ---------- */
function makeTiles(W, o) {
  const size = o.size || 256, res = o.res || 32, step = size / res;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: o.detail || null });
  const tiles = new Map(), queue = [];
  const T = { size, mat, tiles, allowed: o.allowed || null, radius: o.radius || 1500, drop: (o.radius || 1500) + 600 };
  T.build = (tx, tz) => {
    const n = res + 1, pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2);
    const H = new Float32Array(n * n), Q = new Array(n * n);
    const c = new THREE.Color();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = tx * size + i * step, z = tz * size + j * step, k = j * n + i;
      let h = W.heightAt(x, z);
      const q = W.flat ? null : W.nearest(x, z);
      if (q && q.d < q.road.width / 2 + q.road.shoulder + 0.6) h = Math.min(h, q.y) - 0.45; // keep terrain under the road mesh
      H[k] = h; Q[k] = q;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      uv[k * 2] = x / 12; uv[k * 2 + 1] = z / 12;
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const dx = (H[j * n + Math.min(n - 1, i + 1)] - H[j * n + Math.max(0, i - 1)]) / (step * (i > 0 && i < n - 1 ? 2 : 1));
      const dz = (H[Math.min(n - 1, j + 1) * n + i] - H[Math.max(0, j - 1) * n + i]) / (step * (j > 0 && j < n - 1 ? 2 : 1));
      W.colorAt(pos[k * 3], pos[k * 3 + 2], H[k], Q[k], c, Math.hypot(dx, dz));
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
    const idx = []; for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) { const a = j * n + i; idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat); W.group.add(m); return m;
  };
  T.update =(cx, cz, budgetMs = 6) => {
    const r = Math.ceil(T.radius / size), ix = Math.floor(cx / size), iz = Math.floor(cz / size);
    queue.length = 0;
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      const tx = ix + a, tz = iz + b, key = tx + ',' + tz;
      if (tiles.has(key)) continue;
      if (T.allowed && !T.allowed.has(key)) continue;
      const dx = (tx + 0.5) * size - cx, dz = (tz + 0.5) * size - cz, d = Math.hypot(dx, dz);
      if (d < T.radius) queue.push([d, tx, tz, key]);
    }
    queue.sort((p, q) => p[0] - q[0]);
    const t0 = performance.now();
    for (const [, tx, tz, key] of queue) { tiles.set(key, T.build(tx, tz)); if (performance.now() - t0 > budgetMs) break; }
    for (const [key, m] of tiles) {
      const [tx, tz] = key.split(',').map(Number), d = Math.hypot((tx + 0.5) * size - cx, (tz + 0.5) * size - cz);
      if (d > T.drop) { W.group.remove(m); m.geometry.dispose(); tiles.delete(key); }
    }
    return queue.length;
  };
  T.allowNear = (roads, dist) => {
    T.allowed = new Set();
    for (const r of roads) for (let i = 0; i < r.n; i += 10) {
      const a = Math.floor((r.x[i] - dist) / size), b = Math.floor((r.x[i] + dist) / size), c = Math.floor((r.z[i] - dist) / size), d = Math.floor((r.z[i] + dist) / size);
      for (let x = a; x <= b; x++) for (let z = c; z <= d; z++) T.allowed.add(x + ',' + z);
    }
  };
  return T;
}

root.R29WorldUtil = { clamp, lerp, smooth, rng, makeNoise, sampleSpline, makeRoad, smoothProfile, RoadHash, ColHash, newWorld, makeTiles };
})(typeof self !== 'undefined' ? self : this);
