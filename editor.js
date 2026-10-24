/* R29-Track level designer.
 * A top-down editor for race tracks and VS arenas. Everyone who opens the same level link edits it together:
 * edits travel over a Supabase realtime channel (broadcast), cursors and selections too, and the level is saved
 * to the `levels` table (see supabase-levels.sql). Without the table it still works, saving in this browser.
 * World coordinates match the game: metres, x east, z south (north is up on screen).
 */
(function () {
'use strict';
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
const rid = (n = 8) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const SB_URL = 'https://gpgjkvvmzwrzddnoxhbr.supabase.co', SB_KEY = 'sb_publishable_9PbCgyuQJ5yNkuz5PVFMSQ_bm1BrAo3';
let sb = null;
try { if (window.supabase) sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, realtime: { params: { eventsPerSecond: 25 } } }); } catch (e) { sb = null; }
const me = { id: rid(10), name: '', color: ['#ff5147', '#55a6ff', '#3ddc84', '#ffb21f', '#b05ce6', '#f26bb5', '#25c6d9', '#ff8a2b'][Math.floor(Math.random() * 8)] };
try { me.name = cleanName(localStorage.getItem('r29.ed.name') || JSON.parse(localStorage.getItem('r29track.v1') || '{}').name || ''); } catch (e) {}
const myName = () => me.name || 'Builder';
let toastT = 0;
function toast(msg, sec = 2.2) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, sec * 1000); }

/* ---------- object types ---------- */
// shape: 'rect' (w across, l along the heading) or 'circ' (r). snap: rotation snaps to 90°.
const TYPES = {
  ramp:      { label: 'Ramp', shape: 'rect', snap: true, d: { w: 6, l: 8, h: 1.5 }, color: '#e8a21f', props: [['l', 'Length', 2, 60], ['w', 'Width', 2, 40], ['h', 'Height', 0.3, 8]] },
  tabletop:  { label: 'Big jump', shape: 'rect', snap: true, d: { w: 12, l: 50, h: 3 }, color: '#d98a12', props: [['l', 'Length', 12, 150], ['w', 'Width', 4, 40], ['h', 'Height', 0.5, 10]] },
  boost:     { label: 'Boost pad', shape: 'rect', d: { w: 5, l: 8 }, color: '#2f6fe0', props: [['l', 'Length', 3, 30], ['w', 'Width', 2, 20]] },
  wall:      { label: 'Wall', shape: 'rect', d: { w: 1, l: 20, h: 2.5 }, color: '#8a9096', props: [['l', 'Length', 1, 400], ['h', 'Height', 0.5, 20]] },
  container: { label: 'Container', shape: 'rect', snap: true, d: { w: 2.45, l: 12.2, stack: 1 }, color: '#c0563a', props: [['stack', 'Stacked', 1, 3, 1]] },
  building:  { label: 'Building', shape: 'rect', snap: true, d: { w: 20, l: 20, h: 15 }, color: '#7d8a96', props: [['w', 'Width', 4, 200], ['l', 'Depth', 4, 200], ['h', 'Height', 2, 200]] },
  pillar:    { label: 'Pillar', shape: 'circ', d: { r: 1.2, h: 7 }, color: '#a3a9ae', props: [['r', 'Radius', 0.3, 8], ['h', 'Height', 1, 40]] },
  tree:      { label: 'Tree', shape: 'circ', d: { s: 1 }, color: '#3f8a3a', props: [['s', 'Size', 0.4, 3]] },
  rock:      { label: 'Rock', shape: 'circ', d: { s: 2 }, color: '#8d8273', props: [['s', 'Size', 0.5, 8]] },
  itembox:   { label: 'Item box', shape: 'circ', d: {}, color: '#c45cff', props: [] },
  spawn:     { label: 'Spawn', shape: 'rect', d: { w: 2, l: 4.5 }, color: '#ffb21f', props: [] },
};
const radiusOf = o => o.type === 'pillar' ? o.r : o.type === 'tree' ? 2.6 * o.s : o.type === 'rock' ? o.s : 1;
function sanitizeObj(o) {
  if (!o || typeof o !== 'object' || !TYPES[o.type] || typeof o.id !== 'string') return null;
  const T = TYPES[o.type], out = { id: o.id.slice(0, 16), type: o.type };
  const n = (v, d, a, b) => clamp(Number.isFinite(+v) ? +v : d, a, b);
  out.x = Math.round(n(o.x, 0, -1500, 1500) * 10) / 10; out.z = Math.round(n(o.z, 0, -1500, 1500) * 10) / 10;
  out.rot = ((Math.round(n(o.rot, 0, -3600, 3600)) % 360) + 360) % 360; if (T.snap) out.rot = Math.round(out.rot / 90) * 90 % 360;
  for (const k in T.d) out[k] = n(o[k], T.d[k], 0.1, 400);
  for (const [k, , a, b, step] of T.props) { out[k] = clamp(out[k], a, b); if (step) out[k] = Math.round(out[k]); }
  if (o.type === 'wall') out.w = 1;
  return out;
}

/* ---------- level state ---------- */
const DEF = { v: 1, name: 'Untitled', mode: 'race', theme: 'grass', size: 400, border: true, roadWidth: 12, laps: 3, road: [], objects: {} };
let L = null, levelId = null, dbOk = null, chan = null, joined = false, dirty = false, lastRemote = 0;
const peers = new Map(); // id -> { name, color, x, z, sel, t }
function blankLevel(mode) {
  const lv = JSON.parse(JSON.stringify(DEF)); lv.mode = mode; lv.name = mode === 'arena' ? 'New arena' : 'New track';
  if (mode === 'race') { lv.road = [[-180, -60], [-60, -95], [90, -95], [190, -40], [200, 60], [100, 100], [-60, 100], [-190, 60]]; }
  else { lv.size = 150; lv.road = []; for (const [k, [x, z]] of [[-110, -110], [110, 110], [110, -110], [-110, 110]].entries()) { const o = { id: rid(6), type: 'spawn', x, z, rot: Math.round(Math.atan2(-x, z) * 180 / Math.PI) }; lv.objects[o.id] = sanitizeObj(o); }
    const c = sanitizeObj({ id: rid(6), type: 'tabletop', x: 0, z: 0, rot: 90 }); lv.objects[c.id] = c; }
  return lv;
}
function sanitizeLevel(raw) {
  const lv = JSON.parse(JSON.stringify(DEF)), r = raw || {};
  lv.name = String(r.name || 'Untitled').slice(0, 40); lv.mode = r.mode === 'arena' ? 'arena' : 'race';
  lv.theme = ['grass', 'desert', 'beach', 'snow', 'concrete'].includes(r.theme) ? r.theme : 'grass';
  lv.size = clamp(+r.size || 400, 100, 1500); lv.border = r.border !== false;
  lv.roadWidth = clamp(+r.roadWidth || 12, 6, 30); lv.laps = clamp(Math.round(+r.laps || 3), 1, 20);
  lv.road = (Array.isArray(r.road) ? r.road : []).slice(0, 300).filter(p => Array.isArray(p) && p.every(Number.isFinite)).map(([x, z]) => [clamp(Math.round(x), -1500, 1500), clamp(Math.round(z), -1500, 1500)]);
  const objs = Array.isArray(r.objects) ? r.objects : Object.values(r.objects || {});
  for (const o of objs.slice(0, 2000)) { const s = sanitizeObj(o); if (s) lv.objects[s.id] = s; }
  return lv;
}
const exportLevel = () => Object.assign({}, L, { objects: Object.values(L.objects) });

/* ---------- edits: apply locally, broadcast, remember for undo ---------- */
const undo = [];
function apply(op, remote) {
  if (op.t === 'obj') { const s = sanitizeObj(op.o); if (!s) return; L.objects[s.id] = s; }
  else if (op.t === 'del') { delete L.objects[op.id]; if (sel && sel.id === op.id) select(null); }
  else if (op.t === 'road') { L.road = sanitizeLevel({ road: op.pts }).road; if (sel && sel.road != null && sel.road >= L.road.length) select(null); }
  else if (op.t === 'meta') {
    const k = op.k, v = op.v;
    if (k === 'name') L.name = String(v || 'Untitled').slice(0, 40);
    if (k === 'mode') L.mode = v === 'arena' ? 'arena' : 'race';
    if (k === 'theme' && ['grass', 'desert', 'beach', 'snow', 'concrete'].includes(v)) L.theme = v;
    if (k === 'size') L.size = clamp(+v || 400, 100, 1500);
    if (k === 'border') L.border = !!v;
    if (k === 'roadWidth') L.roadWidth = clamp(+v || 12, 6, 30);
    if (k === 'laps') L.laps = clamp(Math.round(+v || 3), 1, 20);
    renderMeta();
  }
  if (remote) { lastRemote = performance.now(); if (sel && (op.t === 'obj' && op.o && op.o.id === sel.id)) renderSel(); }
  draw();
}
function inverseOf(op) {
  if (op.t === 'obj') return L.objects[op.o.id] ? { t: 'obj', o: JSON.parse(JSON.stringify(L.objects[op.o.id])) } : { t: 'del', id: op.o.id };
  if (op.t === 'del') return L.objects[op.id] ? { t: 'obj', o: JSON.parse(JSON.stringify(L.objects[op.id])) } : null;
  if (op.t === 'road') return { t: 'road', pts: L.road.map(p => p.slice()) };
  if (op.t === 'meta') return { t: 'meta', k: op.k, v: L[op.k] };
  return null;
}
function edit(op, opts = {}) { // a local edit
  if (!opts.noUndo) { const inv = inverseOf(op); if (inv) { if (opts.group && undo.length && undo[undo.length - 1].group === opts.group) {} else undo.push({ inv: [inv], group: opts.group || null }); if (undo.length > 200) undo.shift(); } }
  apply(op, false);
  send('op', op, opts.live);
  dirty = true; saveSoon();
}
function doUndo() { const u = undo.pop(); if (!u) return toast('Nothing to undo', 1); for (const op of u.inv) { apply(op, false); send('op', op); } dirty = true; saveSoon(); renderSel(); }

/* ---------- realtime ---------- */
let lastSend = 0, pendingLive = null;
function send(event, payload, live) {
  if (!chan || !joined) return;
  if (live) { // drags: at most ~15 per second, always finish with the last state
    const t = performance.now(); pendingLive = payload;
    if (t - lastSend < 66) { clearTimeout(send.tm); send.tm = setTimeout(() => { if (pendingLive) { chan.send({ type: 'broadcast', event: 'op', payload: { from: me.id, op: pendingLive } }).catch(() => {}); pendingLive = null; lastSend = performance.now(); } }, 70); return; }
    lastSend = t; pendingLive = null;
  }
  chan.send({ type: 'broadcast', event, payload: event === 'op' ? { from: me.id, op: payload } : Object.assign({ from: me.id }, payload) }).catch(() => {});
}
let gotFull = false;
function joinRealtime() {
  if (!sb) { setStatus('Offline: edits stay on this computer', 'warn'); return; }
  chan = sb.channel('r29lvl:' + levelId, { config: { broadcast: { self: false, ack: false }, presence: { key: me.id } } });
  chan.on('broadcast', { event: 'op' }, ({ payload: p }) => { if (p && p.from !== me.id && p.op) apply(p.op, true); });
  chan.on('broadcast', { event: 'cur' }, ({ payload: p }) => {
    if (!p || p.from === me.id || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
    const q = peers.get(p.from) || {}; peers.set(p.from, Object.assign(q, { x: p.x, z: p.z, sel: typeof p.sel === 'string' ? p.sel : null, t: performance.now() })); draw();
  });
  chan.on('broadcast', { event: 'hello' }, ({ payload: p }) => { // a newcomer: one of us sends them the level
    if (!p || p.from === me.id) return;
    setTimeout(() => send('full', { to: p.from, level: exportLevel() }), 80 + Math.random() * 400);
  });
  chan.on('broadcast', { event: 'full' }, ({ payload: p }) => {
    if (!p || !p.level) return;
    if (p.to !== '*' && (p.to !== me.id || gotFull || dirty)) return;
    gotFull = true; L = sanitizeLevel(p.level); renderMeta(); draw(); toast('Synced with the people editing now', 1.6);
  });
  chan.on('presence', { event: 'sync' }, () => {
    const st = chan.presenceState(), seen = new Set();
    for (const k in st) { const m = st[k][st[k].length - 1]; if (!m || m.id === me.id) continue; seen.add(m.id); const q = peers.get(m.id) || {}; peers.set(m.id, Object.assign(q, { name: cleanName(m.name) || 'Builder', color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#888' })); }
    for (const id of [...peers.keys()]) if (!seen.has(id)) peers.delete(id);
    renderPeople(); draw();
  });
  chan.subscribe(status => {
    if (status === 'SUBSCRIBED') { joined = true; chan.track({ id: me.id, name: myName(), color: me.color }).catch(() => {}); send('hello', {}); renderStatus(); }
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { joined = false; setStatus('Reconnecting…', 'warn'); }
  });
}
function renderPeople() {
  const list = [{ name: myName(), color: me.color, me: true }].concat([...peers.values()].filter(p => p.name));
  $('people').innerHTML = list.map(p => `<span style="background:${p.color}" title="${esc(p.name)}${p.me ? ' (you)' : ''}">${esc((p.name[0] || '?').toUpperCase())}</span>`).join('');
}

/* ---------- saving ---------- */
let saveTm = 0, saving = false, savedAt = 0;
function setStatus(t, cls) { const e = $('status'); e.textContent = t; e.className = cls || ''; }
function renderStatus() {
  const n = peers.size, who = n ? ` · ${n + 1} editing` : '';
  if (saving) setStatus('Saving…' + who);
  else if (dbOk === false) setStatus('Saved in this browser only (database not set up)' + who, 'warn');
  else if (savedAt) setStatus('All changes saved' + who, 'ok');
  else setStatus((joined ? 'Live' : 'Connecting…') + who);
}
function saveSoon() { clearTimeout(saveTm); saveTm = setTimeout(saveNow, 1200); setStatus('Unsaved changes…'); }
async function saveNow() {
  const data = exportLevel();
  try { localStorage.setItem('r29.ed.level.' + levelId, JSON.stringify({ id: levelId, name: L.name, author: myName(), data, updated_at: new Date().toISOString() })); rememberLocal(levelId, L.name, L.mode); } catch (e) {}
  if (sb && dbOk !== false) {
    saving = true; renderStatus();
    const { error } = await sb.from('levels').upsert({ id: levelId, name: L.name || 'Untitled', author: myName(), mode: L.mode, data, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    saving = false;
    if (error) { if (/relation|does not exist|schema cache|not find the table/i.test(error.message || '')) dbOk = false; else toast('Save failed: ' + error.message, 3); }
    else { dbOk = true; savedAt = Date.now(); }
  } else savedAt = Date.now();
  dirty = false; renderStatus();
}
function rememberLocal(id, name, mode) {
  try { const l = JSON.parse(localStorage.getItem('r29.ed.mine') || '[]').filter(x => x.id !== id); l.unshift({ id, name, mode, t: Date.now() }); localStorage.setItem('r29.ed.mine', JSON.stringify(l.slice(0, 50))); } catch (e) {}
}
async function loadLevel(id) {
  if (sb) {
    const { data, error } = await sb.from('levels').select('id,name,author,data,updated_at').eq('id', id).maybeSingle();
    if (error) { if (/relation|does not exist|schema cache|not find the table/i.test(error.message || '')) dbOk = false; }
    else { dbOk = true; if (data) return data.data; }
  }
  try { const loc = JSON.parse(localStorage.getItem('r29.ed.level.' + id) || 'null'); if (loc) return loc.data; } catch (e) {}
  return null;
}

/* ---------- view ---------- */
const cv = $('cv'), ctx = cv.getContext('2d');
const view = { x: 0, z: 0, s: 1.4 }; // centre (m) and pixels per metre
let W = 0, H = 0, dpr = 1;
function resize() { const r = cv.getBoundingClientRect(); dpr = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height; cv.width = W * dpr; cv.height = H * dpr; draw(); }
const toScr = (x, z) => [(x - view.x) * view.s + W / 2, (z - view.z) * view.s + H / 2];
const toWorld = (sx, sy) => [(sx - W / 2) / view.s + view.x, (sy - H / 2) / view.s + view.z];
function fit() { const s = L.size; view.x = 0; view.z = 0; view.s = clamp(Math.min(W, H) / (s * 2 + 40), 0.1, 12); draw(); }
const H2R = d => d * Math.PI / 180;
function corners(o) { // rotated rectangle corners in world space
  const T = TYPES[o.type], h = H2R(o.rot), fx = Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = Math.sin(h), l = o.l ?? T.d.l, w = o.w ?? T.d.w;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [o.x + fx * l / 2 * a + rx * w / 2 * b, o.z + fz * l / 2 * a + rz * w / 2 * b]);
}
function hitObj(o, x, z, pad = 0) {
  const T = TYPES[o.type];
  if (T.shape === 'circ') return Math.hypot(x - o.x, z - o.z) < radiusOf(o) + pad + 1;
  const h = H2R(o.rot), dx = x - o.x, dz = z - o.z, f = dx * Math.sin(h) - dz * Math.cos(h), r = dx * Math.cos(h) + dz * Math.sin(h);
  return Math.abs(f) < (o.l ?? T.d.l) / 2 + pad && Math.abs(r) < (o.w ?? T.d.w) / 2 + pad + (o.type === 'wall' ? 0.8 : 0);
}
function roadSpline(pts) { // closed Catmull-Rom, same shape the game builds
  const out = [], n = pts.length; if (n < 3) return pts.slice();
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const seg = Math.max(4, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 4));
    for (let k = 0; k < seg; k++) { const t = k / seg, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map(j => 0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3))); }
  }
  return out;
}
const GROUND = { grass: '#3f6b2b', desert: '#b98b55', beach: '#cdb07c', snow: '#d9dfe3', concrete: '#7f817d' };
function arrow(x, z, h, len, col, width = 2) {
  const [sx, sy] = toScr(x, z), fx = Math.sin(h), fz = -Math.cos(h), L2 = len * view.s;
  ctx.strokeStyle = col; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(sx - fx * L2 / 2, sy - fz * L2 / 2); ctx.lineTo(sx + fx * L2 / 2, sy + fz * L2 / 2);
  const hx = sx + fx * L2 / 2, hy = sy + fz * L2 / 2, a = 0.5, k = Math.min(10, L2 * 0.35);
  ctx.moveTo(hx, hy); ctx.lineTo(hx - k * Math.sin(h + a), hy + k * Math.cos(h + a)); ctx.moveTo(hx, hy); ctx.lineTo(hx - k * Math.sin(h - a), hy + k * Math.cos(h - a)); ctx.stroke();
}
let raf = 0;
function draw() { if (!raf) raf = requestAnimationFrame(draw2); }
function draw2() {
  raf = 0; if (!L) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  // ground and grid
  const S = L.size, [ax, ay] = toScr(-S, -S), [bx, by] = toScr(S, S);
  ctx.fillStyle = '#0a0f12'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = GROUND[L.theme] || GROUND.grass; ctx.fillRect(ax, ay, bx - ax, by - ay);
  const step = view.s > 3 ? 5 : view.s > 0.8 ? 10 : view.s > 0.3 ? 50 : 100;
  ctx.lineWidth = 1;
  for (let g = Math.ceil(-S / step) * step; g <= S; g += step) {
    ctx.strokeStyle = g % (step * 5) === 0 ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.12)';
    const [gx] = toScr(g, 0), [, gy] = toScr(0, g);
    ctx.beginPath(); ctx.moveTo(gx, ay); ctx.lineTo(gx, by); ctx.moveTo(ax, gy); ctx.lineTo(bx, gy); ctx.stroke();
  }
  if (L.border) { ctx.strokeStyle = '#c23b2e'; ctx.lineWidth = Math.max(2, 2 * view.s); ctx.strokeRect(ax, ay, bx - ax, by - ay); }
  // road
  if (L.road.length >= 2) {
    const sp = L.road.length >= 3 ? roadSpline(L.road) : L.road;
    const path = () => { ctx.beginPath(); sp.forEach(([x, z], i) => { const [sx, sy] = toScr(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); if (L.road.length >= 3) ctx.closePath(); };
    ctx.lineJoin = ctx.lineCap = 'round';
    path(); ctx.strokeStyle = '#e8e8e2'; ctx.lineWidth = (L.roadWidth + 2.4) * view.s; ctx.stroke();
    path(); ctx.strokeStyle = '#4c5154'; ctx.lineWidth = L.roadWidth * view.s; ctx.stroke();
    path(); ctx.setLineDash([3 * view.s, 5 * view.s]); ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = Math.max(1, 0.2 * view.s); ctx.stroke(); ctx.setLineDash([]);
    if (L.road.length >= 3) { // start line and direction
      const [x0, z0] = sp[0], [x1, z1] = sp[Math.min(3, sp.length - 1)], h = Math.atan2(x1 - x0, -(z1 - z0));
      const [sx, sy] = toScr(x0, z0), rx = Math.cos(h), rz = Math.sin(h), w2 = L.roadWidth / 2 * view.s;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, 1.6 * view.s); ctx.beginPath(); ctx.moveTo(sx - rx * w2, sy - rz * w2); ctx.lineTo(sx + rx * w2, sy + rz * w2); ctx.stroke();
      arrow(x0 + Math.sin(h) * 14, z0 - Math.cos(h) * 14, h, 14, '#ffb21f', 3);
    }
  }
  // objects
  const objs = Object.values(L.objects);
  const order = { boost: 0, ramp: 1, tabletop: 1, spawn: 2, itembox: 3, wall: 4, container: 4, building: 5, rock: 5, pillar: 6, tree: 7 };
  objs.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  for (const o of objs) drawObj(o);
  // road handles
  if (tool === 'road' || (sel && sel.road != null)) L.road.forEach(([x, z], i) => {
    const [sx, sy] = toScr(x, z), on = sel && sel.road === i;
    ctx.fillStyle = on ? '#ffb21f' : '#fff'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, on ? 8 : 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (i === 0) { ctx.fillStyle = '#111'; ctx.font = '700 9px Chakra Petch, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('S', sx, sy + 0.5); }
  });
  // selection
  if (sel && sel.id && L.objects[sel.id]) outline(L.objects[sel.id], '#ffb21f', 2.5);
  // other people
  const tNow = performance.now();
  for (const [, p] of peers) {
    if (p.sel && L.objects[p.sel]) outline(L.objects[p.sel], p.color, 2, p.name);
    if (p.x == null || tNow - (p.t || 0) > 15000) continue;
    const [sx, sy] = toScr(p.x, p.z);
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + 4, sy + 15); ctx.lineTo(sx + 8, sy + 9); ctx.lineTo(sx + 15, sy + 8); ctx.closePath(); ctx.fill();
    ctx.font = '600 11px Chakra Petch, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const tw = ctx.measureText(p.name || '').width; ctx.fillStyle = p.color; ctx.fillRect(sx + 12, sy + 14, tw + 8, 16); ctx.fillStyle = '#111'; ctx.fillText(p.name || '', sx + 16, sy + 16);
  }
  // ghost of the tool under the cursor
  if (hover && TYPES[tool]) { ctx.globalAlpha = 0.45; drawObj(sanitizeObj(Object.assign({ id: 'ghost', type: tool, x: hover[0], z: hover[1], rot: lastRot[tool] || 0 }, TYPES[tool].d))); ctx.globalAlpha = 1; }
}
function polyPath(pts) { ctx.beginPath(); pts.forEach(([x, z], i) => { const [sx, sy] = toScr(x, z); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }); ctx.closePath(); }
function drawObj(o) {
  if (!o) return;
  const T = TYPES[o.type], h = H2R(o.rot), [sx, sy] = toScr(o.x, o.z);
  if (T.shape === 'circ') {
    const r = radiusOf(o) * view.s;
    if (o.type === 'itembox') { const k = Math.max(5, 1.3 * view.s); ctx.save(); ctx.translate(sx, sy); ctx.rotate(0.6); const g = ctx.createLinearGradient(-k, -k, k, k); g.addColorStop(0, '#ff5ab4'); g.addColorStop(0.5, '#5ad1ff'); g.addColorStop(1, '#ffe14a'); ctx.fillStyle = g; ctx.fillRect(-k, -k, k * 2, k * 2); ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.strokeRect(-k, -k, k * 2, k * 2); ctx.fillStyle = '#111'; ctx.font = `700 ${Math.round(k * 1.3)}px Chakra Petch, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('?', 0, 1); ctx.restore(); return; }
    ctx.fillStyle = T.color; ctx.beginPath(); ctx.arc(sx, sy, Math.max(3, r), 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1.5; ctx.stroke();
    if (o.type === 'tree') { ctx.fillStyle = '#6b4a2a'; ctx.beginPath(); ctx.arc(sx, sy, Math.max(1.5, r * 0.18), 0, Math.PI * 2); ctx.fill(); }
    return;
  }
  const cs = corners(o);
  if (o.type === 'boost') {
    polyPath(cs); ctx.fillStyle = '#123a8c'; ctx.fill();
    const l = o.l, n = Math.max(1, Math.round(l / 4));
    for (let k = 0; k < n; k++) arrow(o.x + Math.sin(h) * (-l / 2 + (k + 0.5) * l / n), o.z - Math.cos(h) * (-l / 2 + (k + 0.5) * l / n), h, Math.min(3, l / n * 0.8), k % 2 ? '#ff7a1f' : '#ffd23a', Math.max(1.5, 0.5 * view.s));
    return;
  }
  if (o.type === 'ramp' || o.type === 'tabletop') {
    polyPath(cs); ctx.fillStyle = T.color; ctx.fill(); ctx.strokeStyle = '#1d2226'; ctx.lineWidth = 1.5; ctx.stroke();
    if (o.type === 'tabletop') { // show the flat top
      const up = o.l * 0.36, top = o.l * 0.28, fx = Math.sin(h), fz = -Math.cos(h);
      const t = sanitizeObj({ id: 't', type: 'ramp', x: o.x + fx * (-o.l / 2 + up + top / 2), z: o.z + fz * (-o.l / 2 + up + top / 2), rot: o.rot, l: top, w: o.w, h: 1 });
      polyPath(corners(t)); ctx.fillStyle = '#f0c35a'; ctx.fill();
    }
    arrow(o.x, o.z, h, Math.min(o.l * 0.7, 30), '#1d2226', Math.max(2, 0.4 * view.s));
    return;
  }
  if (o.type === 'spawn') { polyPath(cs); ctx.fillStyle = 'rgba(255,178,31,0.35)'; ctx.fill(); ctx.strokeStyle = '#ffb21f'; ctx.lineWidth = 2; ctx.stroke(); arrow(o.x, o.z, h, 6, '#ffb21f', 2.5); return; }
  polyPath(cs);
  let col = T.color; if (o.type === 'container') col = ['#b8432e', '#2e6fb8', '#3f8a4a', '#d9a21f', '#7a4fa8', '#c96a2a'][o.id.charCodeAt(0) % 6];
  ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
  if (o.type === 'container' && o.stack > 1 && view.s > 1.5) { ctx.fillStyle = '#fff'; ctx.font = '700 11px Chakra Petch, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('×' + o.stack, sx, sy); }
  if (o.type === 'building' && view.s > 1) { ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = '600 11px IBM Plex Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(Math.round(o.h) + ' m', sx, sy); }
}
function outline(o, col, wdt, label) {
  const T = TYPES[o.type]; ctx.strokeStyle = col; ctx.lineWidth = wdt; ctx.setLineDash([6, 4]);
  if (T.shape === 'circ') { const [sx, sy] = toScr(o.x, o.z); ctx.beginPath(); ctx.arc(sx, sy, Math.max(6, (radiusOf(o) + 1) * view.s), 0, Math.PI * 2); ctx.stroke(); }
  else { const cs = corners(o).map(([x, z], i, a) => { const cx = o.x, cz = o.z, d = Math.hypot(x - cx, z - cz) || 1, pad = 1.2 / view.s * 3; return [x + (x - cx) / d * pad, z + (z - cz) / d * pad]; }); polyPath(cs); ctx.stroke(); }
  ctx.setLineDash([]);
  if (label) { const [sx, sy] = toScr(o.x, o.z); ctx.font = '600 10px Chakra Petch, sans-serif'; ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(label, sx, sy - Math.max(10, 6 * view.s)); }
}

/* ---------- tools and input ---------- */
const ICON = {
  select: '<path d="M5 3l14 9-6 1.5L10 20z" fill="currentColor"/>',
  road: '<path d="M4 20C7 10 10 6 20 4" stroke="currentColor" stroke-width="4" fill="none" stroke-linecap="round"/><circle cx="4" cy="20" r="2.2" fill="#fff"/><circle cx="20" cy="4" r="2.2" fill="#fff"/>',
  ramp: '<path d="M2 19h20L22 9z" fill="currentColor"/>',
  tabletop: '<path d="M1 19l6-8h10l6 8z" fill="currentColor"/>',
  boost: '<path d="M6 14l6-6 6 6M6 20l6-6 6 6" stroke="currentColor" stroke-width="2.6" fill="none"/>',
  wall: '<rect x="2" y="9" width="20" height="6" fill="currentColor"/>',
  container: '<rect x="2" y="7" width="20" height="10" rx="1" fill="currentColor"/><path d="M6 8v8M10 8v8M14 8v8M18 8v8" stroke="#111" stroke-width="1"/>',
  building: '<path d="M5 21V4h9v4h5v13z" fill="currentColor"/><path d="M8 7h2M8 11h2M8 15h2M16 12h1M16 16h1" stroke="#111" stroke-width="1.6"/>',
  pillar: '<rect x="9" y="3" width="6" height="18" rx="2" fill="currentColor"/>',
  tree: '<path d="M12 2l7 12H5z" fill="currentColor"/><rect x="10.5" y="14" width="3" height="7" fill="currentColor"/>',
  rock: '<path d="M3 18l3-8 6-4 7 3 2 9z" fill="currentColor"/>',
  itembox: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/><text x="12" y="16.5" font-size="11" text-anchor="middle" fill="#111" font-weight="700">?</text>',
  spawn: '<path d="M12 3l6 14-6-3-6 3z" fill="currentColor"/>',
  erase: '<path d="M4 15l8-8 7 7-5 5H8z" fill="currentColor"/><path d="M3 21h18" stroke="currentColor" stroke-width="2"/>',
};
const TOOLS = [['select', 'Select', 'V'], ['road', 'Road', 'R'], null, ['ramp', 'Ramp', '1'], ['tabletop', 'Big jump', '2'], ['boost', 'Boost', '3'], ['itembox', 'Item box', '4'], ['spawn', 'Spawn', '5'], null,
  ['wall', 'Wall', '6'], ['container', 'Container', '7'], ['building', 'Building', '8'], ['pillar', 'Pillar', '9'], ['tree', 'Tree', 'T'], ['rock', 'Rock', 'K'], null, ['erase', 'Erase', 'X']];
let tool = 'select', sel = null, hover = null, drag = null, spaceDown = false;
const lastRot = {};
function setTool(t) {
  tool = t; document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  const hints = { select: 'Click to select, drag to move. Drag empty space to pan.', road: 'Click to add a road point (it joins the nearest part of the loop). Drag points to reshape. Right-click a point to delete it.', erase: 'Click anything to delete it.' };
  $('hint').textContent = hints[t] || `Click to place a ${TYPES[t].label.toLowerCase()}. Q / E rotate before placing. Esc to stop.`;
  cv.style.cursor = t === 'select' ? 'default' : t === 'erase' ? 'not-allowed' : 'crosshair';
  draw();
}
function buildTools() {
  $('tools').innerHTML = TOOLS.map(t => t ? `<button type="button" data-t="${t[0]}" title="${t[1]} (${t[2]})"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[t[0]]}</svg>${t[1]}<small>${t[2]}</small></button>` : '<hr>').join('');
  $('tools').querySelectorAll('button').forEach(b => b.onclick = () => setTool(b.dataset.t));
}
function pick(x, z) {
  const tol = 8 / view.s;
  for (let i = 0; i < L.road.length; i++) if (Math.hypot(L.road[i][0] - x, L.road[i][1] - z) < tol && (tool === 'road' || tool === 'erase' || tool === 'select')) return { road: i };
  const objs = Object.values(L.objects), order = { tree: 0, pillar: 0, itembox: 0, spawn: 1, rock: 1, building: 2, container: 2, wall: 2, boost: 3, ramp: 3, tabletop: 4 };
  objs.sort((a, b) => (order[a.type] ?? 5) - (order[b.type] ?? 5));
  for (const o of objs) if (hitObj(o, x, z, tol * 0.3)) return { id: o.id };
  return null;
}
function select(s) { sel = s; renderSel(); send('cur', { x: cursor[0], z: cursor[1], sel: sel && sel.id || null }); draw(); }
let cursor = [0, 0], curT = 0;
function sendCursor() { const t = performance.now(); if (t - curT < 70) return; curT = t; send('cur', { x: Math.round(cursor[0] * 10) / 10, z: Math.round(cursor[1] * 10) / 10, sel: sel && sel.id || null }); }
const snap = v => Math.round(v);
function nearestSeg_unused(x, z) { // index to insert a road point at, if (x,z) is near the road
  const n = L.road.length; if (n < 2) return -1;
  let best = -1, bd = (L.roadWidth / 2 + 6);
  for (let i = 0; i < n; i++) {
    if (n < 3 && i === n - 1) break;
    const [ax, az] = L.road[i], [bx, bz] = L.road[(i + 1) % n], ex = bx - ax, ez = bz - az, t = clamp(((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1), 0, 1), d = Math.hypot(ax + ex * t - x, az + ez * t - z);
    if (d < bd) { bd = d; best = i + 1; }
  }
  return best;
}
function onDown(e) {
  cv.setPointerCapture(e.pointerId);
  const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, [x, z] = toWorld(sx, sy);
  if (e.button === 1 || spaceDown) { drag = { pan: true, sx, sy, vx: view.x, vz: view.z }; return; }
  const hit = pick(x, z);
  if (e.button === 2) { if (hit && hit.road != null) { const pts = L.road.filter((_, i) => i !== hit.road); edit({ t: 'road', pts }); select(null); } return; }
  if (tool === 'erase') { if (hit && hit.id) { edit({ t: 'del', id: hit.id }); } else if (hit && hit.road != null) edit({ t: 'road', pts: L.road.filter((_, i) => i !== hit.road) }); return; }
  if (tool === 'road') {
    if (hit && hit.road != null) { select(hit); drag = { road: hit.road, group: rid(5) }; return; }
    // insert into the loop where the new point adds the least length (so the track never crosses itself by accident)
    const pts = L.road.map(p => p.slice()), p = [snap(x), snap(z)], n = pts.length;
    let ins = -1;
    if (n >= 3) { let best = Infinity; for (let i = 0; i < n; i++) { const a = pts[i], b2 = pts[(i + 1) % n], cost = Math.hypot(a[0] - p[0], a[1] - p[1]) + Math.hypot(b2[0] - p[0], b2[1] - p[1]) - Math.hypot(a[0] - b2[0], a[1] - b2[1]); if (cost < best) { best = cost; ins = i + 1; } } }
    if (ins >= 0) pts.splice(ins, 0, p); else pts.push(p);
    edit({ t: 'road', pts }); const idx = ins >= 0 ? ins : pts.length - 1; select({ road: idx }); drag = { road: idx, group: rid(5) }; return;
  }
  if (TYPES[tool]) {
    const o = sanitizeObj(Object.assign({ id: rid(6), type: tool, x: snap(x), z: snap(z), rot: lastRot[tool] || 0 }, TYPES[tool].d));
    edit({ t: 'obj', o }); select({ id: o.id }); return;
  }
  // select tool
  if (hit) { select(hit); if (hit.id) { const o = L.objects[hit.id]; drag = { id: hit.id, dx: o.x - x, dz: o.z - z, group: rid(5), moved: false }; } else drag = { road: hit.road, group: rid(5) }; }
  else { select(null); drag = { pan: true, sx, sy, vx: view.x, vz: view.z }; }
}
function onMove(e) {
  const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, [x, z] = toWorld(sx, sy);
  cursor = [x, z]; sendCursor();
  hover = TYPES[tool] ? [snap(x), snap(z)] : null;
  if (!drag) { draw(); return; }
  if (drag.pan) { view.x = drag.vx - (sx - drag.sx) / view.s; view.z = drag.vz - (sy - drag.sy) / view.s; draw(); return; }
  if (drag.id && L.objects[drag.id]) { const o = Object.assign({}, L.objects[drag.id], { x: snap(x + drag.dx), z: snap(z + drag.dz) }); drag.moved = true; edit({ t: 'obj', o }, { group: drag.group, live: true }); renderSel(); }
  if (drag.road != null && L.road[drag.road]) { const pts = L.road.map(p => p.slice()); pts[drag.road] = [snap(x), snap(z)]; edit({ t: 'road', pts }, { group: drag.group, live: true }); }
}
function onUp() {
  if (drag && !drag.pan) { // make sure everyone has the final position
    if (drag.id && L.objects[drag.id]) send('op', { t: 'obj', o: L.objects[drag.id] });
    if (drag.road != null) send('op', { t: 'road', pts: L.road });
  }
  drag = null;
}
function zoomAt(f, sx = W / 2, sy = H / 2) { const [wx, wz] = toWorld(sx, sy); view.s = clamp(view.s * f, 0.08, 14); const [nx, nz] = toWorld(sx, sy); view.x += wx - nx; view.z += wz - nz; draw(); }
function rotateSel(dir) {
  if (TYPES[tool]) { const st = TYPES[tool].snap ? 90 : 15; lastRot[tool] = ((lastRot[tool] || 0) + dir * st + 360) % 360; draw(); return; }
  if (!sel || !sel.id || !L.objects[sel.id]) return;
  const o = L.objects[sel.id], st = TYPES[o.type].snap ? 90 : 15;
  edit({ t: 'obj', o: Object.assign({}, o, { rot: (o.rot + dir * st + 360) % 360 }) }); renderSel();
}
function duplicateSel() {
  if (!sel || !sel.id || !L.objects[sel.id]) return;
  const o = Object.assign({}, L.objects[sel.id], { id: rid(6), x: L.objects[sel.id].x + 6, z: L.objects[sel.id].z + 6 });
  edit({ t: 'obj', o }); select({ id: o.id });
}
function deleteSel() {
  if (!sel) return;
  if (sel.id) edit({ t: 'del', id: sel.id });
  else if (sel.road != null) edit({ t: 'road', pts: L.road.filter((_, i) => i !== sel.road) });
  select(null);
}
function bindInput() {
  cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp); cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('pointerleave', () => { hover = null; draw(); });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  $('zIn').onclick = () => zoomAt(1.3); $('zOut').onclick = () => zoomAt(1 / 1.3); $('zFit').onclick = fit;
  addEventListener('keydown', e => {
    if (e.target.matches('input,select,textarea')) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { spaceDown = true; cv.style.cursor = 'grab'; e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicateSel(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); return; }
    if (k === 'escape') { setTool('select'); select(null); return; }
    if (k === 'q') rotateSel(-1); if (k === 'e') rotateSel(1);
    const t = TOOLS.find(t2 => t2 && t2[2].toLowerCase() === k); if (t) setTool(t[0]);
  });
  addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; setTool(tool); } });
  addEventListener('resize', resize);
}

/* ---------- side panel ---------- */
function renderMeta() {
  if (!L) return;
  if (document.activeElement !== $('lvlName')) $('lvlName').value = L.name;
  $('mMode').value = L.mode; $('mTheme').value = L.theme; $('mBorder').value = L.border ? '1' : '0';
  const sizes = [...$('mSize').options].map(o => +o.value); if (!sizes.includes(L.size)) $('mSize').insertAdjacentHTML('beforeend', `<option value="${L.size}">${L.size * 2} × ${L.size * 2}</option>`);
  $('mSize').value = String(L.size);
  if (document.activeElement !== $('mRoadW')) $('mRoadW').value = L.roadWidth;
  if (document.activeElement !== $('mLaps')) $('mLaps').value = L.laps;
  $('mLaps').disabled = L.mode !== 'race';
  document.title = `${L.name} · R29 Level Designer`;
}
function renderSel() {
  const box = $('selBox');
  if (!sel) { box.innerHTML = `<p class="note">${L.mode === 'race' ? 'Race tracks need a road loop (3+ points). The S point is the start line; the arrow shows the driving direction.' : 'Arenas use Spawn points (yellow arrows) and get weapons and practice bots in the game.'}</p><p class="note">Pick a tool on the left and click the map to place it.</p>`; $('selHead').textContent = 'Tips'; return; }
  if (sel.road != null) {
    const p = L.road[sel.road]; if (!p) { box.innerHTML = ''; return; }
    $('selHead').textContent = `Road point ${sel.road + 1}${sel.road === 0 ? ' (start)' : ''}`;
    box.innerHTML = `<div class="grid2"><label>X / Z</label><span style="font-family:var(--mono);font-size:12px">${p[0]}, ${p[1]}</span></div>
      <div class="btns"><button type="button" id="rpStart">Make this the start</button><button type="button" id="rpRev">Reverse direction</button><button type="button" id="rpDel">Delete point</button></div>`;
    $('rpDel').onclick = deleteSel;
    $('rpStart').onclick = () => { const pts = L.road.slice(sel.road).concat(L.road.slice(0, sel.road)); edit({ t: 'road', pts }); select({ road: 0 }); };
    $('rpRev').onclick = () => { const pts = [L.road[0]].concat(L.road.slice(1).reverse()); edit({ t: 'road', pts }); };
    return;
  }
  const o = L.objects[sel.id]; if (!o) { sel = null; return renderSel(); }
  const T = TYPES[o.type];
  $('selHead').textContent = T.label;
  box.innerHTML = `<div class="grid2">
    <label for="pRot">Heading°</label><input type="number" id="pRot" step="${T.snap ? 90 : 15}" value="${o.rot}">
    ${T.props.map(([k, label, a, b, step]) => `<label for="p_${k}">${label}</label><input type="number" id="p_${k}" data-k="${k}" min="${a}" max="${b}" step="${step || 0.5}" value="${o[k]}">`).join('')}
    </div><div class="btns"><button type="button" id="pRotL">⟲ Q</button><button type="button" id="pRotR">⟳ E</button><button type="button" id="pDup">Duplicate</button><button type="button" id="pDel">Delete</button></div>`;
  const upd = patch => { const cur = L.objects[sel.id]; if (cur) edit({ t: 'obj', o: Object.assign({}, cur, patch) }); };
  $('pRot').onchange = e => { upd({ rot: +e.target.value }); renderSel(); };
  box.querySelectorAll('input[data-k]').forEach(inp => inp.onchange = e => { upd({ [inp.dataset.k]: +e.target.value }); renderSel(); });
  $('pRotL').onclick = () => rotateSel(-1); $('pRotR').onclick = () => rotateSel(1); $('pDup').onclick = duplicateSel; $('pDel').onclick = deleteSel;
}
function bindSide() {
  $('lvlName').oninput = e => edit({ t: 'meta', k: 'name', v: e.target.value || 'Untitled' }, { group: 'name', live: true });
  $('lvlName').onchange = e => { send('op', { t: 'meta', k: 'name', v: L.name }); };
  $('mMode').onchange = e => { edit({ t: 'meta', k: 'mode', v: e.target.value }); renderSel(); };
  $('mTheme').onchange = e => edit({ t: 'meta', k: 'theme', v: e.target.value });
  $('mSize').onchange = e => { edit({ t: 'meta', k: 'size', v: +e.target.value }); fit(); };
  $('mBorder').onchange = e => edit({ t: 'meta', k: 'border', v: e.target.value === '1' });
  $('mRoadW').onchange = e => edit({ t: 'meta', k: 'roadWidth', v: +e.target.value });
  $('mLaps').onchange = e => edit({ t: 'meta', k: 'laps', v: +e.target.value });
  $('shareBtn').onclick = async () => { const url = location.origin + location.pathname + '?id=' + levelId; try { await navigator.clipboard.writeText(url); toast('Invite link copied. Anyone with it can edit with you.'); } catch (e) { prompt('Copy this link:', url); } };
  $('testBtn').onclick = () => {
    if (L.mode === 'race' && L.road.length < 3) return toast('Add at least 3 road points first (Road tool)', 2.5);
    try { localStorage.setItem('r29.level.test', JSON.stringify(exportLevel())); } catch (e) {}
    saveNow(); window.open('./?level=local', 'r29test');
  };
  $('exportBtn').onclick = () => { const b = new Blob([JSON.stringify(exportLevel(), null, 1)], { type: 'application/json' }), a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = (L.name || 'level').replace(/[^\w-]+/g, '_') + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  $('importBtn2').onclick = () => $('fileIn').click();
  $('meName').value = me.name;
  $('meName').onchange = e => { me.name = cleanName(e.target.value); e.target.value = me.name; try { localStorage.setItem('r29.ed.name', me.name); } catch (er) {} if (chan && joined) chan.track({ id: me.id, name: myName(), color: me.color }).catch(() => {}); renderPeople(); };
}

/* ---------- home ---------- */
const ago = t => { const s = (Date.now() - new Date(t).getTime()) / 1000; return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
async function showHome() {
  $('home').hidden = false; $('ed').hidden = true;
  $('homeName').value = me.name; $('homeName').onchange = e => { me.name = cleanName(e.target.value); e.target.value = me.name; try { localStorage.setItem('r29.ed.name', me.name); } catch (er) {} };
  let rows = [], err = null;
  if (sb) { const r = await sb.from('levels').select('id,name,author,mode,updated_at').order('updated_at', { ascending: false }).limit(100); if (r.error) err = r.error; else rows = r.data || []; }
  else err = { message: 'offline' };
  const mine = (() => { try { return JSON.parse(localStorage.getItem('r29.ed.mine') || '[]'); } catch (e) { return []; } })();
  if (err) {
    const missing = /relation|does not exist|schema cache|not find the table/i.test(err.message || '');
    $('dbBanner').hidden = false;
    $('dbBanner').innerHTML = missing ? `<b>One-time setup needed to share levels.</b> The <code>levels</code> table isn't in Supabase yet. Open your Supabase project → SQL Editor → New query, paste the contents of <a href="supabase-levels.sql" target="_blank" rel="noopener">supabase-levels.sql</a>, and press Run. Until then, levels save in this browser and live co-editing still works for anyone who has the link open.`
      : `Couldn't reach the level database (${esc(err.message || 'offline')}). Levels you open save in this browser.`;
    for (const m of mine) if (!rows.find(r => r.id === m.id)) rows.push({ id: m.id, name: m.name, author: '(this browser)', mode: m.mode, updated_at: new Date(m.t).toISOString() });
  }
  $('levelList').innerHTML = rows.length ? rows.map(r => `<a class="lcard" href="?id=${esc(r.id)}"><b>${esc(r.name)}</b><span>${r.mode === 'arena' ? 'VS arena' : 'Race track'}${r.author ? ' · ' + esc(r.author) : ''}</span><span>Edited ${ago(r.updated_at)}</span></a>`).join('') : '<p class="note">No levels yet. Make the first one.</p>';
  const make = mode => { const id = rid(8), lv = blankLevel(mode); try { localStorage.setItem('r29.ed.level.' + id, JSON.stringify({ id, name: lv.name, data: exportOf(lv) })); } catch (e) {} location.href = '?id=' + id + '&new=' + mode; };
  $('newRace').onclick = () => make('race'); $('newArena').onclick = () => make('arena');
  $('importBtn').onclick = () => $('fileIn').click();
}
const exportOf = lv => Object.assign({}, lv, { objects: Object.values(lv.objects) });
$('fileIn').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  let raw; try { raw = JSON.parse(await f.text()); } catch (er) { return toast('That file is not a level (.json)', 2.5); }
  const lv = sanitizeLevel(raw);
  if (!$('ed').hidden && L) { // import into the open level (replaces it for everyone)
    if (!confirm('Replace this level with the imported one for everyone editing it?')) return;
    L = lv; send('full', { to: '*', level: exportLevel() }); for (const op of [{ t: 'road', pts: L.road }]) send('op', op); for (const o of Object.values(L.objects)) send('op', { t: 'obj', o });
    renderMeta(); renderSel(); fit(); dirty = true; saveSoon(); return;
  }
  const id = rid(8); try { localStorage.setItem('r29.ed.level.' + id, JSON.stringify({ id, name: lv.name, data: exportOf(lv) })); } catch (er) {} location.href = '?id=' + id + '&new=import';
};

/* ---------- start ---------- */
async function openEditor(id, isNew) {
  levelId = id; $('home').hidden = true; $('ed').hidden = false;
  buildTools(); bindInput(); bindSide(); resize();
  setStatus('Loading…');
  const raw = await loadLevel(id);
  L = sanitizeLevel(raw || blankLevel('race'));
  renderMeta(); renderSel(); renderPeople(); setTool('select'); fit();
  joinRealtime();
  if (isNew || !raw) { dirty = true; saveNow(); } else renderStatus();
  rememberLocal(id, L.name, L.mode);
  setInterval(() => { renderStatus(); renderPeople(); draw(); }, 3000);
}
const params = new URLSearchParams(location.search), qid = (params.get('id') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
if (qid.length >= 6) openEditor(qid, !!params.get('new')); else showHome();
window.__ed = { level: () => L, edit, select: s => select(s), peers: () => peers, setTool, toWorld, toScr, view, save: saveNow, status: () => $('status').textContent };
})();
