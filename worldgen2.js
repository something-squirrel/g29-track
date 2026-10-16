/* R29-Track generators part 2: circuit, original test track, desert, city; and the build() entry point. */
(function (root) {
'use strict';
const U = root.R29WorldUtil, Gn = root.R29Gen;
const { clamp, lerp, smooth, rng, sampleSpline, makeRoad, smoothProfile, makeTiles, newWorld } = U;
const { tex, quadsMesh, roadMesh, markings, shoulders, rails, instanced, pines, boulders, routeCheckpoints, spawnOn, twoWayLanes,
  minimapFrom, startGantry, stdMats, snowMix, rv, at, C } = Gn;

let GLOW = null;
function glowMat(color, size) {
  if (!GLOW) { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); GLOW = new THREE.CanvasTexture(c); }
  return new THREE.PointsMaterial({ color, size, map: GLOW, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
}
function cornerSides(r, thresh = 1 / 160, reach = 30) {
  const out = new Int8Array(r.n);
  for (let i = 0; i < r.n; i++) { let best = 0, bk = 0; for (let k = -reach; k <= reach; k += 3) { const kk = r.k[r.idx(i + k)]; if (Math.abs(kk) > best) { best = Math.abs(kk); bk = kk; } } if (best > thresh) out[i] = -Math.sign(bk); }
  return out;
}
function tireWalls(W, r, dist, extraClear) {
  const list = [], hw = r.width / 2, side = cornerSides(r, 1 / 70, 12), pts = [];
  for (let i = 0; i < r.n; i++) {
    if (!side[i]) { pts.push(null); continue; }
    const p = at(r, i, side[i] * dist);
    const q = W.nearest(p[0], p[2]); let ok = true;
    if (q && q.road === r) { let ds = Math.abs(q.s - r.s[i]); ds = Math.min(ds, r.len - ds); if (ds > 40 && q.d < hw + extraClear) ok = false; }
    else if (q && q.d < q.road.width / 2 + extraClear) ok = false;
    pts.push(ok ? p : null);
  }
  for (let i = 0; i < r.n; i++) {
    const p = pts[i]; if (!p) continue;
    list.push([p[0], p[1], p[2], 1]);
    const j = r.idx(i + 2), q = pts[j];
    if (q && i % 2 === 0 && Math.hypot(q[0] - p[0], q[2] - p[2]) < 8) W.cols.seg(p[0], p[2], q[0], q[2], { kind: 'tire' });
  }
  const geo = new THREE.CylinderGeometry(0.38, 0.38, 0.9, 10); geo.translate(0, 0.45, 0);
  const blue = new THREE.Color(0x1f5fd1), white = new THREE.Color(0xe8eef5);
  instanced(W, geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), list, (t, k) => Math.floor(k / 4) % 3 === 0 ? white : blue);
}
function vertWall(W, r, i0, i1, off, h, color) {
  W.group.add(quadsMesh(q => { for (let i = i0; i < i1; i++) { const a = r.idx(i), b = r.idx(i + 1); q(at(r, a, off, 0), at(r, a, off, h), at(r, b, off, 0), at(r, b, off, h), color); } }, { polygonOffset: false }));
  for (let i = i0; i < i1; i += 4) { const a = at(r, r.idx(i), off), b = at(r, r.idx(Math.min(i1, i + 4)), off); W.cols.seg(a[0], a[2], b[0], b[2], { kind: 'wall' }); }
}
function boxMesh(W, x0, z0, x1, z1, y0, y1, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); W.group.add(m); return m;
}

/* =================== Redline International Circuit =================== */
function genCircuit(W, map) {
  const g = map.gen, N = W.noise;
  const L0 = sampleSpline(g.ctrl, true, 2).length * 2, sc = g.length / L0;
  const pts = sampleSpline(g.ctrl.map(p => [p[0] * sc, p[1] * sc]), true, 2);
  W.blendCut = 40; W.blendFill = 45;
  const r = W.mainRoad = W.addRoad(makeRoad('main', pts, { closed: true, width: g.width, shoulder: 1.3, laneW: g.width / 2, markings: 'circuit', shoulderSurface: 'curb' }), g.width / 2 + 1.3 + 46);
  const E = g.elevation, ev = f => { for (let k = 1; k < E.length; k++) if (f <= E[k][0]) { const t = (f - E[k - 1][0]) / (E[k][0] - E[k - 1][0]); return lerp(E[k - 1][1], E[k][1], (1 - Math.cos(Math.PI * t)) / 2); } return E[E.length - 1][1]; };
  for (let i = 0; i < r.n; i++) r.y[i] = ev(r.s[i] / r.len);
  smoothProfile(r, 10, 0.06);
  W.base = (x, z) => 100 + 6 * N.fbm(x / 600, z / 600, 3) + 1.5 * N.fbm(x / 90, z / 90, 2);
  r.out = cornerSides(r);
  // pit lane: parallel road on the infield side of the main straight
  const sEntry = r.len - 430, sExit = 360, pitPts = [], pitY = [];
  for (let s = sEntry; s <= r.len + sExit; s += 2) {
    const i = Math.round((s % r.len) / (r.len / r.n)) % r.n, off = g.pitOffset * smooth(sEntry, sEntry + 170, s) * (1 - smooth(r.len + sExit - 170, r.len + sExit, s));
    const [rx, rz] = rv(r, i); pitPts.push([r.x[i] + rx * off, r.z[i] + rz * off]); pitY.push(r.y[i]);
  }
  const pit = W.addRoad(makeRoad('pit', pitPts, { width: 9, shoulder: 0.5, laneW: 4.5, kind: 'pit', markings: 'pit', shoulderSurface: 'concrete' }), 9 / 2 + 0.5 + 20);
  for (let i = 0; i < pit.n; i++) pit.y[i] = pitY[i];
  W.pit = pit;
  W.speedCapAt = (q) => q && q.road === pit && q.s > 170 && q.s < pit.len - 170 ? g.pitLimitMs : 0;
  W.offSurface = (x, z, h, q) => {
    if (q && q.road === r) { const edge = r.width / 2 + r.shoulder, o = r.out[q.i]; if (o && Math.sign(q.lat) === o && q.d < edge + 28) return 'gravel'; }
    return 'grass';
  };
  W.shoulderSurface = q => q.road === r && Math.abs(r.k[q.i]) > 1 / 140 ? 'curb' : (q.road === pit ? 'concrete' : 'grass');
  W.colorAt = (x, z, h, q, c, slope) => {
    const t = 0.5 + 0.5 * N.n2(x / 40, z / 40);
    c.setRGB(0.3 + 0.05 * t, 0.5 + 0.06 * t, 0.24);
    if (q && q.road === r) { const edge = r.width / 2 + r.shoulder, o = r.out[q.i]; if (o && Math.sign(q.lat) === o && q.d < edge + 28 && q.d > edge - 0.5) c.setRGB(0.72, 0.66, 0.55); }
    snowMix(W, c, slope);
  };
  stdMats(W);
  W.tiles = makeTiles(W, { detail: tex.detail(), radius: 1500 });
  W.tiles.allowNear([r], 900);
  roadMesh(W, r); markings(W, r, 'circuit');
  roadMesh(W, pit, { y: 0.035 }); markings(W, pit, 'pit');
  shoulders(W, pit, C(0.62, 0.62, 0.6));
  // pit wall between pit lane and track, garages beyond the pit lane, grandstands opposite
  const ie = Math.round((sEntry + 190) / (r.len / r.n)), ix = Math.round((sExit - 190) / (r.len / r.n)) + r.n;
  vertWall(W, r, ie, ix, r.width / 2 + 3, 1.1, C(0.82, 0.82, 0.8));
  const gar = new THREE.MeshLambertMaterial({ color: 0xd9dcdf }), dark = new THREE.MeshLambertMaterial({ color: 0x30363c });
  for (let s = 200; s < pit.len - 200; s += 15) {
    const i = Math.round(s / (pit.len / pit.n)), [rx, rz] = rv(pit, i), o = pit.width / 2 + 4, cx = pit.x[i] + rx * (o + 6), cz = pit.z[i] + rz * (o + 6);
    boxMesh(W, cx - 6.5, cz - 6, cx + 6.5, cz + 6, pit.y[i], pit.y[i] + 6, gar);
    boxMesh(W, cx - 5.5, cz - 6.05, cx + 5.5, cz - 5.9, pit.y[i], pit.y[i] + 4.2, dark);
    W.cols.box(cx - 6.5, cz - 6, cx + 6.5, cz + 6, { kind: 'building' });
  }
  for (let s = 60; s < 520; s += 30) {
    const i = Math.round(s / (r.len / r.n)), [rx, rz] = rv(r, i), cx = r.x[i] - rx * (r.width / 2 + 24), cz = r.z[i] - rz * (r.width / 2 + 24);
    for (let t = 0; t < 4; t++) boxMesh(W, cx - 14, cz - 4 - t * 3, cx + 14, cz - 1 - t * 3, r.y[i], r.y[i] + 1.5 + t * 2, new THREE.MeshLambertMaterial({ color: t % 2 ? 0xc33a2e : 0x9aa2aa }));
    W.cols.box(cx - 14, cz - 16, cx + 14, cz - 1, { kind: 'building' });
  }
  tireWalls(W, r, r.width / 2 + r.shoulder + 30, 14);
  const trees = [], rnd = W.rand;
  for (let i = 0; i < r.n; i += 5) { const [rx, rz] = rv(r, i); const off = (rnd() < 0.5 ? -1 : 1) * (120 + rnd() * 400), x = r.x[i] + rx * off, z = r.z[i] + rz * off, q = W.nearest(x, z); if (q && q.d < 70) continue; trees.push([x, W.heightAt(x, z) - 0.3, z, 0.7 + rnd() * 0.7]); }
  pines(W, trees);
  routeCheckpoints(W, r, map.checkpoints.every_km * 1000, true, map.checkpoints.laps);
  W.checkpoints[0].hw = r.width / 2 + g.pitOffset + 9; // the line counts in the pit lane too
  W.grid = Array.from({ length: 12 }, (_, k) => spawnOn(r, r.len - 14 - k * 8, (k % 2 ? -1 : 1) * 3.2, 'Grid ' + (k + 1)));
  W.spawns = [Object.assign({}, W.grid[0], { label: 'Grid' }), spawnOn(pit, 230, 0, 'Pit lane')];
  startGantry(W, r, 0, 'REDLINE');
  W.outOfBounds = (x, z, q) => !q || q.d > 700;
}

/* =================== Original G29 test track =================== */
function genTestTrack(W, map) {
  const g = map.gen, N = W.noise;
  const pts = sampleSpline(g.ctrl.map(p => [(p[0] - g.cx) * g.scale, (p[1] - g.cz) * g.scale]), true, 2);
  W.flat = true; W.useHashWhenFlat = true; W.base = () => 0;
  const r = W.mainRoad = W.addRoad(makeRoad('main', pts, { closed: true, width: 13, shoulder: 1.2, markings: 'circuit', shoulderSurface: 'curb' }), 6.5 + 1.2 + 12);
  W.offSurface = () => 'grass';
  W.shoulderSurface = q => Math.abs(r.k[q.i]) > 1 / 45 ? 'curb' : 'grass';
  stdMats(W);
  const gTex = Gn.speckle('grass', '#4f7f33', ['#46732c', '#5e8f40', '#4a7930'], 900, 3); gTex.repeat.set(400, 400);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000, 100, 100), new THREE.MeshLambertMaterial({ map: gTex }));
  ground.rotation.x = -Math.PI / 2; W.group.add(ground);
  roadMesh(W, r); markings(W, r, 'circuit');
  // original tire walls on the outside of corners, kept clear of neighbouring sections
  const WALL = 6.5 + 4, list = [];
  const raw = new Int8Array(r.n); for (let i = 0; i < r.n; i++) if (Math.abs(r.k[i]) > 1 / 70) raw[i] = -Math.sign(r.k[i]);
  const dil = new Int8Array(r.n); for (let i = 0; i < r.n; i++) if (raw[i]) for (let k = -10; k <= 14; k++) { const j = r.idx(i + k); if (!dil[j]) dil[j] = raw[i]; }
  const sep = Math.ceil(40 / (r.len / r.n)), wp = [];
  for (let i = 0; i < r.n; i++) {
    let ok = !!dil[i];
    if (ok) { const w = at(r, i, dil[i] * WALL); for (let j = 0; j < r.n && ok; j += 2) { const dd = Math.min(Math.abs(i - j), r.n - Math.abs(i - j)); if (dd < sep) continue; if (Math.hypot(r.x[j] - w[0], r.z[j] - w[2]) < 6.5 + 7) ok = false; } }
    wp.push(ok ? at(r, i, dil[i] * WALL) : null);
  }
  for (let i = 0; i < r.n; i++) if (wp[i]) { list.push([wp[i][0], 0, wp[i][2], 1]); const q = wp[r.idx(i + 2)]; if (q && i % 2 === 0 && Math.hypot(q[0] - wp[i][0], q[2] - wp[i][2]) < 8) W.cols.seg(wp[i][0], wp[i][2], q[0], q[2], { kind: 'tire' }); }
  const geo = new THREE.CylinderGeometry(0.38, 0.38, 0.9, 10); geo.translate(0, 0.45, 0);
  const blue = new THREE.Color(0x1f5fd1), white = new THREE.Color(0xe8eef5);
  instanced(W, geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), list, (t, k) => Math.floor(k / 4) % 3 === 0 ? white : blue);
  // billboard beside the start straight
  const BB_I = 110, bp = at(r, BB_I, -(6.5 + 10)), back = r.idx(BB_I - 90);
  const c = document.createElement('canvas'); c.width = 1024; c.height = 320; const t = new THREE.CanvasTexture(c);
  const draw = () => { const g2 = c.getContext('2d'); g2.fillStyle = '#10161b'; g2.fillRect(0, 0, 1024, 320); g2.fillStyle = '#ffb21f'; g2.fillRect(0, 0, 1024, 14); g2.fillRect(0, 306, 1024, 14);
    g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.fillStyle = '#fff'; g2.font = '600 64px "Chakra Petch", Arial, sans-serif'; g2.fillText('Good luck on your driving test', 512, 105);
    g2.fillStyle = '#ffb21f'; g2.font = '700 130px "Chakra Petch", Impact, sans-serif'; g2.fillText('VIKAS', 512, 225); t.needsUpdate = true; };
  draw(); if (document.fonts && document.fonts.load) Promise.all([document.fonts.load('600 64px "Chakra Petch"'), document.fonts.load('700 130px "Chakra Petch"')]).then(draw, () => {});
  const board = new THREE.Group(), dark = new THREE.MeshLambertMaterial({ color: 0x2b3238 });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(20, 6.25), new THREE.MeshBasicMaterial({ map: t })); face.position.set(0, 6.6, 0.21); board.add(face);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(20.6, 6.85, 0.4), dark); frame.position.y = 6.6; board.add(frame);
  for (const sx of [-20 / 3, 20 / 3]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.6, 0.5), dark); leg.position.set(sx, 1.8, 0); board.add(leg); }
  board.position.set(bp[0], 0, bp[2]); board.rotation.y = Math.atan2(r.x[back] - bp[0], r.z[back] - bp[2]); W.group.add(board);
  // forest outside the circuit, infield open
  const inside = (x, z) => { let cc = false; for (let i = 0, j = r.n - 1; i < r.n; j = i++) { if ((r.z[i] > z) !== (r.z[j] > z) && x < (r.x[j] - r.x[i]) * (z - r.z[i]) / (r.z[j] - r.z[i]) + r.x[i]) cc = !cc; } return cc; };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity; for (let i = 0; i < r.n; i++) { minX = Math.min(minX, r.x[i]); maxX = Math.max(maxX, r.x[i]); minZ = Math.min(minZ, r.z[i]); maxZ = Math.max(maxZ, r.z[i]); }
  const trees = [], rnd = W.rand; let tries = 0;
  while (trees.length < 900 && tries++ < 20000) {
    const x = minX - 220 + rnd() * (maxX - minX + 440), z = minZ - 220 + rnd() * (maxZ - minZ + 440);
    if (inside(x, z)) continue; const q = W.nearest(x, z); if (q && q.d < 20) continue;
    let near = Infinity; for (let i = 0; i < r.n; i += 6) near = Math.min(near, (r.x[i] - x) ** 2 + (r.z[i] - z) ** 2); if (near < 400) continue;
    if (Math.hypot(x - bp[0], z - bp[2]) < 35) continue;
    trees.push([x, 0, z, 0.7 + rnd() * 0.9, rnd() * 6]);
  }
  pines(W, trees);
  routeCheckpoints(W, r, map.checkpoints.every_km * 1000, true, map.checkpoints.laps);
  W.grid = Array.from({ length: 12 }, (_, k) => spawnOn(r, r.len - 50 - k * 8, (k % 2 ? -1 : 1) * 3, 'Grid ' + (k + 1)));
  W.spawns = [Object.assign({}, W.grid[0], { label: 'Start line' })];
  startGantry(W, r, 0, 'START');
  W.outOfBounds = (x, z, q) => Math.hypot(x, z) > 1500;
}

/* =================== Redstone Desert =================== */
function genDesert(W, map) {
  const g = map.gen, N = W.noise, half = g.half;
  const washX = z => -300 + 650 * Math.sin(z / 1700) + 180 * Math.sin(z / 600 + 1);
  const washD = (x, z) => { const d = 650 / 1700 * Math.cos(z / 1700) + 180 / 600 * Math.cos(z / 600 + 1); return Math.abs(x - washX(z)) / Math.sqrt(1 + d * d); };
  const duneM = (x, z) => smooth(0.05, 0.35, N.fbm(x / 3200 + 5, z / 3200 - 3, 2));
  const mesaN = (x, z) => N.fbm(x / 1400 + 11, z / 1400 + 7, 3);
  W.base = (x, z) => {
    let h = 640 + 55 * N.fbm(x / 2400, z / 2400, 3) + 10 * N.fbm(x / 380, z / 380, 3);
    const dm = duneM(x, z); if (dm > 0) { const rr = 0.5 + 0.5 * Math.sin((x * 0.8 + z * 0.6) / 70 + 2.5 * N.fbm(x / 500, z / 500, 2)); h += dm * 17 * rr * rr; }
    h += smooth(0.3, 0.36, mesaN(x, z)) * (75 + 25 * N.fbm(x / 700, z / 700, 2));
    h -= 7 * smooth(48, 12, washD(x, z));
    h += 520 * smooth(half - 900, half, Math.max(Math.abs(x), Math.abs(z)));
    return h;
  };
  W.blendCut = 12; W.blendFill = 16;
  const pts = sampleSpline(g.trail, true, 3);
  const r = W.mainRoad = W.addRoad(makeRoad('trail', pts, { closed: true, width: 7, shoulder: 1, surface: 'dirt', shoulderSurface: 'gravel', markings: 'none', kind: 'trail' }), 3.5 + 1 + 20);
  for (let i = 0; i < r.n; i++) r.y[i] = W.base(r.x[i], r.z[i]);
  smoothProfile(r, 7, 0.32);
  r.bump = s => 0.045 * Math.sin(s * 7.0) + 0.08 * N.n2(s / 3.1, 3.3); // washboard and ruts (felt through the suspension)
  let lastPool = -1e9;
  for (let i = 0; i < r.n; i += 2) if (washD(r.x[i], r.z[i]) < 10 && r.s[i] - lastPool > 200) { W.pools.push({ x: r.x[i], z: r.z[i], r: 26, level: r.y[i] + 0.45 }); lastPool = r.s[i]; }
  W.offSurface = (x, z, h) => { if (washD(x, z) < 30) return 'sand'; if (duneM(x, z) > 0.45) return 'sand'; if (mesaN(x, z) > 0.3) return 'rock'; return N.n2(x / 150, z / 150) > 0.25 ? 'dirt' : 'gravel'; };
  W.colorAt = (x, z, h, q, c, slope) => {
    const t = 0.5 + 0.5 * N.n2(x / 60, z / 60), wd = washD(x, z);
    if (slope > 0.6 || mesaN(x, z) > 0.31) c.setRGB(0.6 + 0.06 * t, 0.34 + 0.04 * t, 0.24);
    else if (wd < 34) c.setRGB(0.86, 0.76, 0.6);
    else if (duneM(x, z) > 0.4) c.setRGB(0.88 + 0.04 * t, 0.7 + 0.04 * t, 0.5);
    else c.setRGB(0.68 + 0.06 * t, 0.53 + 0.05 * t, 0.4);
    if (q && q.d < q.road.width / 2 + q.road.shoulder + 1) c.setRGB(0.6, 0.47, 0.34);
  };
  stdMats(W);
  W.tiles = makeTiles(W, { detail: tex.detail(), radius: 1500 });
  roadMesh(W, r, { mat: W.mats.dirt, extra: 0.6, y: 0.06 });
  for (const p of W.pools) { const m = new THREE.Mesh(new THREE.CircleGeometry(p.r, 32), new THREE.MeshPhongMaterial({ color: 0x4b6f78, transparent: true, opacity: 0.78, shininess: 80 })); m.rotation.x = -Math.PI / 2; m.position.set(p.x, p.level, p.z); W.group.add(m); }
  const rnd = W.rand, rocks = [], cacti = [], shrubs = [];
  for (let x = -half + 300; x < half - 300; x += 46) for (let z = -half + 300; z < half - 300; z += 46) {
    const px = x + (rnd() - 0.5) * 40, pz = z + (rnd() - 0.5) * 40;
    const rocky = mesaN(px, pz) > 0.27 ? 0.55 : 0.1, q = W.nearest(px, pz);
    if (q && q.d < 9) continue;
    if (rnd() < rocky) { const h = W.base(px, pz); rocks.push([px, h - 0.3, pz, 0.5 + rnd() * 1.6, rnd() * 6, 1 + rnd() * 0.6]); }
    else if (rnd() < 0.12 && duneM(px, pz) < 0.3) cacti.push([px, W.base(px, pz), pz, 0.8 + rnd() * 0.6, rnd() * 6]);
    else if (rnd() < 0.3) shrubs.push([px, W.base(px, pz) - 0.1, pz, 0.6 + rnd() * 0.8, rnd() * 6, 1.3]);
  }
  boulders(W, rocks, 0x9b5a40);
  const cg = new THREE.CylinderGeometry(0.28, 0.32, 3.4, 7); cg.translate(0, 1.7, 0);
  instanced(W, cg, new THREE.MeshLambertMaterial({ color: 0x5f7a45 }), cacti);
  for (const t of cacti) W.cols.circ(t[0], t[2], 0.35, { kind: 'pole' });
  const sg = new THREE.DodecahedronGeometry(0.8, 0); sg.scale(1, 0.55, 1);
  instanced(W, sg, new THREE.MeshLambertMaterial({ color: 0x7d7a52, flatShading: true }), shrubs);
  const B = half - 450; for (const [ax, az, bx, bz] of [[-B, -B, B, -B], [B, -B, B, B], [B, B, -B, B], [-B, B, -B, -B]]) W.cols.seg(ax, az, bx, bz, { kind: 'wall' });
  routeCheckpoints(W, r, map.checkpoints.every_km * 1000, true, map.checkpoints.laps);
  W.spawns = map.spawn_points.map(sp => spawnOn(r, sp.km * 1000, 0, sp.label));
  W.grid = Array.from({ length: 12 }, (_, k) => spawnOn(r, r.len - 14 - k * 9, (k % 2 ? -1 : 1) * 1.8, 'Grid ' + (k + 1)));
  startGantry(W, r, 0, 'REDSTONE');
  W.outOfBounds = () => false;
}

/* =================== Meridian City =================== */
function genCity(W, map) {
  const g = map.gen, half = g.half, B = g.block, K = Math.round(half / B), rnd = W.rand;
  const isAve = k => ((k % g.avenueEvery) + g.avenueEvery) % g.avenueEvery === 0;
  const hwOf = k => isAve(k) ? 7.5 : 6;
  const PL = { x0: -200, x1: 200, z0: -1400, z1: -600 };
  const removedEW = (kz, x) => kz * B > PL.z0 && kz * B < PL.z1 && x > PL.x0 + 6 && x < PL.x1 - 6;
  W.flat = true; W.base = () => 0; W.city = { B, K, hwOf, isAve, PL, half };
  const parks = new Set(), garageBlocks = [[1, 1], [-3, 2]];
  for (let bx = -K; bx < K; bx++) for (let bz = -K; bz < K; bz++) if (rnd() < 0.07) parks.add(bx + ',' + bz);
  for (const [a, b] of garageBlocks) parks.delete(a + ',' + b);
  const plazaBlock = (bx, bz) => bx >= -1 && bx <= 0 && bz >= -7 && bz <= -4;
  W.cityGround = (x, z) => {
    const kx = Math.round(x / B), kz = Math.round(z / B), dx = Math.abs(x - kx * B), dz = Math.abs(z - kz * B);
    const onNS = Math.abs(kx) <= K && dx < hwOf(kx) && Math.abs(z) <= half + 6;
    const onEW = Math.abs(kz) <= K && dz < hwOf(kz) && Math.abs(x) <= half + 6 && !removedEW(kz, x);
    const onRoad = onNS || onEW;
    let surf = onRoad ? 'asphalt' : 'concrete';
    if (!onRoad && parks.has(Math.floor(x / B) + ',' + Math.floor(z / B))) surf = 'grass';
    return { h: 0, surf, onRoad, road: onRoad ? { city: true, axis: onNS && (!onEW || dx < dz) ? 'z' : 'x', c: onNS && (!onEW || dx < dz) ? kx * B : kz * B } : null };
  };
  W.nearest = (x, z) => {
    const kx = clamp(Math.round(x / B), -K, K), kz = clamp(Math.round(z / B), -K, K), dx = Math.abs(x - kx * B), dz = Math.abs(z - kz * B);
    return dx < dz ? { d: dx, city: true, axis: 'z', c: kx * B, hw: hwOf(kx), y: 0 } : { d: dz, city: true, axis: 'x', c: kz * B, hw: hwOf(kz), y: 0 };
  };
  W.heightAt = () => 0;
  // line pieces (for drawing, minimap and traffic)
  const pieces = [];
  for (let k = -K; k <= K; k++) {
    pieces.push({ axis: 'z', c: k * B, a0: -half, a1: half, hw: hwOf(k), ave: isAve(k), k });
    if (k * B > PL.z0 && k * B < PL.z1) { pieces.push({ axis: 'x', c: k * B, a0: -half, a1: PL.x0 + 6, hw: hwOf(k), ave: isAve(k), k }, { axis: 'x', c: k * B, a0: PL.x1 - 6, a1: half, hw: hwOf(k), ave: isAve(k), k }); }
    else pieces.push({ axis: 'x', c: k * B, a0: -half, a1: half, hw: hwOf(k), ave: isAve(k), k });
  }
  W.cityPieces = pieces;
  W.minimapLines = pieces.map(p => ({ pts: new Float32Array(p.axis === 'z' ? [p.c, p.a0, p.c, p.a1] : [p.a0, p.c, p.a1, p.c]), w: p.hw * 2, kind: 'road' }));
  // textures for avenue / street cross-sections
  const roadTex = (ave) => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 128; const x = c.getContext('2d');
    const base = tex.asphalt().image; x.drawImage(base, 0, 0, 256, 128); x.drawImage(base, 0, 0, 128, 128, 128, 0, 128, 128);
    const W2 = ave ? 15 : 12, px = m => (m + W2 / 2) / W2 * 256;
    x.fillStyle = '#eee'; x.fillRect(px(-W2 / 2 + 0.2), 0, 3, 128); x.fillRect(px(W2 / 2 - 0.2) - 3, 0, 3, 128);
    if (ave) { x.fillStyle = '#e3b62e'; x.fillRect(px(-0.18) - 1, 0, 3, 128); x.fillRect(px(0.18) - 1, 0, 3, 128); x.fillStyle = '#eee'; for (const m of [-3.5, 3.5]) x.fillRect(px(m) - 1, 0, 3, 40); }
    else { x.fillStyle = '#e3b62e'; x.fillRect(px(0) - 1, 0, 3, 40); x.fillStyle = '#ddd'; for (const m of [-3.6, 3.6]) x.fillRect(px(m) - 1, 0, 2, 128); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t;
  };
  const wetish = W.wet > 0.4;
  const mk = (t) => wetish ? new THREE.MeshPhongMaterial({ map: t, color: 0x9aa0a4, shininess: 60, specular: 0x555a5e, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })
    : new THREE.MeshLambertMaterial({ map: t, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const aveMat = mk(roadTex(true)), strMat = mk(roadTex(false));
  for (const p of pieces) {
    const len = p.a1 - p.a0, geo = new THREE.PlaneGeometry(p.hw * 2, len);
    const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * len / 12);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, p.ave ? aveMat : strMat);
    if (p.axis === 'z') m.position.set(p.c, 0.01, (p.a0 + p.a1) / 2); else { m.rotation.y = Math.PI / 2; m.position.set((p.a0 + p.a1) / 2, 0.012, p.c); }
    W.group.add(m);
  }
  // intersections: plain asphalt patches + traffic lights
  const inter = [];
  for (let kx = -K; kx <= K; kx++) for (let kz = -K; kz <= K; kz++) if (!removedEW(kz, kx * B)) inter.push([kx, kz]);
  W.intersections = inter;
  const patchGeo = new THREE.PlaneGeometry(1, 1); patchGeo.rotateX(-Math.PI / 2);
  const patchMat = new THREE.MeshLambertMaterial({ map: tex.asphalt(), color: wetish ? 0x9aa0a4 : 0xffffff, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
  const pim = new THREE.InstancedMesh(patchGeo, patchMat, inter.length), o = new THREE.Object3D();
  inter.forEach(([kx, kz], i) => { o.position.set(kx * B, 0.016, kz * B); o.scale.set(hwOf(kx) * 2, 1, hwOf(kz) * 2); o.updateMatrix(); pim.setMatrixAt(i, o.matrix); });
  W.group.add(pim);
  const lightOff = (kx, kz) => (((kx * 7 + kz * 13) % 8) + 8) % 8 * 5;
  W.lightState = (kx, kz, axis, t) => { // 0 green, 1 yellow, 2 red
    const tt = ((t + lightOff(kx, kz)) % 40 + 40) % 40;
    if (axis === 'z') return tt < 17 ? 0 : tt < 20 ? 1 : 2;
    return tt < 21 ? 2 : tt < 37 ? 0 : 1;
  };
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.14, 5.4, 6); poleGeo.translate(0, 2.7, 0);
  const headGeo = new THREE.BoxGeometry(0.45, 1.2, 0.45); headGeo.translate(0, 5.0, 0);
  const heads = [], poles = [];
  for (const [kx, kz] of inter) {
    const x = kx * B, z = kz * B, ax = hwOf(kx) + 1.6, az = hwOf(kz) + 1.6;
    for (const [sx, sz, axis] of [[1, 1, 'z'], [-1, -1, 'z'], [-1, 1, 'x'], [1, -1, 'x']]) {
      poles.push([x + sx * ax, 0, z + sz * az]); heads.push({ x: x + sx * ax, z: z + sz * az, kx, kz, axis });
      W.cols.circ(x + sx * ax, z + sz * az, 0.25, { kind: 'pole' });
    }
  }
  instanced(W, poleGeo, new THREE.MeshLambertMaterial({ color: 0x3a3f44 }), poles.map(p => [p[0], 0, p[2], 1]));
  const him = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), heads.length);
  heads.forEach((h, i) => { o.position.set(h.x, 0, h.z); o.scale.set(1, 1, 1); o.rotation.set(0, 0, 0); o.updateMatrix(); him.setMatrixAt(i, o.matrix); him.setColorAt(i, new THREE.Color(0x30ff60)); });
  W.group.add(him);
  const LC = [new THREE.Color(0x2bff6a), new THREE.Color(0xffc21f), new THREE.Color(0xff3326)];
  let lightT = 0;
  W.updateLights = (t, cx, cz) => {
    if (t - lightT < 0.25) return; lightT = t;
    let any = false;
    heads.forEach((h, i) => { if (Math.abs(h.x - cx) > 900 || Math.abs(h.z - cz) > 900) return; him.setColorAt(i, LC[W.lightState(h.kx, h.kz, h.axis, t)]); any = true; });
    if (any) him.instanceColor.needsUpdate = true;
  };
  // ground, parks, buildings
  const gtex = tex.concrete().clone(); gtex.needsUpdate = true; gtex.repeat.set(700, 700);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(half * 2 + 400, half * 2 + 400), new THREE.MeshLambertMaterial({ map: gtex, color: 0xcfd0cc }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; W.group.add(ground);
  const parkGeo = new THREE.PlaneGeometry(1, 1); parkGeo.rotateX(-Math.PI / 2);
  const parkList = [], parkTrees = [], blds = [];
  const winTex = (lit) => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d');
    x.fillStyle = lit ? '#000' : '#8d969d'; x.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { const on = ((i * 7 + j * 3) % 5) > 1; x.fillStyle = lit ? (on ? '#ffd58a' : '#000') : '#3a4a58'; x.fillRect(i * 16 + 3, j * 16 + 4, 10, 9); }
    const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  };
  const wDay = winTex(false), wNight = winTex(true);
  for (let bx = -K; bx < K; bx++) for (let bz = -K; bz < K; bz++) {
    if (plazaBlock(bx, bz) || garageBlocks.some(([a, b]) => a === bx && b === bz)) continue;
    const x0 = bx * B + hwOf(bx) + 5, x1 = (bx + 1) * B - hwOf(bx + 1) - 5, z0 = bz * B + hwOf(bz) + 5, z1 = (bz + 1) * B - hwOf(bz + 1) - 5;
    if (parks.has(bx + ',' + bz)) {
      parkList.push([(x0 + x1) / 2, 0.02, (z0 + z1) / 2, x1 - x0, z1 - z0]);
      for (let k = 0; k < 14; k++) parkTrees.push([lerp(x0 + 6, x1 - 6, rnd()), 0, lerp(z0 + 6, z1 - 6, rnd()), 0.5 + rnd() * 0.5, rnd() * 6]);
      continue;
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, f = Math.exp(-(cx * cx + cz * cz) / (1700 * 1700));
    const lots = [];
    if (f > 0.45 && rnd() < 0.55) lots.push([x0 + 4, z0 + 4, x1 - 4, z1 - 4]);
    else { const nx = rnd() < 0.5 ? 1 : 2, nz = rnd() < 0.5 ? 1 : 2; for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) lots.push([lerp(x0, x1, i / nx) + 3, lerp(z0, z1, j / nz) + 3, lerp(x0, x1, (i + 1) / nx) - 3, lerp(z0, z1, (j + 1) / nz) - 3]); }
    for (const [a, b, c2, d] of lots) {
      const h = f > 0.45 && lots.length === 1 ? 70 + rnd() * 190 * f : 9 + rnd() * 22 + rnd() * 120 * f;
      blds.push([a, b, c2, d, h]); W.cols.box(a, b, c2, d, { kind: 'building', y0: -5, y1: h });
    }
  }
  const parkIM = instanced(W, parkGeo, new THREE.MeshLambertMaterial({ color: 0x4d7a37, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), parkList.map(p => [p[0], p[1], p[2], 1, 0, 1]));
  if (parkIM) { parkList.forEach((p, i) => { o.position.set(p[0], 0.02, p[2]); o.rotation.set(0, 0, 0); o.scale.set(p[3], 1, p[4]); o.updateMatrix(); parkIM.setMatrixAt(i, o.matrix); }); parkIM.instanceMatrix.needsUpdate = true; }
  pines(W, parkTrees, 0x356b31);
  const classes = [[0, 20], [20, 45], [45, 100], [100, 1e9]];
  W.windowMats = [];
  const palette = [0xa9adb1, 0x8f9aa3, 0xc2b8a8, 0x7d8a96, 0xb4a48e, 0x9fa9b0, 0x6e7c88];
  classes.forEach(([lo, hi], ci) => {
    const list = blds.filter(b => b[4] >= lo && b[4] < hi); if (!list.length) return;
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const avgH = list.reduce((s, b) => s + b[4], 0) / list.length, uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6, uv.getY(i) * avgH / 4);
    const d = wDay.clone(), n = wNight.clone(); d.needsUpdate = n.needsUpdate = true;
    const mat = new THREE.MeshLambertMaterial({ map: d, emissiveMap: n, emissive: 0xffffff, emissiveIntensity: 0 });
    W.windowMats.push(mat);
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((b, i) => { o.position.set((b[0] + b[2]) / 2, 0, (b[1] + b[3]) / 2); o.rotation.set(0, 0, 0); o.scale.set(b[2] - b[0], b[4], b[3] - b[1]); o.updateMatrix(); im.setMatrixAt(i, o.matrix); im.setColorAt(i, new THREE.Color(palette[(i * 7 + ci) % palette.length])); });
    im.instanceColor.needsUpdate = true; W.group.add(im);
  });
  // Civic Plaza with the avenue tunnel underneath
  const concrete = new THREE.MeshLambertMaterial({ color: 0x9a9c98 }), grassTop = new THREE.MeshLambertMaterial({ color: 0x4f7d3a });
  const pz0 = PL.z0 + 6, pz1 = PL.z1 - 6;
  for (const [a, b] of [[PL.x0 + 6, -9], [9, PL.x1 - 6]]) {
    const m = boxMesh(W, a, pz0, b, pz1, 0, 7.5, [concrete, concrete, grassTop, concrete, concrete, concrete]);
    W.cols.box(a, pz0, b, pz1, { kind: 'building' });
  }
  boxMesh(W, -9, pz0, 9, pz1, 6, 7.5, [concrete, concrete, grassTop, concrete, concrete, concrete]);
  for (const sx of [-8.3, 8.3]) W.cols.seg(sx, pz0, sx, pz1, { kind: 'wall' });
  const tl = []; for (let z = pz0 + 6; z < pz1; z += 12) tl.push(-5, 5.85, z, 5, 5.85, z);
  const tunnelLights = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(tl, 3)), glowMat(0xfff1c4, 2.2));
  W.group.add(tunnelLights);
  W.darkAt = (x, z, y) => Math.abs(x) < 8.5 && z > pz0 && z < pz1 && y < 6 ? smooth(0, 45, Math.min(z - pz0, pz1 - z)) : 0;
  // parking garages: three decks + roof, ramps, columns, parapets
  W.garages = [];
  const addGarage = (X0, Z0) => {
    const X1 = X0 + 140, Z1 = Z0 + 64, L = [0, 3.4, 6.8, 10.2];
    const RA = { x0: X0 + 30, x1: X0 + 70, z0: Z1 - 9, z1: Z1 - 1 }, RB = { x0: X1 - 50, x1: X1 - 10, z0: Z0 + 1, z1: Z0 + 9 };
    W.decks.push(Object.assign({ axis: 'x', ya: L[0], yb: L[1] }, RA), Object.assign({ axis: 'x', ya: L[2], yb: L[1] }, RB), Object.assign({ axis: 'x', ya: L[2], yb: L[3] }, RA));
    const holes = { 1: RA, 2: RB, 3: RA };
    const slab = new THREE.MeshLambertMaterial({ color: 0x8b8d8a });
    for (const lv of [1, 2, 3]) {
      const h = holes[lv], rects = [[X0, Z0, X1, h.z0], [X0, h.z1, X1, Z1], [X0, h.z0, h.x0, h.z1], [h.x1, h.z0, X1, h.z1]].filter(r => r[2] - r[0] > 0.5 && r[3] - r[1] > 0.5);
      for (const [a, b, c2, d] of rects) { W.decks.push({ x0: a, z0: b, x1: c2, z1: d, ya: L[lv], yb: L[lv] }); boxMesh(W, a, b, c2, d, L[lv] - 0.35, L[lv], slab); }
      const p = 1.1, y0 = L[lv] - 0.4, y1 = L[lv] + p;
      for (const [ax, az, bx, bz] of [[X0, Z0, X1, Z0], [X1, Z0, X1, Z1], [X1, Z1, X0, Z1], [X0, Z1, X0, Z0]]) { W.cols.seg(ax, az, bx, bz, { y0, y1, kind: 'wall' }); boxMesh(W, Math.min(ax, bx) - 0.15, Math.min(az, bz) - 0.15, Math.max(ax, bx) + 0.15, Math.max(az, bz) + 0.15, L[lv], y1, slab); }
    }
    // ground level walls with an entrance gap on the north side
    for (const [ax, az, bx, bz] of [[X0, Z0, X0 + 4, Z0], [X0 + 18, Z0, X1, Z0], [X1, Z0, X1, Z1], [X1, Z1, X0, Z1], [X0, Z1, X0, Z0]]) { W.cols.seg(ax, az, bx, bz, { y0: -1, y1: 2.6, kind: 'wall' }); boxMesh(W, Math.min(ax, bx) - 0.15, Math.min(az, bz) - 0.15, Math.max(ax, bx) + 0.15, Math.max(az, bz) + 0.15, 0, 1.0, slab); }
    // ramp side barriers (stop cars driving onto or off a ramp from the side)
    W.cols.seg(RA.x0, RA.z0, RA.x1, RA.z0, { y0: -1, y1: L[1] + 1.2 }); W.cols.seg(RB.x0, RB.z1, RB.x1, RB.z1, { y0: L[1] - 0.5, y1: L[2] + 1.2 }); W.cols.seg(RA.x0, RA.z0, RA.x1, RA.z0, { y0: L[2] - 0.5, y1: L[3] + 1.2 });
    const ramp = (R, ya, yb) => { const len = Math.hypot(R.x1 - R.x0, yb - ya), m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.35, R.z1 - R.z0), slab); m.position.set((R.x0 + R.x1) / 2, (ya + yb) / 2 - 0.17, (R.z0 + R.z1) / 2); m.rotation.z = Math.atan2(yb - ya, R.x1 - R.x0); W.group.add(m); };
    ramp(RA, L[0], L[1]); ramp(RB, L[2], L[1]); ramp(RA, L[2], L[3]);
    const cols = [];
    for (let x = X0 + 7; x < X1; x += 14) for (let z = Z0 + 16; z < Z1 - 9; z += 16) { cols.push([x, 0, z, 1]); W.cols.circ(x, z, 0.35, { kind: 'pole', y0: -1, y1: L[3] }); }
    const cg = new THREE.BoxGeometry(0.6, L[3], 0.6); cg.translate(0, L[3] / 2, 0); instanced(W, cg, slab, cols);
    W.garages.push({ X0, Z0, X1, Z1, entrance: [X0 + 11, Z0] });
  };
  addGarage(1 * B + 25, 1 * B + 15);
  addGarage(-3 * B + 25, 2 * B + 15);
  // street lamps along avenues, parked cars along streets
  const lampPos = [], lampPoles = [], parked = [];
  const nearCross = (a, gap) => { const k = Math.round(a / B); return Math.abs(a - k * B) < hwOf(k) + gap; };
  for (const p of pieces) {
    const inTunnel = (a) => p.axis === 'z' && p.c === 0 && a > pz0 - 4 && a < pz1 + 4;
    if (p.ave) for (let a = p.a0 + 25; a < p.a1; a += 50) { if (nearCross(a, 4) || inTunnel(a)) continue; for (const s of [-1, 1]) { const off = s * (p.hw + 1.2), x = p.axis === 'z' ? p.c + off : a, z = p.axis === 'z' ? a : p.c + off; lampPoles.push([x, 0, z, 1]); lampPos.push(x, 8.2, z); } }
    else for (let a = p.a0 + 8; a < p.a1; a += 6.5) {
      if (nearCross(a, 18) || rnd() > 0.075) continue;
      const s = rnd() < 0.5 ? -1 : 1, off = s * (p.hw - 1.25), x = p.axis === 'z' ? p.c + off : a, z = p.axis === 'z' ? a : p.c + off;
      if (x > PL.x0 - 6 && x < PL.x1 + 6 && z > PL.z0 - 6 && z < PL.z1 + 6) continue;
      parked.push([x, 0, z, 1, p.axis === 'z' ? 0 : Math.PI / 2]);
      const ex = p.axis === 'z' ? 0 : 1.3, ez = p.axis === 'z' ? 1.3 : 0;
      W.cols.circ(x + ex, z + ez, 0.95, { kind: 'parked', y0: -1, y1: 1.6 }); W.cols.circ(x - ex, z - ez, 0.95, { kind: 'parked', y0: -1, y1: 1.6 });
    }
  }
  const lpg = new THREE.CylinderGeometry(0.1, 0.13, 8.2, 6); lpg.translate(0, 4.1, 0);
  instanced(W, lpg, new THREE.MeshLambertMaterial({ color: 0x4a4f54 }), lampPoles);
  W.lamps = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lampPos, 3)), glowMat(0xffd9a0, 3.2));
  W.group.add(W.lamps);
  W.parkedGeo = (root.R29Cars && root.R29Cars.trafficGeometry) ? root.R29Cars.trafficGeometry() : null;
  if (W.parkedGeo) instanced(W, W.parkedGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), parked, (t, k) => new THREE.Color([0xb03a2e, 0x2e5ea8, 0xdedede, 0x2a2a2a, 0x8a8f94, 0x3f6b4a, 0xc9b26a][k % 7]));
  // traffic lanes on every line piece (straight-through traffic)
  for (const p of pieces) {
    const offs = p.ave ? [1.75, 5.25] : [1.75];
    for (const o2 of offs) { p.axis === 'z' ? W.lanes.push({ city: p, off: -o2, dir: 1 }, { city: p, off: o2, dir: -1 }) : W.lanes.push({ city: p, off: o2, dir: 1 }, { city: p, off: -o2, dir: -1 }); }
  }
  // time-trial route: loop along the grid
  const route = map.checkpoints.route, cps = [];
  for (let leg = 0; leg < route.length; leg++) {
    const [ax, az] = route[leg], [bx, bz] = route[(leg + 1) % route.length], L2 = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L2, tz = (bz - az) / L2;
    const starts = leg === 0 ? [60] : []; for (let s = 500; s < L2 - 100; s += map.checkpoints.every_m) starts.push(s);
    for (const s of starts) { const o3 = tx !== 0 ? 1.75 * 0 : 0; cps.push({ x: ax + tx * s + o3, z: az + tz * s, y: 0, tx, tz, hw: 14, idx: cps.length }); }
  }
  W.checkpoints = cps; W.laps = map.checkpoints.laps || 1;
  W.spawns = map.spawn_points.map(sp => sp.garage != null ? { x: W.garages[sp.garage].entrance[0], z: Math.floor(W.garages[sp.garage].Z0 / B) * B - 2, y: 0, h: Math.PI, label: sp.label } : { x: sp.x, z: sp.z, y: 0, h: sp.h, label: sp.label });
  W.grid = Array.from({ length: 12 }, (_, k) => ({ x: 1.75 + (k % 2) * 3.5, z: 1000 + 30 + Math.floor(k / 2) * 9, y: 0, h: 0, label: 'Grid ' + (k + 1) }));
  const Bd = half + 60; for (const [ax, az, bx, bz] of [[-Bd, -Bd, Bd, -Bd], [Bd, -Bd, Bd, Bd], [Bd, Bd, -Bd, Bd], [-Bd, Bd, -Bd, -Bd]]) W.cols.seg(ax, az, bx, bz, { kind: 'wall' });
  W.outOfBounds = () => false;
}

/* =================== build entry =================== */
function build(map, opts) {
  const W = newWorld(map, opts);
  ({ coast: Gn.genCoast, mountain: Gn.genMountain, circuit: genCircuit, testtrack: genTestTrack, desert: genDesert, city: genCity })[map.generator](W, map);
  if (!W.minimapLines.length) minimapFrom(W);
  return W;
}
root.R29World = { build };
})(typeof self !== 'undefined' ? self : this);
