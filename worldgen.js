/* R29-Track map generators + shared scenery builders. Reads parameters from maps.js. */
(function (root) {
'use strict';
const U = root.R29WorldUtil;
const { clamp, lerp, smooth, rng, sampleSpline, makeRoad, smoothProfile, makeTiles, newWorld } = U;
let ANISO = 4;
const C = (r, g, b) => new THREE.Color(r, g, b);

/* ---------- textures ---------- */
const TEXC = {};
function speckle(key, base, dots, n, size, res = 128) {
  if (TEXC[key]) return TEXC[key];
  const c = document.createElement('canvas'); c.width = c.height = res;
  const g = c.getContext('2d'); g.fillStyle = base; g.fillRect(0, 0, res, res);
  const r = rng(key.length * 977 + n);
  for (let i = 0; i < n; i++) { g.fillStyle = dots[i % dots.length]; g.fillRect(r() * res, r() * res, size, size); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = ANISO;
  return TEXC[key] = t;
}
const tex = {
  asphalt: () => speckle('asphalt', '#5f6365', ['#575b5d', '#686c6e', '#5c6062', '#515557', '#6e7274'], 9000, 1, 256),
  dirt: () => speckle('dirt', '#9a7a58', ['#8a6c4c', '#a8876a', '#7d6146'], 1500, 2),
  detail: () => speckle('detail', '#e6e6e6', ['#d2d2d2', '#f4f4f4', '#c8c8c8', '#ffffff'], 2600, 2, 256),
  concrete: () => speckle('concrete', '#a7a9a7', ['#9c9e9c', '#b2b4b2', '#a0a2a0'], 1200, 2),
};

/* ---------- geometry helpers ---------- */
function quadsMesh(build, matOpts = {}) {
  const pos = [], col = [];
  const quad = (a, b, c, d, color) => { for (const v of [a, b, c, b, d, c]) { pos.push(v[0], v[1], v[2]); col.push(color.r, color.g, color.b); } };
  build(quad);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial(Object.assign({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }, matOpts)));
}
const rv = (r, i) => [-r.tz[i], r.tx[i]]; // right vector at sample i
const at = (r, i, off, dy = 0) => { const [rx, rz] = rv(r, i); return [r.x[i] + rx * off, r.y[i] + dy, r.z[i] + rz * off]; };

function roadMesh(W, r, o = {}) {
  const pos = [], uv = [], ind = [], hw = r.width / 2 + (o.extra || 0), yo = o.y ?? 0.04, vs = o.vScale || 10;
  const cnt = r.closed ? r.n + 1 : r.n;
  for (let k = 0; k < cnt; k++) {
    const i = k % r.n, [rx, rz] = rv(r, i), s = k === r.n ? r.len : r.s[i];
    pos.push(r.x[i] - rx * hw, r.y[i] + yo, r.z[i] - rz * hw, r.x[i] + rx * hw, r.y[i] + yo, r.z[i] + rz * hw);
    uv.push(0, s / vs, 1, s / vs);
    if (k < cnt - 1) { const a = k * 2; ind.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(ind); g.computeVertexNormals();
  const m = new THREE.Mesh(g, o.mat || W.mats.road);
  W.group.add(m); return m;
}
function markings(W, r, style) {
  const WHITE = C(0.93, 0.93, 0.9), YEL = C(0.93, 0.74, 0.18), RED = C(0.83, 0.19, 0.16);
  const hw = r.width / 2, segs = r.closed ? r.n : r.n - 1;
  W.group.add(quadsMesh(q => {
    for (let i = 0; i < segs; i++) {
      const j = r.idx(i + 1), line = (o0, o1, c) => q(at(r, i, o0, 0.055), at(r, i, o1, 0.055), at(r, j, o0, 0.055), at(r, j, o1, 0.055), c);
      if (style === 'two-lane') {
        line(-hw + 0.15, -hw + 0.3, WHITE); line(hw - 0.3, hw - 0.15, WHITE);
        const tight = Math.abs(r.k[i]) > 1 / 260;
        if (tight) { line(-0.2, -0.08, YEL); line(0.08, 0.2, YEL); }
        else if (Math.floor(r.s[i] / 3) % 4 === 0) line(-0.07, 0.07, YEL);
      } else if (style === 'circuit') {
        line(-hw + 0.1, -hw + 0.35, WHITE); line(hw - 0.35, hw - 0.1, WHITE);
        if (Math.abs(r.k[i]) > 1 / 140) { // curbs on corners
          const s = Math.sign(r.k[i]), c = Math.floor(i / 2) % 2 ? RED : WHITE;
          q(at(r, i, s * hw, 0.05), at(r, i, s * (hw + 1.3), 0.05), at(r, j, s * hw, 0.05), at(r, j, s * (hw + 1.3), 0.05), c);
          q(at(r, i, -s * hw, 0.05), at(r, i, -s * (hw + 1.0), 0.05), at(r, j, -s * hw, 0.05), at(r, j, -s * (hw + 1.0), 0.05), c);
        }
      } else if (style === 'pit') {
        line(-hw + 0.1, -hw + 0.3, WHITE); line(hw - 0.3, hw - 0.1, WHITE);
      }
    }
  }));
}
function shoulders(W, r, color) {
  const hw = r.width / 2, sh = r.shoulder, segs = r.closed ? r.n : r.n - 1;
  if (sh <= 0) return;
  W.group.add(quadsMesh(q => {
    for (let i = 0; i < segs; i++) {
      const j = r.idx(i + 1);
      q(at(r, i, -hw - sh, 0.025), at(r, i, -hw, 0.03), at(r, j, -hw - sh, 0.025), at(r, j, -hw, 0.03), color);
      q(at(r, i, hw, 0.03), at(r, i, hw + sh, 0.025), at(r, j, hw, 0.03), at(r, j, hw + sh, 0.025), color);
    }
  }, { polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
}
/* guardrails from r.guard flags (1 = left, 2 = right) and invisible rock-wall colliders from r.wall flags */
function rails(W, r) {
  const off = r.width / 2 + r.shoulder + 0.4, posts = [], STEEL = C(0.72, 0.74, 0.76);
  const mesh = quadsMesh(q => {
    for (const [bit, sgn] of [[1, -1], [2, 1]]) {
      let runStart = -1;
      const segs = r.closed ? r.n : r.n - 1;
      for (let i = 0; i <= segs; i++) {
        const on = i < segs && (r.guard[i] & bit);
        if (on && runStart < 0) runStart = i;
        if (on) {
          const j = r.idx(i + 1);
          q(at(r, i, sgn * off, 0.5), at(r, i, sgn * off, 0.82), at(r, j, sgn * off, 0.5), at(r, j, sgn * off, 0.82), STEEL);
          if (i % 2 === 0) { const p = at(r, i, sgn * (off + 0.1), 0); posts.push(p); }
        }
        if ((!on || i === segs) && runStart >= 0) {
          for (let k = runStart; k < i; k += 3) { const a = at(r, k, sgn * off), b = at(r, r.idx(Math.min(i, k + 3)), sgn * off); if (Math.hypot(b[0] - a[0], b[2] - a[2]) < 15) W.cols.seg(a[0], a[2], b[0], b[2], { kind: 'rail' }); }
          runStart = -1;
        }
      }
    }
  }, { polygonOffset: false, side: THREE.DoubleSide });
  mesh.material = new THREE.MeshLambertMaterial({ color: 0xb8bcc0, side: THREE.DoubleSide });
  W.group.add(mesh);
  if (posts.length) {
    const g = new THREE.BoxGeometry(0.12, 0.85, 0.12); g.translate(0, 0.42, 0);
    const im = new THREE.InstancedMesh(g, new THREE.MeshLambertMaterial({ color: 0x8a8f94 }), posts.length), o = new THREE.Object3D();
    posts.forEach((p, k) => { o.position.set(p[0], p[1], p[2]); o.updateMatrix(); im.setMatrixAt(k, o.matrix); });
    W.group.add(im);
  }
  // rock-wall colliders where the terrain rises sharply beside the road
  const woff = r.width / 2 + r.shoulder + 1.2;
  for (const [bit, sgn] of [[1, -1], [2, 1]]) for (let i = 0; i < (r.closed ? r.n : r.n - 1); i += 3) if (r.wall[i] & bit) {
    const j = r.idx(Math.min(r.closed ? i + 3 : r.n - 1, i + 3)), a = at(r, i, sgn * woff), b = at(r, j, sgn * woff);
    W.cols.seg(a[0], a[2], b[0], b[2], { kind: 'rock' });
  }
}
function flagEdges(W, r, opts) {
  const edge = r.width / 2 + r.shoulder, rnd = rng(opts.seed || 5);
  let runGuard = [0, 0], runOn = [rnd() < opts.guardShare, rnd() < opts.guardShare];
  for (let i = 0; i < r.n; i += 1) {
    for (const [bit, sgn, k] of [[1, -1, 0], [2, 1, 1]]) {
      if (opts.sides && !opts.sides.includes(sgn)) continue;
      const p = at(r, i, sgn * (edge + opts.probe)), h = W.heightAt(p[0], p[2]);
      if (h < r.y[i] - opts.drop) { if (runGuard[k]-- <= 0) { runGuard[k] = 60; runOn[k] = rnd() < opts.guardShare; } if (runOn[k]) r.guard[i] |= bit; }
      const p2 = at(r, i, sgn * (edge + 3)), h2 = W.heightAt(p2[0], p2[2]);
      if (h2 > r.y[i] + (opts.wallRise || 2.5)) r.wall[i] |= bit;
    }
  }
}
function instanced(W, geo, mat, list, colorFn) {
  if (!list.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, list.length), o = new THREE.Object3D();
  list.forEach((t, k) => {
    o.position.set(t[0], t[1], t[2]); o.rotation.set(0, t[4] || 0, 0); const s = t[3] || 1; o.scale.set(s * (t[5] || 1), s, s * (t[5] || 1));
    o.updateMatrix(); im.setMatrixAt(k, o.matrix); if (colorFn) im.setColorAt(k, colorFn(t, k));
  });
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  W.group.add(im); return im;
}
function pines(W, list, color = 0x24572b) {
  const cone = new THREE.ConeGeometry(2.6, 9, 7); cone.translate(0, 6, 0);
  const trunk = new THREE.CylinderGeometry(0.35, 0.4, 2, 6); trunk.translate(0, 1, 0);
  instanced(W, cone, new THREE.MeshLambertMaterial({ color }), list);
  instanced(W, trunk, new THREE.MeshLambertMaterial({ color: 0x5e4129 }), list);
}
function cypress(W, list) {
  const g = new THREE.ConeGeometry(1.8, 11, 7); g.translate(0, 7, 0);
  const t = new THREE.CylinderGeometry(0.3, 0.35, 2, 6); t.translate(0, 1, 0);
  instanced(W, g, new THREE.MeshLambertMaterial({ color: 0x2c4a2a }), list);
  instanced(W, t, new THREE.MeshLambertMaterial({ color: 0x5a4430 }), list);
}
function boulders(W, list, color = 0x8a8178) {
  const g = new THREE.DodecahedronGeometry(1, 0); g.translate(0, 0.35, 0);
  instanced(W, g, new THREE.MeshLambertMaterial({ color, flatShading: true }), list, (t, k) => new THREE.Color(color).multiplyScalar(0.8 + ((k * 37) % 10) / 25));
  for (const t of list) W.cols.circ(t[0], t[2], (t[3] || 1) * 0.85 * (t[5] || 1), { kind: 'rock', y0: t[1] - 2, y1: t[1] + (t[3] || 1) * 1.4 });
}
function kmPosts(W, r) {
  const list = []; for (let km = 1; km * 1000 < r.len; km++) { const i = Math.round(km * 1000 / (r.len / r.n)); if (i >= r.n) break; const p = at(r, i, r.width / 2 + r.shoulder + 0.8); list.push([p[0], p[1], p[2], 1]); }
  const g = new THREE.BoxGeometry(0.18, 1.1, 0.12); g.translate(0, 0.55, 0);
  instanced(W, g, new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }), list);
}

/* checkpoints, spawns, grid, lanes, minimap */
function gateAt(r, s, idx) {
  const i = clamp(Math.round(s / (r.len / r.n)), 0, r.n - 1);
  return { x: r.x[i], z: r.z[i], y: r.y[i], tx: r.tx[i], tz: r.tz[i], hw: r.width / 2 + r.shoulder + 8, s: r.s[i], i, idx };
}
function routeCheckpoints(W, r, everyM, isLoop, laps) {
  const list = [];
  if (isLoop) { for (let s = 0; s < r.len - everyM * 0.5; s += everyM) list.push(gateAt(r, s, list.length)); }
  else { list.push(gateAt(r, 40, 0)); for (let s = everyM; s < r.len - everyM * 0.5; s += everyM) list.push(gateAt(r, s, list.length)); list.push(gateAt(r, r.len - 25, list.length)); }
  W.checkpoints = list; W.laps = isLoop ? (laps || 1) : 1;
}
function spawnOn(r, s, lateral, label) {
  if (r.closed) s = ((s % r.len) + r.len) % r.len;
  const i = clamp(Math.round(s / (r.len / r.n)), 0, r.n - 1), [rx, rz] = rv(r, i);
  return { x: r.x[i] + rx * lateral, z: r.z[i] + rz * lateral, y: r.y[i], h: Math.atan2(r.tx[i], -r.tz[i]), label };
}
function gridOn(W, r, s0, lateralFn) {
  W.grid = [];
  for (let k = 0; k < 12; k++) {
    let s = s0 - 10 - k * 8; if (r.closed) s = (s + r.len) % r.len; else s = Math.max(5, s0 + 6 + k * 0) ;
    W.grid.push(spawnOn(r, r.closed ? s : Math.max(4, s0 - 4 - k * 9 + 40), lateralFn(k), 'Grid ' + (k + 1)));
  }
}
function twoWayLanes(W, r, vmax) {
  W.lanes.push({ road: r, off: r.laneW / 2, dir: 1, vmax }, { road: r, off: -r.laneW / 2, dir: -1, vmax });
}
function minimapFrom(W) {
  W.minimapLines = W.roads.filter(r => r.kind !== 'hidden').map(r => {
    const step = Math.max(1, Math.round(12 / (r.len / r.n))), pts = [];
    for (let i = 0; i < r.n; i += step) pts.push(r.x[i], r.z[i]);
    if (r.closed) pts.push(r.x[0], r.z[0]); else pts.push(r.x[r.n - 1], r.z[r.n - 1]);
    return { pts: new Float32Array(pts), w: r.width, kind: r.kind };
  });
}
function startGantry(W, r, s, label) {
  const g = gateAt(r, s, 0), h0 = Math.atan2(g.tx, -g.tz), grp = new THREE.Group(), hw = r.width / 2;
  const bc = document.createElement('canvas'); bc.width = 1024; bc.height = 128; const bg = bc.getContext('2d');
  for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) { bg.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; bg.fillRect(x * 32, y * 32, 32, 32); }
  const btex = new THREE.CanvasTexture(bc); btex.anisotropy = ANISO;
  const draw = () => { bg.fillStyle = '#111'; bg.fillRect(312, 8, 400, 112); bg.strokeStyle = '#f4f4f4'; bg.lineWidth = 4; bg.strokeRect(318, 14, 388, 100);
    bg.fillStyle = '#f4f4f4'; bg.textAlign = 'center'; bg.textBaseline = 'middle'; bg.font = '700 76px "Chakra Petch", Impact, sans-serif'; bg.fillText(label, 512, 68); btex.needsUpdate = true; };
  draw(); if (document.fonts && document.fonts.load) document.fonts.load('700 76px "Chakra Petch"').then(draw, () => {});
  const face = new THREE.MeshBasicMaterial({ map: btex }), side = new THREE.MeshLambertMaterial({ color: 0x111111 }), mat = new THREE.MeshLambertMaterial({ color: 0x2b3238 });
  const bar = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 5, 2.2, 0.6), [side, side, side, side, face, face]); bar.position.y = 6.6; grp.add(bar);
  for (const sx of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.7, 0.5), mat); p.position.set(sx * (hw + 2.5), 3.85, 0); grp.add(p);
    const pp = [g.x + (-g.tz) * sx * (hw + 2.5), g.z + g.tx * sx * (hw + 2.5)]; W.cols.circ(pp[0], pp[1], 0.4, { kind: 'pole' }); }
  grp.position.set(g.x, g.y, g.z); grp.rotation.y = -h0; W.group.add(grp);
  const c = document.createElement('canvas'); c.width = 128; c.height = 16; const cg = c.getContext('2d');
  for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { cg.fillStyle = (x + y) % 2 ? '#111' : '#fff'; cg.fillRect(x * 8, y * 8, 8, 8); }
  const line = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 1.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
  line.geometry.rotateX(-Math.PI / 2); line.position.set(g.x, g.y + 0.06, g.z); line.rotation.y = -h0; W.group.add(line);
}
function oceanPlane(W) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshPhongMaterial({ color: 0x245a78, shininess: 90, specular: 0x557788, transparent: true, opacity: 0.93 }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0; W.group.add(m); W.oceanMesh = m;
}
function stdMats(W) {
  W.mats = {
    road: new THREE.MeshLambertMaterial({ map: tex.asphalt(), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    dirt: new THREE.MeshLambertMaterial({ map: tex.dirt(), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
  };
  if (W.wet > 0.4) W.mats.road = new THREE.MeshPhongMaterial({ map: tex.asphalt(), color: 0x8a8f94, shininess: 70, specular: 0x666a6e, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
}
const snowMix = (W, c, slope) => { if (W.snow > 0) { const k = W.snow * (slope > 0.9 ? 0.35 : 0.92); c.lerp(C(0.93, 0.95, 0.97), k); } };

/* =================== Pacific Coast Highway =================== */
function genCoast(W, map) {
  const g = map.gen, N = W.noise;
  const coastX = z => 260 * Math.sin(z / 1900) + 140 * Math.sin(z / 730 + 1.3) + 55 * Math.sin(z / 310 + 0.4) + 30 * N.n2(0.5, z / 400);
  const cliffTop = z => Math.max(18, 44 + 28 * Math.sin(z / 2300 + 1) + 18 * N.fbm(3.3, z / 900, 3));
  W.base = (x, z) => {
    const d = x - coastX(z), ch = cliffTop(z);
    if (d < 0) return Math.max(-30, -2.5 + d * 0.09);
    if (d < 32) return -2.5 + (ch + 2.5) * Math.pow(smooth(0, 32, d), 0.55);
    const h = ch + (d - 32) * 0.07 + 24 * N.fbm(x / 240, z / 240, 3) * smooth(32, 160, d) + 160 * (0.5 + 0.5 * N.fbm(x / 1200 + 7, z / 1200, 4)) * smooth(90, 800, d);
    return Math.max(ch * 0.85, h);
  };
  W.blendCut = 16; W.blendFill = 26; W.ocean = true; W.seaLevel = 0;
  const pts = []; let z = 150, acc = 0, prev = null;
  while (acc < g.length + 2500) {
    const amp = 46 * smooth(-0.15, 0.45, N.fbm(z / 2600 + 4, 1.7, 2));
    const x = coastX(z) + g.inset + amp * Math.sin(z / 72 + 0.6) + 26 * Math.sin(z / 260 + 2) + 14 * N.n2(z / 330, 9.1);
    if (prev) acc += Math.hypot(x - prev[0], z - prev[1]); pts.push([x, z]); prev = [x, z]; z -= 36;
  }
  const s = sampleSpline(pts, false, 3).slice(0, Math.round(g.length / 3) + 1);
  const r = W.mainRoad = W.addRoad(makeRoad('main', s, { width: 7.2, shoulder: 1.4, laneW: 3.6, markings: 'two-lane' }), 7.2 / 2 + 1.4 + 34);
  for (let i = 0; i < r.n; i++) r.y[i] = W.base(r.x[i], r.z[i]);
  smoothProfile(r, 30, 0.075, 14);
  W.offSurface = (x, z, h, q) => { const d = x - coastX(z); return h < 0.2 ? 'sand' : d < 34 ? 'rock' : (q && h > q.y + 2 && q.d < 20) ? 'rock' : 'grass'; };
  W.colorAt = (x, z, h, q, c, slope) => {
    const d = x - coastX(z), t = 0.5 + 0.5 * N.n2(x / 90, z / 90);
    if (h < 0.4) c.setRGB(0.74, 0.68, 0.52);
    else if (d < 36 || slope > 0.85) c.setRGB(0.46 + 0.05 * t, 0.42 + 0.04 * t, 0.37);
    else c.setRGB(lerp(0.6, 0.4, t), lerp(0.55, 0.5, t), lerp(0.3, 0.25, t));
    if (q && q.d < q.road.width / 2 + q.road.shoulder + 1.5) c.setRGB(0.5, 0.46, 0.4);
    snowMix(W, c, slope);
  };
  flagEdges(W, r, { probe: 10, drop: 3, guardShare: 0.92, sides: [-1, 1], seed: 3 });
  stdMats(W);
  W.tiles = makeTiles(W, { detail: tex.detail(), radius: 1400 });
  W.tiles.allowNear([r], 650);
  roadMesh(W, r); markings(W, r, 'two-lane'); shoulders(W, r, C(0.55, 0.5, 0.43)); rails(W, r); kmPosts(W, r); oceanPlane(W);
  // scenery: cypress inland, rock outcrops on the inside of right-hand bends (blind corners)
  const rnd = W.rand, trees = [], rocks = [];
  for (let i = 0; i < r.n; i += 7) {
    const [rx, rz] = rv(r, i);
    if (rnd() < 0.5) { const off = 16 + rnd() * 140, x = r.x[i] + rx * off, zz = r.z[i] + rz * off; trees.push([x, W.heightAt(x, zz) - 0.3, zz, 0.7 + rnd() * 0.7]); }
    if (rnd() < 0.08) { const off = -(16 + rnd() * 20), x = r.x[i] + rx * off, zz = r.z[i] + rz * off, h = W.heightAt(x, zz); if (h > 6 && x - coastX(zz) > 36) trees.push([x, h - 0.3, zz, 0.6 + rnd() * 0.5]); }
    if (r.k[i] > 1 / 220 && rnd() < 0.35) { const off = r.width / 2 + r.shoulder + 4 + rnd() * 6, x = r.x[i] + rx * off, zz = r.z[i] + rz * off; rocks.push([x, W.heightAt(x, zz) - 0.4, zz, 1.4 + rnd() * 2.2, rnd() * 6, 1 + rnd() * 0.5]); }
  }
  cypress(W, trees); boulders(W, rocks, 0x8d8273);
  routeCheckpoints(W, r, map.checkpoints.every_km * 1000, false);
  W.spawns = map.spawn_points.map(sp => spawnOn(r, sp.km * 1000, r.laneW / 2, sp.label));
  W.grid = Array.from({ length: 12 }, (_, k) => spawnOn(r, 34 - Math.floor(k / 2) * 9, (k % 2 ? -1 : 1) * r.laneW / 2, 'Grid ' + (k + 1)));
  twoWayLanes(W, r, map.speed_limit_ms);
  W.finishLabel = 'FINISH'; startGantry(W, r, 40, 'START'); startGantry(W, r, r.len - 25, 'FINISH');
  W.outOfBounds = (x, z, q) => !q || q.d > 500;
}

/* =================== Blackpine Mountain Pass =================== */
function genMountain(W, map) {
  const g = map.gen, N = W.noise;
  let x = 0, z = 0, a = 0.25, y = 430; const P = [], Y = [];
  const go = (len, kfn, grade) => { for (let s = 0; s < len; s += 3) { a += kfn(s) * 3; x += Math.sin(a) * 3; z -= Math.cos(a) * 3; y += grade * 3; P.push([x, z]); Y.push(y); } };
  const angDiff = (t, b) => Math.atan2(Math.sin(t - b), Math.cos(t - b));
  const turnTo = (target, R, grade) => { let n = 0; while (Math.abs(angDiff(target, a)) > 0.03 && n++ < 3000) go(3, () => Math.sign(angDiff(target, a)) / R, grade); };
  go(g.valley, s => Math.sin(s / 330) / 420 + Math.sin(s / 150 + 1) / 900, 0.045);
  const alpha = 0.1;
  turnTo(Math.PI / 2 - alpha, 70, 0.06);
  for (let k = 0; k < g.switchbacks; k++) {
    go(g.leg, s => 0.0005 * Math.sin(s / 55 + k), g.grade);
    const dir = k % 2 === 0 ? -1 : 1, turn = Math.PI - 2 * alpha;
    go(g.radius * turn, () => dir / g.radius, 0.06);
  }
  go(g.leg * 0.5, () => 0, g.grade);
  turnTo(0, 110, 0.07);
  go(g.upper, s => Math.sin(s / 280) / 260 + Math.sin(s / 90 + 2) / 800, 0.085);
  const rem = g.length - P.length * 3, curvy = s => Math.sin(s / 240 + 1) / 230 + Math.sin(s / 75) / 600;
  const pair = (d) => { go(g.radius * Math.PI, () => d / g.radius, -0.05); go(170, () => 0, -0.07); go(g.radius * Math.PI, () => -d / g.radius, -0.05); };
  go(rem * 0.28, curvy, -0.065); pair(1); go(rem * 0.3, curvy, -0.065); pair(-1);
  go(g.length - P.length * 3 + 30, curvy, -0.06);
  const n = Math.round(g.length / 3) + 1;
  const pts = P.slice(0, n);
  const r = W.mainRoad = W.addRoad(makeRoad('main', pts, { width: 5.8, shoulder: 0.6, laneW: 2.9, markings: 'two-lane' }), 115);
  for (let i = 0; i < r.n; i++) r.y[i] = Y[i];
  smoothProfile(r, 8, 0);
  // base terrain: a coarse grid holding the height of (and distance to) the nearest stretch of road, smoothed,
  // with mountains rising away from the road and noise on top
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < r.n; i++) { x0 = Math.min(x0, r.x[i]); x1 = Math.max(x1, r.x[i]); z0 = Math.min(z0, r.z[i]); z1 = Math.max(z1, r.z[i]); }
  const CELL = 50, PAD = 2200; x0 -= PAD; z0 -= PAD; x1 += PAD; z1 += PAD;
  const nx = Math.ceil((x1 - x0) / CELL) + 1, nz = Math.ceil((z1 - z0) / CELL) + 1;
  const HN = new Float32Array(nx * nz), DN = new Float32Array(nx * nz);
  const sx = [], sz = [], sy = []; for (let i = 0; i < r.n; i += 8) { sx.push(r.x[i]); sz.push(r.z[i]); sy.push(r.y[i]); }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const px = x0 + i * CELL, pz = z0 + j * CELL; let d1 = Infinity, h1 = 0, d2 = Infinity, h2 = 0, k1 = -1;
    for (let k = 0; k < sx.length; k++) { const d = (sx[k] - px) ** 2 + (sz[k] - pz) ** 2; if (d < d1) { d2 = d1; h2 = h1; d1 = d; h1 = sy[k]; k1 = k; } else if (d < d2 && Math.abs(k - k1) > 15) { d2 = d; h2 = sy[k]; } }
    d1 = Math.sqrt(d1); d2 = Math.sqrt(d2);
    const w1 = 1 / (d1 + 30), w2 = 1 / (d2 + 30);
    HN[j * nx + i] = (h1 * w1 + h2 * w2) / (w1 + w2); DN[j * nx + i] = d1;
  }
  for (let pass = 0; pass < 3; pass++) { const T = Float32Array.from(HN); for (let j = 1; j < nz - 1; j++) for (let i = 1; i < nx - 1; i++) { let s = 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) s += T[(j + a) * nx + i + b]; HN[j * nx + i] = s / 9; } }
  const bil = (A, x, z) => { const fx = clamp((x - x0) / CELL, 0, nx - 1.001), fz = clamp((z - z0) / CELL, 0, nz - 1.001), i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    return lerp(lerp(A[j * nx + i], A[j * nx + i + 1], tx), lerp(A[(j + 1) * nx + i], A[(j + 1) * nx + i + 1], tx), tz); };
  W.base = (x, z) => {
    const d = bil(DN, x, z);
    return bil(HN, x, z) + 0.12 * d + 420 * smooth(260, 1600, d) + 38 * N.fbm(x / 650, z / 650, 4) * smooth(20, 200, d) + 9 * N.fbm(x / 110, z / 110, 3);
  };
  W.blendCut = 9; W.blendFill = 20;
  // mountainside cross-slope: one side climbs (rock wall), the other falls away (drop-off); swaps sides along the route
  W.sideTilt = a => { const k = 1.0 * clamp(N.n2(a.s / 800, 4.2) * 1.8, -1, 1); return k * a.lat * (1 - smooth(60, 108, Math.abs(a.lat))); };
  W.offSurface = (x, z, h, q) => (q && q.d < 18 && Math.abs(h - q.y) > 2.5) || h > 1180 ? 'rock' : 'grass';
  W.colorAt = (x, z, h, q, c, slope) => {
    const t = 0.5 + 0.5 * N.n2(x / 70, z / 70);
    if (slope > 0.62) c.setRGB(0.42 + 0.06 * t, 0.41 + 0.05 * t, 0.4 + 0.04 * t);
    else if (h > 1180) c.setRGB(0.5, 0.52, 0.4);
    else c.setRGB(0.24 + 0.08 * t, 0.36 + 0.07 * t, 0.2);
    if (q && q.d < q.road.width / 2 + q.road.shoulder + 1.5) c.setRGB(0.45, 0.43, 0.4);
    snowMix(W, c, slope);
  };
  flagEdges(W, r, { probe: 6, drop: 4, guardShare: 0.55, seed: 9, wallRise: 2.5 });
  stdMats(W);
  W.tiles = makeTiles(W, { detail: tex.detail(), radius: 1300 });
  W.tiles.allowNear([r], 700);
  roadMesh(W, r); markings(W, r, 'two-lane'); shoulders(W, r, C(0.5, 0.48, 0.44)); rails(W, r); kmPosts(W, r);
  const rnd = W.rand, trees = [], rocks = [];
  for (let i = 0; i < r.n; i += 4) {
    const [rx, rz] = rv(r, i);
    for (let k = 0; k < 2; k++) {
      const off = (rnd() < 0.5 ? -1 : 1) * (10 + rnd() * 260), px = r.x[i] + rx * off, pz = r.z[i] + rz * off;
      const q = W.nearest(px, pz); if (q && q.d < 9) continue;
      const h = W.heightAt(px, pz), h2 = W.heightAt(px + 5, pz), h3 = W.heightAt(px, pz + 5);
      if (Math.hypot(h2 - h, h3 - h) / 5 > 0.65 || h > 1170) continue;
      if (rnd() < 0.7) trees.push([px, h - 0.3, pz, 0.6 + rnd() * 0.8]);
    }
    if ((r.wall[i]) && rnd() < 0.18) { const sg = (r.wall[i] & 2) ? 1 : -1, off = sg * (r.width / 2 + r.shoulder + 2.5 + rnd() * 2), px = r.x[i] + rx * off, pz = r.z[i] + rz * off; rocks.push([px, W.heightAt(px, pz) - 0.3, pz, 0.8 + rnd() * 1.4, rnd() * 6]); }
  }
  pines(W, trees, 0x1f4a26); boulders(W, rocks, 0x7c7a76);
  routeCheckpoints(W, r, map.checkpoints.every_km * 1000, false);
  W.spawns = map.spawn_points.map(sp => spawnOn(r, sp.km * 1000, r.laneW / 2, sp.label));
  W.grid = Array.from({ length: 12 }, (_, k) => spawnOn(r, 34 - k * 9, r.laneW / 2, 'Grid ' + (k + 1)));
  twoWayLanes(W, r, map.speed_limit_ms);
  startGantry(W, r, 40, 'START'); startGantry(W, r, r.len - 25, 'FINISH');
  W.outOfBounds = (x, z, q) => !q || q.d > 450;
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < r.n; i++) { lo = Math.min(lo, r.y[i]); hi = Math.max(hi, r.y[i]); }
  W.measuredElevation = [lo, hi];
}

root.R29Gen = { tex, speckle, quadsMesh, roadMesh, markings, shoulders, rails, flagEdges, instanced, pines, cypress, boulders, kmPosts, gateAt,
  routeCheckpoints, spawnOn, twoWayLanes, minimapFrom, startGantry, oceanPlane, stdMats, snowMix, rv, at, C,
  genCoast, genMountain, setAniso: a => { ANISO = a; } };
})(typeof self !== 'undefined' ? self : this);
