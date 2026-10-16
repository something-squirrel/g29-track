/* R29-Track runtime: rendering, input, physics integration, world, traffic, timing, menus, online. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const P = window.R29Physics, VEH = window.R29_VEHICLES, MD = window.R29_MAPDATA, WB = window.R29World, CARS = window.R29Cars;
const MAPS = MD.MAPS, WEATHER = MD.WEATHER, TIMES = MD.TIMES;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MPH = P.MPH;

/* ---------- settings ---------- */
const KEY = 'r29track.v1';
const DEF = { steerAxis: 0, steerInvert: false, rotation: 900, deadzone: 0.015,
  thr: { axis: 2, rest: 1, pressed: -1 }, brk: { axis: 5, rest: 1, pressed: -1 }, clu: { axis: 1, rest: 1, pressed: -1 },
  upBtn: 4, downBtn: 5, ebrakeBtn: 7, resetBtn: 0, modeBtn: 3, camBtn: 2, menuBtn: 9,
  carId: 'vesper-s4', mapId: 'redline', weather: {}, time: {}, traffic: 'map', mode: 'free', laps: 3,
  assist: 'full', shift: 'car', cam: 'cockpit', seat: 0, ghost: 1, mini: 1, qual: 'high', name: '', room: '' };
let cfg = JSON.parse(JSON.stringify(DEF));
try { const old = JSON.parse(localStorage.getItem('g29track.v1') || 'null'); if (old) for (const k of ['steerAxis', 'steerInvert', 'rotation', 'thr', 'brk', 'clu', 'upBtn', 'downBtn', 'ebrakeBtn', 'resetBtn']) if (old[k] != null) cfg[k] = old[k]; } catch (e) {}
try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) cfg = Object.assign(cfg, s); } catch (e) {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} };
const ACTIONS = [['upBtn', 'Upshift'], ['downBtn', 'Downshift'], ['ebrakeBtn', 'E-brake'], ['modeBtn', 'Driver aids'], ['resetBtn', 'Reset car'], ['camBtn', 'Camera'], ['menuBtn', 'Menu / pause']];
if (!VEH.find(v => v.id === cfg.carId)) cfg.carId = VEH[0].id;
if (!MAPS.find(m => m.id === cfg.mapId)) cfg.mapId = MAPS[0].id;
try { const n = localStorage.getItem('g29track.name'); if (n && !cfg.name) cfg.name = n; } catch (e) {}

/* ---------- renderer, scene, sky ---------- */
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: cfg.qual !== 'low', powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, cfg.qual === 'low' ? 1 : 2));
view.appendChild(renderer.domElement);
window.R29Gen.setAniso(renderer.capabilities.getMaxAnisotropy());
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb4cddc);
scene.fog = new THREE.Fog(0xb4cddc, 500, 2600);
const cam = new THREE.PerspectiveCamera(72, 1, 0.1, 4000);
const hemi = new THREE.HemisphereLight(0xdfefff, 0x3f5f26, 0.85); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 0.75); sun.position.set(300, 500, 200); scene.add(sun);
const headlight = new THREE.SpotLight(0xfff1d6, 0, 140, 0.5, 0.45, 1.2); scene.add(headlight, headlight.target);
function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

function makeSkyRing(cols) {
  const W = 4096, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const ridge = (oct) => { const terms = oct.map(([f, a]) => [f, a, rnd() * Math.PI * 2]); return u => terms.reduce((s, [f, a, ph]) => s + a * Math.abs(Math.sin(u * Math.PI * f + ph)), 0); };
  const layers = [
    { base: 0.30, amp: 0.46, col: cols[0], snow: 0.62, fn: ridge([[3, 1], [7, 0.55], [13, 0.3], [29, 0.13], [61, 0.05]]) },
    { base: 0.52, amp: 0.30, col: cols[1], snow: 0, fn: ridge([[5, 1], [11, 0.5], [23, 0.25], [53, 0.1]]) },
    { base: 0.72, amp: 0.18, col: cols[2], snow: 0, fn: ridge([[9, 1], [19, 0.5], [41, 0.25], [83, 0.1]]) },
  ];
  for (const L of layers) {
    let max = 0; const hs = new Float32Array(W);
    for (let x = 0; x < W; x++) { hs[x] = L.fn(x / W); max = Math.max(max, hs[x]); }
    for (let x = 0; x < W; x++) {
      const t = hs[x] / max, top = H * (L.base + L.amp * (1 - t));
      g.fillStyle = `rgb(${L.col.join(',')})`; g.fillRect(x, top, 1, H - top);
      if (L.snow && t > L.snow && cols[0][0] < 180) { g.fillStyle = 'rgba(244,247,250,0.95)'; g.fillRect(x, top, 1, (t - L.snow) * H * 0.55); }
    }
  }
  const haze = g.createLinearGradient(0, H * 0.35, 0, H);
  haze.addColorStop(0, 'rgba(180,205,220,0)'); haze.addColorStop(1, 'rgba(180,205,220,0.85)');
  g.globalCompositeOperation = 'source-atop'; g.fillStyle = haze; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c); tex.wrapS = THREE.RepeatWrapping;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(3400, 3400, 900, 64, 1, true),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  mesh.position.y = 300; mesh.renderOrder = -1; mesh.frustumCulled = false;
  return mesh;
}
let skyRing = null;

/* ---------- input ---------- */
const keys = new Set();
let kbSteer = 0, blocked = false, padId = '', prevBtns = [], usingKeys = false;
const moved = new Set();
let detect = null, binding = null;
addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  if (e.code === 'Escape') { e.preventDefault(); togglePause(); return; }
  if (document.body.classList.contains('inmenu')) return;
  keys.add(e.code); usingKeys = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'KeyR') resetToRoad();
  if (e.code === 'ArrowUp') paddle(1);
  if (e.code === 'ArrowDown') paddle(-1);
  if (e.code === 'KeyM') cycleAssist();
  if (e.code === 'KeyC') cycleCam();
  if (e.code === 'KeyT') toggleShift();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

function getPad() {
  let pads;
  try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { blocked = true; return null; }
  let best = null;
  for (const p of pads) if (p && p.connected) { if (!best || /g29|g920|g923|logitech|046d|wheel/i.test(p.id)) best = p; }
  return best;
}
function pedal(gp, c) {
  if (!gp || c.axis < 0 || c.axis >= gp.axes.length || !moved.has(c.axis)) return 0;
  const span = c.pressed - c.rest; if (Math.abs(span) < 0.05) return 0;
  const t = clamp((gp.axes[c.axis] - c.rest) / span, 0, 1);
  return t < 0.02 ? 0 : (t - 0.02) / 0.98;
}
function readInput(dt) {
  const gp = getPad();
  const inp = { steer: 0, thr: 0, brk: 0, clu: 0, ebrake: false, gp, wheel: false };
  if (gp) {
    gp.axes.forEach((v, i) => { if (v !== 0) moved.add(i); });
    let s = gp.axes[cfg.steerAxis] || 0; if (cfg.steerInvert) s = -s;
    const dz = cfg.deadzone; s = Math.abs(s) < dz ? 0 : Math.sign(s) * (Math.abs(s) - dz) / (1 - dz);
    inp.steer = s; inp.wheel = moved.has(cfg.steerAxis);
    inp.thr = pedal(gp, cfg.thr); inp.brk = pedal(gp, cfg.brk); inp.clu = pedal(gp, cfg.clu);
    const b = gp.buttons.map(x => x.pressed);
    const edge = i => b[i] && !prevBtns[i];
    if (binding) { const i = b.findIndex((p, k) => p && !binding.base[k]); if (i >= 0) finishBind(i); }
    else {
      if (edge(cfg.menuBtn)) togglePause();
      if (!document.body.classList.contains('inmenu')) {
        if (edge(cfg.upBtn)) paddle(1);
        if (edge(cfg.downBtn)) paddle(-1);
        if (edge(cfg.resetBtn)) resetToRoad();
        if (edge(cfg.modeBtn)) cycleAssist();
        if (edge(cfg.camBtn)) cycleCam();
        inp.ebrake = !!b[cfg.ebrakeBtn];
      }
    }
    prevBtns = b;
    if (detect) { gp.axes.forEach((v, i) => { detect.min[i] = Math.min(detect.min[i] ?? v, v); detect.max[i] = Math.max(detect.max[i] ?? v, v); }); detect.last = gp.axes.slice(); }
  }
  const kL = keys.has('KeyA') || keys.has('ArrowLeft'), kR = keys.has('KeyD') || keys.has('ArrowRight');
  const target = (kR ? 1 : 0) - (kL ? 1 : 0);
  kbSteer += clamp(target - kbSteer, -2.6 * dt, 2.6 * dt);
  inp.kb = kbSteer;
  if (keys.has('KeyW')) inp.thr = 1;
  if (keys.has('KeyS')) inp.brk = 1;
  if (keys.has('Space')) inp.ebrake = true;
  return inp;
}

/* ---------- wheel setup panel (from the original game) ---------- */
const setup = $('setup');
$('toggleSetup').onclick = () => { setup.hidden = !setup.hidden; };
$('closeSetup').onclick = () => { setup.hidden = true; };
let nAxes = -1, nBtns = -1, axisEls = [], btnEls = [];
const roleOf = i => [i === cfg.steerAxis && 'STEER', i === cfg.thr.axis && 'GAS', i === cfg.brk.axis && 'BRAKE', i === cfg.clu.axis && 'CLUTCH'].filter(Boolean).join(' ');
function fillSelect(sel, n, prefix, val, none) {
  sel.innerHTML = (none ? '<option value="-1">None</option>' : '') + Array.from({ length: Math.max(n, val + 1) }, (_, i) => `<option value="${i}">${prefix} ${i}</option>`).join('');
  sel.value = String(val);
}
function buildPanel(axes, btns) {
  nAxes = axes; nBtns = btns;
  $('axes').innerHTML = Array.from({ length: axes }, (_, i) => `<div class="axis"><span>Axis ${i}</span><div class="track"><div class="f"></div></div><span class="v">0.000</span><span class="role"></span></div>`).join('');
  axisEls = [...$('axes').children].map(r => ({ f: r.querySelector('.f'), v: r.querySelector('.v'), role: r.querySelector('.role') }));
  $('buttons').innerHTML = Array.from({ length: btns }, (_, i) => `<i>${i}</i>`).join('');
  btnEls = [...$('buttons').children];
  syncSelects(); renderBinds();
}
function syncSelects() {
  const n = Math.max(nAxes, 1);
  fillSelect($('mapSteer'), n, 'Axis', cfg.steerAxis, false); fillSelect($('mapThr'), n, 'Axis', cfg.thr.axis, true);
  fillSelect($('mapBrk'), n, 'Axis', cfg.brk.axis, true); fillSelect($('mapClu'), n, 'Axis', cfg.clu.axis, true);
  $('steerInv').checked = cfg.steerInvert; $('rot').value = cfg.rotation;
}
function renderBinds() {
  $('binds').innerHTML = ACTIONS.map(([k, label]) => `<span class="lbl">${label}</span><span class="val">Button ${cfg[k]}</span><button type="button" id="b_${k}">Bind</button>`).join('');
  for (const [k] of ACTIONS) $('b_' + k).onclick = () => startBind(k);
  btnEls.forEach((el, i) => el.classList.toggle('bound', ACTIONS.some(([k]) => cfg[k] === i)));
}
function startBind(k) {
  const gp = getPad(), st = $('padStatus');
  if (!gp) { st.textContent = 'No wheel detected. Press a wheel button first, then click Bind.'; st.className = 'err'; return; }
  if (binding) clearTimeout(binding.timer);
  binding = { k, base: gp.buttons.map(b => b.pressed), timer: setTimeout(() => { binding = null; renderBinds(); }, 6000) };
  renderBinds(); const btn = $('b_' + k); btn.textContent = 'Press…'; btn.classList.add('wait');
}
function finishBind(i) {
  const k = binding.k; clearTimeout(binding.timer); binding = null;
  const other = ACTIONS.find(([o]) => o !== k && cfg[o] === i);
  if (other) cfg[other[0]] = cfg[k];
  cfg[k] = i; save(); renderBinds();
  const st = $('padStatus'); st.textContent = `${ACTIONS.find(a => a[0] === k)[1]} bound to button ${i}.` + (other ? ` ${other[1]} moved to button ${cfg[other[0]]}.` : ''); st.className = 'ok';
}
$('mapSteer').onchange = e => { cfg.steerAxis = +e.target.value; save(); };
$('steerInv').onchange = e => { cfg.steerInvert = e.target.checked; save(); };
$('rot').onchange = e => { cfg.rotation = clamp(+e.target.value || 900, 180, 1080); e.target.value = cfg.rotation; save(); };
for (const [id, role] of [['mapThr', 'thr'], ['mapBrk', 'brk'], ['mapClu', 'clu']]) $(id).onchange = e => { cfg[role] = { axis: +e.target.value, rest: 1, pressed: -1 }; save(); };
for (const [id, role, sel] of [['detThr', 'thr', 'mapThr'], ['detBrk', 'brk', 'mapBrk'], ['detClu', 'clu', 'mapClu']]) {
  $(id).onclick = () => {
    if (detect) return;
    const btn = $(id); detect = { role, min: [], max: [], last: null };
    let left = 3; btn.textContent = `Press… ${left}`;
    const tick = setInterval(() => {
      left--; if (left > 0) { btn.textContent = `Press… ${left}`; return; }
      clearInterval(tick); const d = detect; detect = null; btn.textContent = 'Detect';
      let bestI = -1, bestR = 0.3;
      d.max.forEach((mx, i) => { const r = mx - d.min[i]; if (i !== cfg.steerAxis && r > bestR) { bestR = r; bestI = i; } });
      const st = $('padStatus');
      if (bestI < 0 || !d.last) { st.textContent = 'No pedal movement seen. Click Detect, then press the pedal fully and release.'; st.className = 'err'; return; }
      const fin = d.last[bestI], mn = d.min[bestI], mx = d.max[bestI];
      const rest = Math.abs(fin - mn) < Math.abs(fin - mx) ? mn : mx, pressed = rest === mn ? mx : mn;
      cfg[role] = { axis: bestI, rest, pressed }; moved.add(bestI); save(); $(sel).value = String(bestI);
      st.textContent = `${{ thr: 'Throttle', brk: 'Brake', clu: 'Clutch' }[role]} mapped to axis ${bestI}.`; st.className = 'ok';
    }, 1000);
  };
}
buildPanel(0, 0);
function updatePanel(gp) {
  const st = $('padStatus');
  if (blocked) { st.textContent = 'This view blocks wheel access. Open the game in its own Chrome or Edge tab.'; st.className = 'err'; return; }
  if (!gp) { if (padId) { padId = ''; st.textContent = 'Wheel disconnected. Turn the wheel or press a button.'; st.className = ''; } return; }
  if (gp.id !== padId) { padId = gp.id; st.textContent = `Connected: ${gp.id}`; st.className = 'ok'; }
  if (gp.axes.length !== nAxes || gp.buttons.length !== nBtns) buildPanel(gp.axes.length, gp.buttons.length);
  if (setup.hidden) return;
  gp.axes.forEach((v, i) => { const e = axisEls[i]; if (!e) return; const w = Math.abs(v) * 50; e.f.style.left = (v < 0 ? 50 - w : 50) + '%'; e.f.style.width = w + '%'; e.v.textContent = (v >= 0 ? ' ' : '') + v.toFixed(3); e.role.textContent = roleOf(i); });
  gp.buttons.forEach((b, i) => btnEls[i] && btnEls[i].classList.toggle('on', b.pressed));
}

/* ---------- game state ---------- */
let world = null, mapDef = null, weatherId = 'clear', weather = WEATHER.clear, timeDef = TIMES.noon, hour = 12.5;
let spec = null, car = null, st = null, model = null;
let ready = false, paused = true, frozen = false, now = 0, acc = 0;
let terrPitch = 0, terrRoll = 0, surfName = 'asphalt', inWater = 0, drownT = 0, speedCap = 0, darkness = 0;
let lastInp = { thr: 0, brk: 0, clu: 0, steer: 0, ebrake: false, steerAngle: 0 };
const H = 1 / 1000;
const carById = id => VEH.find(v => v.id === id) || VEH[0];
const mapById = id => MAPS.find(m => m.id === id) || MAPS[0];
const ASSIST = { full: { abs: true, tc: true, esc: true }, sport: { abs: true, tc: true, esc: false }, off: { abs: true, tc: false, esc: false } };
const autoShiftOn = () => cfg.shift === 'auto' || (cfg.shift === 'car' && car.trans !== 'manual');
let paddleHold = 0;

function makeModelFor(sp, opts = {}) {
  const c = P.createCar(sp);
  return CARS.makeCarModel(Object.assign({}, sp.visual, opts.color != null ? { color: opts.color } : {}), { ghost: !!opts.ghost, cgFromFront: c.A * (sp.visual.wheelbase / c.WB) });
}
function setCar(id, keepPose) {
  const pose = keepPose && st ? { x: st.x, z: st.z, y: st.y - car.HCG, h: st.h } : null;
  spec = carById(id); car = P.createCar(spec);
  st = P.createState(car, weather.ambient ?? 22);
  if (model) scene.remove(model.group);
  model = makeModelFor(spec); scene.add(model.group);
  if (pose) P.placeState(car, st, pose.x, pose.z, pose.y + 0.05, pose.h);
  skLast[0] = skLast[1] = null;
  if (net.ready) { net.sendT = 0; trackPresence(); }
}
function disposeGroup(g) { g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m.map && !m.map.__shared) {} m.dispose(); }); }); }

async function loadMap(id, opts = {}) {
  $('loadingText').textContent = `Building ${mapById(id).name}…`; $('loading').classList.add('on');
  await new Promise(r => setTimeout(r, 40));
  if (world) { scene.remove(world.group); disposeGroup(world.group); }
  if (skyRing) { scene.remove(skyRing); skyRing = null; }
  clearTraffic(); clearParticles();
  mapDef = mapById(id); cfg.mapId = id;
  weatherId = mapDef.weather_presets.includes(cfg.weather[id]) ? cfg.weather[id] : mapDef.weather_presets[0];
  weather = WEATHER[weatherId];
  const tId = mapDef.time_presets.includes(cfg.time[id]) ? cfg.time[id] : mapDef.time_presets[0];
  timeDef = TIMES[tId]; hour = timeDef.hour;
  const t0 = performance.now();
  world = WB.build(mapDef, { weather });
  scene.add(world.group);
  skyRing = makeSkyRing(mapDef.sky); scene.add(skyRing);
  hemi.groundColor.setHex({ city: 0x55524a, desert: 0x8a6a4a, coast: 0x5a5a38 }[mapDef.generator] || 0x3f5f26);
  setCar(cfg.carId);
  const sp = opts.grid != null ? world.grid[opts.grid] : (cfg.mode === 'trial' ? (mapDef.mode === 'loop' ? world.grid[0] : world.grid[0]) : world.spawns[clamp(opts.spawn ?? 0, 0, world.spawns.length - 1)]);
  placeAt(sp);
  if (world.tiles) world.tiles.update(sp.x, sp.z, 1e9);
  initTraffic(); initParticles(); loadGhost(); resetRun();
  console.log(`[r29] built ${mapDef.name} in ${(performance.now() - t0).toFixed(0)} ms`);
  ready = true; $('loading').classList.remove('on');
  joinNet();
  save();
}
function placeAt(sp) {
  const g = world.ground(sp.x, sp.z, (sp.y ?? 0) + 2);
  P.placeState(car, st, sp.x, sp.z, g.h + 0.02, sp.h);
  if (model) model.repair();
  skLast[0] = skLast[1] = null; terrPitch = terrRoll = 0;
}
function resetToRoad() {
  if (!world || frozen) return;
  if (run.started && run.lastGate) { placeAt(run.lastGate.spawn); run.valid = false; toast('Reset to last checkpoint — lap invalid'); return; }
  const q = world.nearest(st.x, st.z);
  if (q && q.city) {
    const B = world.city.B, along = q.axis === 'z' ? st.z : st.x;
    const fwd = q.axis === 'z' ? (Math.cos(st.h) > 0 ? -1 : 1) : (Math.sin(st.h) > 0 ? 1 : -1);
    const off = q.axis === 'z' ? (fwd < 0 ? 1.75 : -1.75) : (fwd > 0 ? 1.75 : -1.75);
    let a = along; const k = Math.round(a / B); if (Math.abs(a - k * B) < 20) a = k * B + Math.sign(a - k * B || 1) * 22;
    placeAt(q.axis === 'z' ? { x: q.c + off, z: a, h: fwd < 0 ? 0 : Math.PI } : { x: a, z: q.c + off, h: fwd > 0 ? Math.PI / 2 : -Math.PI / 2 });
  } else if (q && q.road) {
    const r = q.road, i = q.i, h0 = Math.atan2(r.tx[i], -r.tz[i]);
    const back = Math.cos(st.h - h0) < 0, lat = r.twoWay && r.kind !== 'trail' ? (back ? -1 : 1) * r.laneW / 2 : 0;
    const rx = -r.tz[i], rz = r.tx[i];
    placeAt({ x: r.x[i] + rx * lat, z: r.z[i] + rz * lat, y: r.y[i], h: back ? h0 + Math.PI : h0 });
  } else if (world.spawns[0]) placeAt(world.spawns[0]);
  if (run.started) run.valid = false;
}

/* ---------- ground coupling: slope, surface, weather, water ---------- */
function groundEnv() {
  const fx = Math.sin(st.h), fz = -Math.cos(st.h), rx = Math.cos(st.h), rz = Math.sin(st.h), y = st.y;
  const gF = world.ground(st.x + fx * car.A, st.z + fz * car.A, y), gR = world.ground(st.x - fx * car.B, st.z - fz * car.B, y);
  const hw = car.TW / 2;
  const gL = world.ground(st.x - rx * hw, st.z - rz * hw, y), gRt = world.ground(st.x + rx * hw, st.z + rz * hw, y);
  const dl = (gF.h - gR.h) / car.WB, dt = (gRt.h - gL.h) / car.TW;
  const gradX = dl * fx + dt * rx, gradZ = dl * fz + dt * rz;
  const n2 = 1 + gradX * gradX + gradZ * gradZ, ny = 1 / Math.sqrt(n2);
  const gH0 = 0.5 * (gF.h * car.B + gR.h * car.A) / car.WB + 0.25 * (gL.h + gRt.h);
  terrPitch = Math.atan(dl); terrRoll = Math.atan(dt);
  const wet = weather.wet || 0, snow = weather.snow || 0;
  const muF = P.surfaceMu(gF.surf, wet, snow, spec.tire_type), muR = P.surfaceMu(gR.surf, wet, snow, spec.tire_type);
  const rr = 0.5 * ((P.SURFACES[gF.surf] || P.SURFACES.asphalt).rr + (P.SURFACES[gR.surf] || P.SURFACES.asphalt).rr);
  surfName = (P.SURFACES[gR.surf] || P.SURFACES.asphalt).label;
  inWater = Math.max(gF.water, gR.water);
  const q = gR.road && !gR.road.city ? gR.road : null;
  speedCap = world.speedCapAt ? world.speedCapAt(q) : 0;
  darkness = world.darkAt ? world.darkAt(st.x, st.z, st.y) : 0;
  if (world.ocean && gR.h < -0.6) inWater = Math.max(inWater, -gR.h);
  return { muF, muR, rr, water: Math.min(inWater, 0.9), gx: -9.81 * gradX / n2, gz: -9.81 * gradZ / n2, ny, gH0, gradX, gradZ, x0: st.x, z0: st.z,
    assist: ASSIST[cfg.assist] || ASSIST.full, mode: cfg.assist, speedCap, ambient: weather.ambient ?? 22, wet, q };
}

function steerAngleFor(inp, sp) {
  let a = 0;
  if (inp.wheel) a = clamp(inp.steer * cfg.rotation / 2 / car.steerRatio * P.D2R, -car.maxSteer, car.maxSteer);
  if (Math.abs(inp.kb) > 0.001) { // keyboard: speed-sensitive so it stays drivable without a wheel
    const k = clamp(1 / (1 + (sp / 20) ** 2), 0.14, 1);
    a = clamp(a + inp.kb * car.maxSteer * k, -car.maxSteer, car.maxSteer);
  }
  return a;
}
function paddle(dir) {
  if (!car || frozen) return;
  P.shift(car, st, dir, cfg.assist);
  if (autoShiftOn()) { paddleHold = 4; st.autoT = 4; }
}
function cycleAssist() {
  const order = ['full', 'sport', 'off']; cfg.assist = order[(order.indexOf(cfg.assist) + 1) % 3]; save();
  toast({ full: 'Driver aids: full (ABS, TC, stability)', sport: 'Driver aids: sport (ABS, TC)', off: car.kfDrift != null ? 'Driver aids: off — rear-biased drift split' : 'Driver aids: off (ABS only)' }[cfg.assist]);
}
function toggleShift() {
  cfg.shift = autoShiftOn() ? 'manual' : 'auto'; save(); toast(autoShiftOn() ? 'Automatic shifting' : 'Manual shifting (paddles / arrow keys)');
}
function cycleCam() { const o = ['cockpit', 'hood', 'chase']; cfg.cam = o[(o.indexOf(cfg.cam) + 1) % 3]; save(); }

function physicsFrame(dt, inp) {
  const sp = Math.hypot(st.vx, st.vz);
  const env = groundEnv();
  const pin = { thr: inp.thr, brk: inp.brk, clu: inp.clu, ebrake: inp.ebrake, steerAngle: steerAngleFor(inp, sp) };
  if (frozen) { pin.brk = 1; pin.ebrake = true; }
  lastInp = Object.assign(inp, { steerAngle: pin.steerAngle });
  if (paddleHold > 0) paddleHold -= dt;
  acc += dt; let n = 0;
  while (acc >= H && n < 80) {
    if (autoShiftOn() && paddleHold <= 0) P.autoShift(car, st, pin, H, cfg.assist);
    P.step(car, st, pin, env, H); acc -= H; n++;
  }
  if (n >= 80) acc = 0;
  if (st.impactV > 4) { damage(st.impactV - 4, 0, -car.HCG, 0, 1, 'landing'); }
  st.impactV = 0;
  // water too deep / sea: reset after a moment
  if (inWater > 1.1) { drownT += dt; if (drownT > 1.6) { drownT = 0; toast('Too deep — car recovered'); resetToRoad(); } } else drownT = 0;
  if (world.outOfBounds && world.outOfBounds(st.x, st.z, world.nearest(st.x, st.z))) { toast('Out of bounds — back to the road'); resetToRoad(); }
  if (st.y < -60) resetToRoad();
}

/* ---------- collisions (walls, rails, rocks, buildings, other cars) and damage ---------- */
const bodyCircles = (x, z, h, len, wid, cOff) => {
  const fx = Math.sin(h), fz = -Math.cos(h), d = len / 2 - wid / 2;
  return [cOff + d, cOff, cOff - d].map(o => [x + fx * o, z + fz * o]);
};
function damage(dv, lx, ly, nx, nz, kind, wx, wz) {
  if (dv <= 0) return;
  const before = st.damage;
  st.damage = clamp(st.damage + dv * 0.024, 0, 1);
  if (wx != null && model) { // deform near the impact point, in model space
    const v = new THREE.Vector3(wx, st.y - car.HCG + 0.6, wz); model.inner.worldToLocal(v);
    const n = new THREE.Vector3(nx, 0, nz).transformDirection(new THREE.Matrix4().extractRotation(model.inner.matrixWorld).invert());
    model.deform(v.x, v.z, n.x, n.z, Math.min(0.28, dv * 0.03));
    if (v.z < -0.6) st.pull = clamp(st.pull + Math.sign(v.x || 1) * dv * 0.0012, -0.04, 0.04); // bent front suspension pulls
  }
  if (Math.floor(st.damage * 10) > Math.floor(before * 10)) toast(`Damage ${Math.round(st.damage * 100)}%`);
  playThump(dv);
}
function collide(others) {
  const cOff = car.A - car.WB / 2, len = spec.visual.length, wid = spec.visual.width, r = wid / 2;
  const cs = bodyCircles(st.x, st.z, st.h, len, wid, cOff);
  const e = 0.25, fx = Math.sin(st.h), fz = -Math.cos(st.h);
  const applyImpulse = (cx, cz, nx, nz, pen, m2, v2x, v2z, other) => {
    st.x += nx * pen; st.z += nz * pen;
    const ox = cx - st.x, oz = cz - st.z;
    const vpx = st.vx - st.r * oz, vpz = st.vz + st.r * ox;   // velocity of the contact point
    const rvx = vpx - (v2x || 0), rvz = vpz - (v2z || 0), vn = rvx * nx + rvz * nz;
    if (vn >= 0) return 0;
    const k = -oz * nx + ox * nz;
    const inv = 1 / car.M + k * k / car.IZ + (m2 ? 1 / m2 : 0);
    const J = -(1 + e) * vn / inv;
    st.vx += J * nx / car.M; st.vz += J * nz / car.M; st.r += J * k / car.IZ;
    // tangential friction
    const tx = -nz, tz = nx, vt = rvx * tx + rvz * tz, kt = -oz * tx + ox * tz;
    const Jt = clamp(-vt / (1 / car.M + kt * kt / car.IZ + (m2 ? 1 / m2 : 0)), -0.45 * J, 0.45 * J);
    st.vx += Jt * tx / car.M; st.vz += Jt * tz / car.M; st.r += Jt * kt / car.IZ;
    const dv = J / car.M;
    if (dv > 2.2) damage(dv - 2.2, 0, 0, nx, nz, 'hit', cx - nx * r, cz - nz * r); // dent pushes into the body
    if (other) other.hit = { J, nx, nz };
    return dv;
  };
  // static world
  for (const [cx, cz] of cs) {
    for (const it of world.cols.query(cx, cz, r + 1)) {
      if (st.y < it.y0 - 0.3 || st.y - car.HCG > it.y1) continue;
      let nx = 0, nz = 0, pen = 0;
      if (it.t === 0) {
        const ex = it.bx - it.ax, ez = it.bz - it.az, L2 = ex * ex + ez * ez || 1, t = clamp(((cx - it.ax) * ex + (cz - it.az) * ez) / L2, 0, 1);
        const px = it.ax + ex * t, pz = it.az + ez * t, d = Math.hypot(cx - px, cz - pz); if (d >= r || d < 1e-6) continue;
        nx = (cx - px) / d; nz = (cz - pz) / d; pen = r - d;
      } else if (it.t === 1) {
        const d = Math.hypot(cx - it.x, cz - it.z), rr = r + it.r; if (d >= rr || d < 1e-6) continue;
        nx = (cx - it.x) / d; nz = (cz - it.z) / d; pen = rr - d;
      } else {
        const px = clamp(cx, it.x0, it.x1), pz = clamp(cz, it.z0, it.z1), d = Math.hypot(cx - px, cz - pz);
        if (d > 1e-6) { if (d >= r) continue; nx = (cx - px) / d; nz = (cz - pz) / d; pen = r - d; }
        else { const dl = cx - it.x0, dr = it.x1 - cx, dt = cz - it.z0, db = it.z1 - cz, m = Math.min(dl, dr, dt, db);
          if (m === dl) { nx = -1; pen = dl + r; } else if (m === dr) { nx = 1; pen = dr + r; } else if (m === dt) { nz = -1; pen = dt + r; } else { nz = 1; pen = db + r; } }
      }
      applyImpulse(cx - nx * (r - pen), cz - nz * (r - pen), nx, nz, pen, 0, 0, 0, null);
    }
  }
  // other cars (traffic and online players), 3 circles each
  for (const o of others) {
    if (Math.abs(o.x - st.x) > 12 || Math.abs(o.z - st.z) > 12) continue;
    if (Math.abs((o.y ?? st.y) - st.y) > 2.5) continue;
    const oc = bodyCircles(o.x, o.z, o.h, o.len || 4.5, o.wid || 1.8, 0), orr = (o.wid || 1.8) / 2;
    for (const [cx, cz] of cs) for (const [qx, qz] of oc) {
      const d = Math.hypot(cx - qx, cz - qz); if (d >= r + orr || d < 1e-6) continue;
      const nx = (cx - qx) / d, nz = (cz - qz) / d;
      const dv = applyImpulse(cx - nx * r, cz - nz * r, nx, nz, (r + orr - d) * 0.5, o.mass || 1500, o.vx, o.vz, o);
      if (o.onHit && o.hit) { o.onHit(o.hit, car.M); o.hit = null; }
    }
  }
}

/* ---------- traffic ---------- */
const traffic = { list: [], im: null, max: 0, t: 0 };
const TCOL = [0xb03a2e, 0x2e5ea8, 0xdedede, 0x2a2a2a, 0x8a8f94, 0x3f6b4a, 0xc9b26a, 0xe0e0d8, 0x5a3b6e];
function clearTraffic() { if (traffic.im) { scene.remove(traffic.im); traffic.im.geometry.dispose(); traffic.im.material.dispose(); } traffic.im = null; traffic.list = []; }
function initTraffic() {
  const dens = cfg.traffic === 'map' ? mapDef.traffic_density : +cfg.traffic;
  traffic.max = world.lanes.length ? Math.round(dens * (world.city ? 70 : 26)) : 0;
  if (!traffic.max) return;
  traffic.im = new THREE.InstancedMesh(CARS.trafficGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), traffic.max);
  traffic.im.count = 0; traffic.im.frustumCulled = false; scene.add(traffic.im);
}
function lanePose(lane, p) {
  if (lane.city) {
    const pc = lane.city;
    return pc.axis === 'z' ? { x: pc.c + lane.off, z: p, y: 0, h: lane.dir > 0 ? Math.PI : 0 } : { x: p, z: pc.c + lane.off, y: 0, h: lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2 };
  }
  const r = lane.road, sp = r.len / r.n, f = clamp(p / sp, 0, r.n - 1.001), i = Math.floor(f), t = f - i, j = r.idx(i + 1);
  const x = lerp(r.x[i], r.x[j], t), z = lerp(r.z[i], r.z[j], t), y = lerp(r.y[i], r.y[j], t), rx = -r.tz[i], rz = r.tx[i];
  const h = Math.atan2(r.tx[i], -r.tz[i]) + (lane.dir < 0 ? Math.PI : 0);
  return { x: x + rx * lane.off, z: z + rz * lane.off, y, h };
}
function spawnAI() {
  const lanes = world.lanes, lane = lanes[Math.floor(Math.random() * lanes.length)];
  let p;
  if (lane.city) {
    const pc = lane.city, perp = pc.axis === 'z' ? st.x : st.z, along = pc.axis === 'z' ? st.z : st.x;
    if (Math.abs(pc.c - perp) > 650) return;
    p = clamp(along + (Math.random() < 0.5 ? -1 : 1) * (200 + Math.random() * 450), pc.a0 + 10, pc.a1 - 10);
  } else {
    const q = world.nearest(st.x, st.z); if (!q || q.road !== lane.road) return;
    p = q.s + (Math.random() < 0.5 ? -1 : 1) * (260 + Math.random() * 420);
    if (lane.road.closed) p = (p + lane.road.len) % lane.road.len; else if (p < 20 || p > lane.road.len - 20) return;
  }
  const pose = lanePose(lane, p);
  if (Math.hypot(pose.x - st.x, pose.z - st.z) < 150) return;
  if (traffic.list.some(a => a.lane === lane && Math.abs(a.p - p) < 25)) return;
  const vmax = (lane.vmax || mapDef.speed_limit_ms || 15) * (0.85 + Math.random() * 0.25);
  traffic.list.push(Object.assign({ lane, p, v: vmax * 0.8, vmax, color: new THREE.Color(TCOL[Math.floor(Math.random() * TCOL.length)]), mass: 1450 + Math.random() * 500, len: 4.5, wid: 1.8, crashed: 0, vx: 0, vz: 0, r: 0 }, pose));
}
function updateTraffic(dt) {
  if (!traffic.im) return;
  traffic.t -= dt;
  if (traffic.t <= 0) { traffic.t = 0.25; for (let k = 0; k < 3 && traffic.list.length < traffic.max; k++) spawnAI(); }
  const B = world.city ? world.city.B : 0;
  for (let k = traffic.list.length - 1; k >= 0; k--) {
    const a = traffic.list[k];
    if (Math.hypot(a.x - st.x, a.z - st.z) > 1000) { traffic.list.splice(k, 1); continue; }
    if (a.crashed) {
      a.crashed += dt; const sp = Math.hypot(a.vx, a.vz), dec = Math.min(sp, 7 * dt);
      if (sp > 0) { a.vx -= a.vx / sp * dec; a.vz -= a.vz / sp * dec; }
      a.x += a.vx * dt; a.z += a.vz * dt; a.h += a.r * dt; a.r *= Math.exp(-2 * dt);
      a.y = world.ground(a.x, a.z, a.y + 1).h;
      if (a.crashed > 12) traffic.list.splice(k, 1);
      continue;
    }
    let target = a.vmax;
    const lane = a.lane;
    if (lane.city) {
      const pc = lane.city, crossK = (p) => Math.round(p / B);
      // next intersection ahead and its stop line
      let kN = lane.dir > 0 ? Math.ceil((a.p + 4) / B) : Math.floor((a.p - 4) / B);
      const hwC = world.city.hwOf(kN), stopP = kN * B - lane.dir * (hwC + 3);
      const dist = (stopP - a.p) * lane.dir;
      const kx = pc.axis === 'z' ? Math.round(pc.c / B) : kN, kz = pc.axis === 'z' ? kN : Math.round(pc.c / B);
      const light = world.lightState(kx, kz, pc.axis, now);
      if (light > 0 && dist > -1 && dist < 45 && !(light === 1 && dist < a.v * a.v / 8)) target = Math.min(target, Math.max(0, (dist - 0.5) * 0.7));
      if ((lane.dir > 0 && a.p > pc.a1 - 15) || (lane.dir < 0 && a.p < pc.a0 + 15)) { traffic.list.splice(k, 1); continue; }
    } else {
      const r = lane.road, sp = r.len / r.n;
      let km = 0; for (let d = 0; d <= 70; d += 10) { const i = Math.round((a.p + lane.dir * d) / sp); const ii = r.closed ? r.idx(i) : clamp(i, 0, r.n - 1); km = Math.max(km, Math.abs(r.k[ii])); }
      if (km > 1e-4) target = Math.min(target, Math.sqrt(3.0 / km));
      if (!r.closed && (a.p < 5 || a.p > r.len - 5)) { traffic.list.splice(k, 1); continue; }
    }
    // keep a gap to the car ahead in the same lane, and to the player
    const fx = Math.sin(a.h), fz = -Math.cos(a.h);
    for (const b of traffic.list) { if (b === a || b.lane !== lane) continue; const g = (b.p - a.p) * lane.dir; if (g > 0 && g < 60) target = Math.min(target, Math.max(0, (g - 9) * 0.6)); }
    const dxp = st.x - a.x, dzp = st.z - a.z, ahead = dxp * fx + dzp * fz, side = Math.abs(dxp * -fz + dzp * fx);
    if (ahead > 0 && ahead < 50 && side < 2.6) target = Math.min(target, Math.max(0, (ahead - 9) * 0.55));
    a.v += clamp(target - a.v, -7 * dt, 2.2 * dt); a.v = Math.max(0, a.v);
    a.p += lane.dir * a.v * dt;
    if (!lane.city && lane.road.closed) a.p = (a.p + lane.road.len) % lane.road.len;
    const pose = lanePose(lane, a.p); a.x = pose.x; a.z = pose.z; a.y = pose.y; a.h = pose.h;
    a.vx = Math.sin(a.h) * a.v; a.vz = -Math.cos(a.h) * a.v;
  }
  const o = new THREE.Object3D();
  traffic.list.forEach((a, i) => {
    a.onHit = (hit, m1) => { a.crashed = a.crashed || 0.001; a.vx -= hit.J * hit.nx / a.mass; a.vz -= hit.J * hit.nz / a.mass; a.r += (Math.random() - 0.5) * hit.J / a.mass * 0.6; };
    o.position.set(a.x, a.y, a.z); o.rotation.set(0, -a.h, 0); o.updateMatrix(); traffic.im.setMatrixAt(i, o.matrix); traffic.im.setColorAt(i, a.color);
  });
  traffic.im.count = traffic.list.length; traffic.im.instanceMatrix.needsUpdate = true; if (traffic.im.instanceColor) traffic.im.instanceColor.needsUpdate = true;
}

/* ---------- checkpoints, timing, ghosts ---------- */
const run = { cp: 0, started: false, lapStart: 0, valid: true, laps: 0, lastLap: null, best: null, finished: false, lastGate: null, rec: [], recT: 0, raceLaps: 0 };
let combo = 0, comboT = 0, bestDrift = 0, flash = null, flashT = 0, banked = 0;
const fmt = s => s == null ? '–' : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
const pbKey = () => `r29.pb.${mapDef.id}.${spec.id}`, ghostKey = () => `r29.ghost.${mapDef.id}.${spec.id}`;
function resetRun() {
  Object.assign(run, { cp: 0, started: false, lapStart: 0, valid: true, laps: 0, lastLap: null, finished: false, lastGate: null, rec: [], recT: 0, raceLaps: 0 });
  try { run.best = +localStorage.getItem(pbKey()) || null; } catch (e) { run.best = null; }
  combo = 0;
}
function gateSpawn(g) { const h = Math.atan2(g.tx, -g.tz); return { x: g.x + g.tx * 4, z: g.z + g.tz * 4, y: g.y, h }; }
function checkGates(px, pz) {
  const cps = world.checkpoints; if (!cps.length) return;
  const loop = mapDef.mode === 'loop', g = cps[run.cp];
  const hit = (g) => {
    const rx = -g.tz, rz = g.tx, ax = g.x - rx * g.hw, az = g.z - rz * g.hw, bx = g.x + rx * g.hw, bz = g.z + rz * g.hw;
    const d1x = st.x - px, d1z = st.z - pz, d2x = bx - ax, d2z = bz - az, den = d1x * d2z - d1z * d2x;
    if (Math.abs(den) < 1e-9) return false;
    const t = ((ax - px) * d2z - (az - pz) * d2x) / den, u = ((ax - px) * d1z - (az - pz) * d1x) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 && (d1x * g.tx + d1z * g.tz) > 0;
  };
  if (loop && run.started && run.cp !== 0 && hit(cps[0])) { // crossed the line without all checkpoints: new lap, previous one void
    toast('Missed a checkpoint — lap not counted'); run.lapStart = now; run.valid = true; run.cp = 1 % cps.length; run.rec = []; run.lastGate = { spawn: gateSpawn(cps[0]) }; return;
  }
  if (!hit(g)) return;
  run.lastGate = { spawn: gateSpawn(g) };
  if (run.cp === 0) {
    if (!run.started || !loop) {
      if (race.state === 'running' && run.started) return;
      run.started = true; run.lapStart = now; run.valid = st.damage < 0.999; run.rec = []; run.recT = 0; run.finished = false;
      if (!race.state || race.state === 'running') toast(loop ? 'Lap started' : 'Run started — go!');
    } else lapDone(now - run.lapStart);
    run.cp = 1 % cps.length;
    return;
  }
  if (!loop && run.cp === cps.length - 1) { run.finished = true; run.started = false; run.cp = 0; lapDone(now - run.lapStart); return; }
  toast(`Checkpoint ${run.cp}/${cps.length - (loop ? 0 : 1)} · ${fmt(now - run.lapStart)}`, 1.2);
  run.cp = (run.cp + 1) % cps.length;
}
function lapDone(t) {
  run.lastLap = t; run.laps++; run.raceLaps++;
  const valid = run.valid;
  let msg = `${mapDef.mode === 'loop' ? 'Lap' : 'Run'} ${fmt(t)}`;
  if (valid && (run.best == null || t < run.best)) {
    msg += run.best == null ? ' — first time set' : ` — personal best (−${(run.best - t).toFixed(3)})`;
    run.best = t; try { localStorage.setItem(pbKey(), String(t)); } catch (e) {}
    saveGhost(t); lbSubmit(t);
  } else if (!valid) msg += ' (invalid: reset/repair during the lap)';
  toast(msg, 3.5);
  run.rec = []; run.recT = 0; run.lapStart = now; run.valid = true;
  if (race.state === 'running') raceProgress();
}
function recordGhost(dt) {
  if (!run.started) return;
  run.recT -= dt; if (run.recT > 0) return; run.recT = 0.1;
  run.rec.push(+(now - run.lapStart).toFixed(2), +st.x.toFixed(2), +st.z.toFixed(2), +st.h.toFixed(3), +(st.y - car.HCG).toFixed(2));
}
let ghost = null, ghostModel = null;
function saveGhost(t) { if (run.rec.length < 20) return; const g = { t, d: run.rec.slice() }; try { localStorage.setItem(ghostKey(), JSON.stringify(g)); } catch (e) {} ghost = g; buildGhostModel(); }
function loadGhost() { ghost = null; try { ghost = JSON.parse(localStorage.getItem(ghostKey()) || 'null'); } catch (e) {} buildGhostModel(); }
function buildGhostModel() { if (ghostModel) scene.remove(ghostModel.group); ghostModel = null; if (!ghost) return; ghostModel = makeModelFor(spec, { ghost: true, color: 0xffffff }); scene.add(ghostModel.group); ghostModel.group.visible = false; }
function updateGhost() {
  if (!ghostModel) return;
  const show = cfg.ghost && ghost && run.started && cfg.mode === 'trial' && !race.state;
  ghostModel.group.visible = !!show; if (!show) return;
  const t = now - run.lapStart, d = ghost.d, n = d.length / 5;
  let lo = 0, hi = n - 1; if (t >= d[(n - 1) * 5]) { ghostModel.group.visible = false; return; }
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d[m * 5] <= t) lo = m; else hi = m; }
  const f = clamp((t - d[lo * 5]) / ((d[hi * 5] - d[lo * 5]) || 1), 0, 1), A = lo * 5, B = hi * 5;
  let dh = d[B + 3] - d[A + 3]; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  ghostModel.group.position.set(lerp(d[A + 1], d[B + 1], f), lerp(d[A + 4], d[B + 4], f), lerp(d[A + 2], d[B + 2], f));
  ghostModel.group.rotation.set(0, -(d[A + 3] + dh * f), 0);
  ghost.pos = [ghostModel.group.position.x, ghostModel.group.position.z];
}

/* ---------- online leaderboard (Supabase table lap_times) ---------- */
const SB_URL = 'https://gpgjkvvmzwrzddnoxhbr.supabase.co';
const SB_KEY = 'sb_publishable_9PbCgyuQJ5yNkuz5PVFMSQ_bm1BrAo3'; // publishable key: meant for browser code
let sb = null;
try { if (window.supabase) sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, realtime: { params: { eventsPerSecond: 20 } } }); } catch (e) { sb = null; }
let lastSubmit = 0;
async function lbSubmit(t) {
  if (!sb || performance.now() - lastSubmit < 15000) return;
  lastSubmit = performance.now();
  const { error } = await sb.from('lap_times').insert({ player_name: myName(), map_id: mapDef.id, car_id: spec.id, weather: weatherId, time_ms: Math.round(t * 1000) });
  if (error) console.warn('[r29] leaderboard submit failed', error.message);
  else toast(`Posted ${fmt(t)} to the ${mapDef.name} leaderboard`, 3);
}
async function lbFetch(mapId, carId) {
  if (!sb) return { error: 'offline' };
  let q = sb.from('lap_times').select('player_name,car_id,time_ms,weather,created_at').eq('map_id', mapId).order('time_ms', { ascending: true }).limit(300);
  if (carId) q = q.eq('car_id', carId);
  const { data, error } = await q;
  if (error) return { error: error.message };
  const seen = new Set(), out = [];
  for (const r of data) { const k = r.player_name + '|' + r.car_id; if (seen.has(k)) continue; seen.add(k); out.push(r); if (out.length >= 10) break; }
  return { rows: out };
}
async function renderLb(el, mapId, carId) {
  el.innerHTML = '<li><span></span><span class="c">Loading…</span></li>';
  const r = await lbFetch(mapId, carId);
  if (r.error) { el.innerHTML = `<li><span></span><span class="c">${r.error === 'offline' ? 'Leaderboard offline' : 'Leaderboard unavailable: ' + esc(r.error)}</span></li>`; return; }
  if (!r.rows.length) { el.innerHTML = '<li><span></span><span class="c">No times yet. Set the first one.</span></li>'; return; }
  el.innerHTML = r.rows.map((x, i) => `<li><span class="p">${i + 1}</span><span>${esc(x.player_name)} <span class="c">${esc((carById(x.car_id) || {}).name || x.car_id)} · ${esc((WEATHER[x.weather] || {}).label || x.weather)}</span></span><span></span><b>${fmt(x.time_ms / 1000)}</b></li>`).join('');
}
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/* ---------- toast ---------- */
let toastT = 0;
function toast(msg, sec = 2.2) { const t = $('toast'); t.textContent = msg; t.hidden = false; toastT = sec; }

/* ---------- drift score (from the original) ---------- */
function driftUpdate(dt) {
  const sp = Math.hypot(st.vx, st.vz);
  const beta = sp > 1 ? Math.atan2(st.vx * Math.cos(st.h) + st.vz * Math.sin(st.h), st.u) : 0;
  st.beta = beta; const bdeg = Math.abs(beta) * 180 / Math.PI;
  const offRoad = !['Asphalt', 'Concrete', 'Curb'].includes(surfName);
  if (combo > 0 && (offRoad || bdeg > 110)) { flash = 'lost'; flashT = 1.5; combo = 0; comboT = 0; }
  else if (sp > 8 && bdeg > 10 && bdeg < 110 && !offRoad && st.contact) { combo += sp * bdeg * dt * 0.5; comboT = 0.7; }
  else if (comboT > 0) { comboT -= dt; if (comboT <= 0 && combo > 0) { bestDrift = Math.max(bestDrift, Math.round(combo)); flash = 'banked'; flashT = 1.5; banked = Math.round(combo); combo = 0; } }
  if (flashT > 0) flashT -= dt;
}

/* ---------- skid marks (ring buffer, from the original) ---------- */
const SEG = 6000, skPos = new Float32Array(SEG * 18);
const skGeo = new THREE.BufferGeometry();
skGeo.setAttribute('position', new THREE.BufferAttribute(skPos, 3)); skGeo.setDrawRange(0, 0);
const skMesh = new THREE.Mesh(skGeo, new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }));
skMesh.frustumCulled = false; scene.add(skMesh);
let skN = 0, skDirty = false; const skLast = [null, null];
function skSeg(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1, px = -dz / len * 0.13, pz = dx / len * 0.13;
  const v = [a.x + px, a.y, a.z + pz, a.x - px, a.y, a.z - pz, b.x + px, b.y, b.z + pz, a.x - px, a.y, a.z - pz, b.x - px, b.y, b.z - pz, b.x + px, b.y, b.z + pz];
  skPos.set(v, (skN % SEG) * 18); skN++; skDirty = true;
}
function skids() {
  const sp = Math.hypot(st.vx, st.vz), fx = Math.sin(st.h), fz = -Math.cos(st.h), rx = Math.cos(st.h), rz = Math.sin(st.h);
  const paved = ['Asphalt', 'Concrete', 'Curb'].includes(surfName);
  [-1, 1].forEach((s, k) => {
    const p = { x: st.x - fx * car.B + rx * 0.8 * s, z: st.z - fz * car.B + rz * 0.8 * s, y: st.y - car.HCG + 0.05 };
    if (st.slip > 0.2 && sp > 2 && st.contact && paved) {
      const l = skLast[k];
      if (!l) skLast[k] = p; else { const d = Math.hypot(p.x - l.x, p.z - l.z); if (d > 0.35) { if (d < 4) skSeg(l, p); skLast[k] = p; } }
    } else skLast[k] = null;
  });
  if (skDirty) { skGeo.attributes.position.needsUpdate = true; skGeo.setDrawRange(0, Math.min(skN, SEG) * 6); skDirty = false; }
}

/* ---------- HUD ---------- */
const wheelRot = $('wheelRot');
let hudT = 0;
function hud(inp, dt) {
  const sp = Math.hypot(st.vx, st.vz), rpm = st.we * P.RPM;
  $('spd').textContent = Math.round(sp / MPH);
  $('gear').textContent = st.gear === -1 ? 'R' : st.gear === 0 ? 'N' : st.gear;
  const md = $('mode'), drifty = cfg.assist === 'off' && car.kfDrift != null;
  md.textContent = drifty ? 'DRIFT' : cfg.assist.toUpperCase(); md.classList.toggle('drift', drifty);
  $('rpmT').textContent = Math.round(rpm / 50) * 50;
  $('rpmF').style.width = clamp(rpm / (car.LIMIT + 800) * 100, 0, 100) + '%';
  $('rpmBar').querySelector('.red').style.left = (car.LIMIT / (car.LIMIT + 800) * 100) + '%';
  $('rpmBar').classList.toggle('shift', rpm > car.LIMIT - 400);
  $('boostF').style.width = (car.naFrac < 1 ? st.boost * 100 : 0) + '%';
  $('shiftMode').textContent = autoShiftOn() ? (paddleHold > 0 ? 'MANUAL' : 'AUTO') : 'MANUAL';
  const as = ASSIST[cfg.assist];
  const lamp = (id, has, on, act) => { const e = $(id); e.classList.toggle('off', !has || !on); e.classList.toggle('on', !!act); };
  lamp('lABS', car.abs, as.abs, st.absOn); lamp('lTC', car.tc, as.tc, st.tcOn); lamp('lESC', car.esc, as.esc, st.escOn);
  $('lPIT').hidden = !speedCap; $('lPIT').classList.toggle('on', !!speedCap);
  const deg = inp.wheel ? inp.steer * cfg.rotation / 2 : (lastInp.steerAngle * car.steerRatio / P.D2R);
  wheelRot.setAttribute('transform', `rotate(${deg.toFixed(1)})`);
  $('angle').textContent = `${deg < -0.5 ? 'L ' : deg > 0.5 ? 'R ' : ''}${Math.abs(deg).toFixed(0)}°`;
  for (const [k, f, p] of [['thr', 'fT', 'pT'], ['brk', 'fB', 'pB'], ['clu', 'fC', 'pC']]) { $(f).style.height = (inp[k] * 100) + '%'; $(p).textContent = Math.round(inp[k] * 100); }
  $('lEB').classList.toggle('on', inp.ebrake);
  hudT -= dt;
  if (hudT <= 0) {
    hudT = 0.2;
    $('info').textContent = `${surfName}${inWater > 0.05 ? ' ' + inWater.toFixed(1) + ' m' : ''} · tires ${Math.round(st.tempF)}/${Math.round(st.tempR)}°C · dmg ${Math.round(st.damage * 100)}%${weather.wet > 0.3 ? ' · wet' : ''}`;
  }
  const loop = mapDef.mode === 'loop';
  $('tCurL').textContent = loop ? 'Lap' : 'Run';
  $('tCur').textContent = run.started ? fmt(now - run.lapStart) : '–:–.–––';
  $('tCur').classList.toggle('bad', run.started && !run.valid);
  $('tLast').textContent = fmt(run.lastLap); $('tBest').textContent = fmt(run.best);
  $('tLapsL').textContent = race.state ? 'Race lap' : 'Laps';
  $('tLaps').textContent = race.state ? `${Math.min(run.raceLaps + 1, race.laps)}/${race.laps}` : run.laps;
  const cps = world.checkpoints, g = cps[run.cp];
  $('tNext').textContent = g ? `${run.cp === 0 ? (loop ? 'line' : 'start') : 'CP ' + run.cp} · ${Math.round(Math.hypot(g.x - st.x, g.z - st.z))} m` : '–';
  $('tDrift').textContent = bestDrift.toLocaleString();
  const ban = $('banner');
  if (speedCap) { ban.hidden = false; ban.className = 'hud info'; ban.textContent = `PIT LANE ${Math.round(speedCap * 3.6)} KM/H`; }
  else if (darkness > 0.5) { ban.hidden = true; }
  else if (surfName === 'Grass' && mapDef.generator === 'circuit' || surfName === 'Gravel' && mapDef.generator === 'circuit') { ban.hidden = false; ban.className = 'hud'; ban.textContent = 'OFF TRACK'; }
  else ban.hidden = true;
  const dr = $('drift');
  if (combo > 0) { dr.hidden = false; dr.className = 'hud'; $('dScore').textContent = Math.round(combo).toLocaleString(); $('dSub').textContent = `DRIFT ${Math.round(Math.abs(st.beta) * 180 / Math.PI)}°`; }
  else if (flashT > 0) { dr.hidden = false; dr.className = 'hud ' + flash; $('dScore').textContent = flash === 'lost' ? 'LOST' : '+' + banked.toLocaleString(); $('dSub').textContent = flash === 'lost' ? 'Spun or went off' : 'DRIFT BANKED'; }
  else dr.hidden = true;
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').hidden = true; }
}

/* ---------- minimap ---------- */
const mm = $('minimap'), mctx = mm.getContext('2d');
let mmT = 0;
let mmErr = false;
function minimap(dt) { try { minimap2(dt); } catch (e) { if (!mmErr) console.error('[r29] minimap', e); mmErr = true; } }
function minimap2(dt) {
  mm.hidden = !cfg.mini; if (!cfg.mini) return;
  mmT -= dt; if (mmT > 0) return; mmT = 1 / 20;
  const S = mm.width, R = S / 2, rad = mapDef.minimap_m, k = (R - 6) / rad;
  mctx.clearRect(0, 0, S, S);
  mctx.save(); mctx.beginPath(); mctx.arc(R, R, R - 2, 0, Math.PI * 2); mctx.clip();
  mctx.fillStyle = 'rgba(11,16,20,0.55)'; mctx.fillRect(0, 0, S, S);
  mctx.translate(R, R); mctx.rotate(-st.h); mctx.scale(k, k); mctx.translate(-st.x, -st.z);
  mctx.lineCap = 'round'; mctx.lineJoin = 'round';
  const lim = rad * 1.5;
  for (const L of world.minimapLines) {
    mctx.strokeStyle = L.kind === 'pit' ? '#556' : '#b9c3ca'; mctx.lineWidth = Math.max(L.w, 3 / k);
    mctx.beginPath(); let pen = false; const p = L.pts;
    for (let i = 2; i < p.length; i += 2) { // draw a segment unless both ends are off the same side of the view box
      const ax = p[i - 2] - st.x, az = p[i - 1] - st.z, bx = p[i] - st.x, bz = p[i + 1] - st.z;
      if ((ax > lim && bx > lim) || (ax < -lim && bx < -lim) || (az > lim && bz > lim) || (az < -lim && bz < -lim)) { pen = false; continue; }
      if (!pen) { mctx.moveTo(p[i - 2], p[i - 1]); pen = true; }
      mctx.lineTo(p[i], p[i + 1]);
    }
    mctx.stroke();
  }
  const dot = (x, z, r, c) => { mctx.fillStyle = c; mctx.beginPath(); mctx.arc(x, z, r / k, 0, Math.PI * 2); mctx.fill(); };
  const g = world.checkpoints[run.cp]; if (g) dot(g.x, g.z, 6, '#ffb21f');
  for (const a of traffic.list) dot(a.x, a.z, 3, '#7b8790');
  for (const [, gh] of ghosts) dot(gh.x, gh.z, 5, hex(gh.color));
  if (ghost && ghost.pos && ghostModel && ghostModel.group.visible) dot(ghost.pos[0], ghost.pos[1], 4, '#ffffff');
  mctx.restore();
  mctx.fillStyle = '#ffb21f'; mctx.beginPath(); mctx.moveTo(R, R - 9); mctx.lineTo(R + 6, R + 7); mctx.lineTo(R - 6, R + 7); mctx.closePath(); mctx.fill();
}

/* ---------- time of day, weather, particles ---------- */
const cDay = new THREE.Color(0xb4cddc), cNight = new THREE.Color(0x0b1322), cDusk = new THREE.Color(0xe59a68), cTmp = new THREE.Color(), cFog = new THREE.Color();
let dayK = 1;
function environment(dt) {
  if (timeDef.cycle && !paused) hour = (hour + dt / 60) % 24; // one real minute per in-game hour
  const elev = Math.sin((hour - 6) / 12 * Math.PI), day = clamp(elev * 1.8 + 0.25, 0, 1), dusk = clamp(1 - Math.abs(elev) * 3.2, 0, 1) * (elev > -0.3 ? 1 : 0);
  dayK = day;
  const skyK = weather.sky ?? 1;
  cTmp.copy(cNight).lerp(cDay, day); cTmp.lerp(cDusk, dusk * 0.45);
  if (skyK < 1) cTmp.lerp(new THREE.Color(0x8a939a).multiplyScalar(0.3 + 0.7 * day), 1 - skyK);
  cFog.copy(cTmp); if (weather.fogTint) cFog.lerp(new THREE.Color(weather.fogTint).multiplyScalar(0.25 + 0.75 * day), 0.7);
  scene.background.copy(cFog); scene.fog.color.copy(cFog);
  const [fn, ff] = weather.fog; scene.fog.near = fn; scene.fog.far = ff * (0.55 + 0.45 * day);
  const dark = darkness;
  hemi.intensity = (0.16 + 0.7 * day) * (0.55 + 0.45 * skyK) * (1 - 0.7 * dark);
  sun.intensity = (0.03 + 0.78 * day * skyK) * (1 - 0.9 * dark);
  sun.color.setRGB(1, lerp(0.75, 1, day), lerp(0.55, 1, day));
  const az = (hour / 24) * Math.PI * 2;
  sun.position.set(st.x + Math.cos(az) * 400, 60 + 500 * Math.max(0.05, elev), st.z + Math.sin(az) * 400); sun.target.position.set(st.x, 0, st.z); sun.target.updateMatrixWorld();
  if (skyRing) { skyRing.material.color.setScalar(0.18 + 0.82 * day); skyRing.visible = scene.fog.far > 600; }
  const lightsOn = day < 0.5 || dark > 0.3 || weather.fog[1] < 300;
  headlight.intensity = lightsOn ? 2.4 : 0;
  if (model) for (const m of model.lights) if (m.userData.rear) m.material.color.setHex(lastInp.brk > 0.1 ? 0xff2a2a : lightsOn ? 0xc41f1f : 0x801010);
  if (world.windowMats) for (const m of world.windowMats) m.emissiveIntensity = (1 - day) * 0.9;
  if (world.lamps) world.lamps.visible = day < 0.55;
}
let particles = null, flakeTex = null;
function clearParticles() { if (particles) { scene.remove(particles.obj); particles.obj.geometry.dispose(); particles.obj.material.dispose(); } particles = null; }
function initParticles() {
  const kind = weather.rain ? 'rain' : weather.snowfall ? 'snow' : weather.dustfall ? 'dust' : null; if (!kind) return;
  const N = cfg.qual === 'low' ? 1200 : 3000, pos = new Float32Array(N * (kind === 'rain' ? 6 : 3)), off = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { off[i * 3] = (Math.random() - 0.5) * 60; off[i * 3 + 1] = Math.random() * 30; off[i * 3 + 2] = (Math.random() - 0.5) * 60; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (!flakeTex) { const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d'), gr = x.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 32, 32); flakeTex = new THREE.CanvasTexture(c); }
  const obj = kind === 'rain' ? new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xaab8c4, transparent: true, opacity: 0.45 }))
    : new THREE.Points(g, new THREE.PointsMaterial({ color: kind === 'snow' ? 0xffffff : 0xc9a47c, size: kind === 'snow' ? 0.09 : 0.14, map: flakeTex, transparent: true, depthWrite: false, opacity: kind === 'snow' ? 0.95 : 0.55 }));
  obj.frustumCulled = false; scene.add(obj);
  particles = { kind, obj, off, N };
}
function updateParticles(dt) {
  if (!particles) return;
  const { kind, off, N } = particles, a = particles.obj.geometry.attributes.position.array, cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
  const fall = kind === 'rain' ? 22 : kind === 'snow' ? 1.6 : 0.6, wx = kind === 'dust' ? 9 : 0;
  for (let i = 0; i < N; i++) {
    let y = off[i * 3 + 1] - fall * dt, x = off[i * 3] + (wx - st.vx * 0.15) * dt + (kind === 'snow' ? Math.sin(now * 1.3 + i) * 0.4 * dt : 0), z = off[i * 3 + 2] - st.vz * 0.15 * dt;
    if (y < -3) y += 30; if (x < -30) x += 60; if (x > 30) x -= 60; if (z < -30) z += 60; if (z > 30) z -= 60;
    off[i * 3] = x; off[i * 3 + 1] = y; off[i * 3 + 2] = z;
    if (kind === 'rain') { const k = i * 6; a[k] = cx + x; a[k + 1] = cy + y - 8; a[k + 2] = cz + z; a[k + 3] = cx + x + st.vx * 0.02; a[k + 4] = cy + y - 8.5; a[k + 5] = cz + z + st.vz * 0.02; }
    else { const k = i * 3; a[k] = cx + x; a[k + 1] = cy + y - 8; a[k + 2] = cz + z; }
  }
  particles.obj.geometry.attributes.position.needsUpdate = true;
  particles.obj.visible = darkness < 0.6;
}

/* ---------- sound ---------- */
let au = null;
$('soundBtn').onclick = () => {
  const btn = $('soundBtn');
  if (!au) {
    const Cx = window.AudioContext || window.webkitAudioContext; if (!Cx) { btn.textContent = 'No audio'; return; }
    const ctx = new Cx(), master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(); o1.type = 'sawtooth'; o2.type = 'square';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 800;
    const g2 = ctx.createGain(); g2.gain.value = 0.5; const eg = ctx.createGain(); eg.gain.value = 0.08;
    o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(eg); eg.connect(master);
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const ns = ctx.createBufferSource(); ns.buffer = buf; ns.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1100; bp.Q.value = 3;
    const sg = ctx.createGain(); sg.gain.value = 0; ns.connect(bp); bp.connect(sg); sg.connect(master);
    const ns2 = ctx.createBufferSource(); ns2.buffer = buf; ns2.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 3200; hp.Q.value = 1.5;
    const tg = ctx.createGain(); tg.gain.value = 0; ns2.connect(hp); hp.connect(tg); tg.connect(master);
    o1.start(); o2.start(); ns.start(); ns2.start();
    au = { ctx, o1, o2, lp, eg, sg, tg, master, buf, on: true };
  } else { au.on = !au.on; au.on ? au.ctx.resume() : au.ctx.suspend(); }
  btn.textContent = au.on ? 'Sound on' : 'Sound off';
};
function updateAudio(inp) {
  if (!au || !au.on) return;
  const t = au.ctx.currentTime, rpm = st.we * P.RPM, cyl = spec.class.includes('Muscle') || spec.id === 'nordvik-gt' ? 4 : spec.id === 'delorean-dmc12' || spec.id === 'vesper-s4' || spec.id === 'trailhawk-250' ? 3 : 2;
  const f = rpm / 60 * cyl;
  au.o1.frequency.setTargetAtTime(f, t, 0.02); au.o2.frequency.setTargetAtTime(f / 2, t, 0.02);
  au.lp.frequency.setTargetAtTime(350 + inp.thr * 2200 + rpm * 0.1, t, 0.03);
  au.eg.gain.setTargetAtTime(paused ? 0 : 0.05 + inp.thr * 0.12, t, 0.03);
  au.sg.gain.setTargetAtTime(paused ? 0 : st.slip * 0.22, t, 0.05);
  au.tg.gain.setTargetAtTime(paused ? 0 : (car.naFrac < 1 ? st.boost * 0.035 : 0), t, 0.08);
}
function playThump(dv) {
  if (!au || !au.on) return;
  const s = au.ctx.createBufferSource(); s.buffer = au.buf; const g = au.ctx.createGain(), f = au.ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 500; g.gain.value = Math.min(0.9, dv * 0.08);
  g.gain.setTargetAtTime(0, au.ctx.currentTime + 0.05, 0.08); s.connect(f); f.connect(g); g.connect(au.master); s.start(); s.stop(au.ctx.currentTime + 0.5);
}

/* ---------- online: presence, other players, races ---------- */
const PALETTE = [0xe8453c, 0x2f7de1, 0xf2c230, 0x3ddc84, 0xb05ce6, 0xff8a2b, 0x25c6d9, 0xf26bb5];
const myId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const myColor = PALETTE[Math.floor(Math.random() * PALETTE.length)];
const hex = c => '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
if (!cleanName(cfg.name)) cfg.name = 'Driver ' + Math.floor(1000 + Math.random() * 9000);
const myName = () => cleanName(cfg.name) || 'Driver';
const roomName = () => (cleanName(cfg.room).replace(/[^\w-]/g, '').slice(0, 24)) || (new URLSearchParams(location.search).get('room') || 'main').replace(/[^\w-]/g, '').slice(0, 24) || 'main';
const net = { ch: null, ready: false, sendT: 0, last: null, sig: '', trackT: 0, key: '' };
const ghosts = new Map();
function makeLabel(text, color) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 112; const g = c.getContext('2d');
  g.font = '600 56px "Chakra Petch", "Arial Narrow", Arial, sans-serif';
  const w = Math.min(500, g.measureText(text).width + 56);
  g.fillStyle = 'rgba(10,14,18,0.72)'; g.fillRect((512 - w) / 2, 8, w, 96); g.fillStyle = hex(color); g.fillRect((512 - w) / 2, 8, 10, 96);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 261, 58, 460);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthWrite: false, fog: false }));
  s.scale.set(5.6, 1.23, 1); s.position.y = 2.9; return s;
}
function ghostFor(p) {
  let gh = ghosts.get(p.id);
  if (gh && gh.car !== p.car) { removeGhost(p.id); gh = null; }
  if (gh) return gh;
  const sp = carById(p.car), color = Number.isFinite(p.c) ? p.c : 0x888888;
  const m = makeModelFor(sp, { color }); scene.add(m.group);
  gh = { id: p.id, car: sp.id, m, color, name: '', label: null, x: p.x, z: p.z, y: p.y || 0, h: p.h, tx: p.x, tz: p.z, ty: p.y || 0, th: p.h, vx: 0, vz: 0, r: 0, t: performance.now(),
    len: sp.visual.length, wid: sp.visual.width, mass: sp.mass_kg };
  ghosts.set(p.id, gh); return gh;
}
function setGhostName(gh, name) {
  name = cleanName(name) || 'Driver'; if (gh.name === name) return; gh.name = name;
  if (gh.label) { gh.m.group.remove(gh.label); gh.label.material.map.dispose(); gh.label.material.dispose(); }
  gh.label = makeLabel(name, gh.color); gh.m.group.add(gh.label);
}
function removeGhost(id) { const gh = ghosts.get(id); if (!gh) return; scene.remove(gh.m.group); disposeGroup(gh.m.group); ghosts.delete(id); }
function clearGhosts() { for (const id of [...ghosts.keys()]) removeGhost(id); }
function onState(p) {
  if (!p || typeof p.id !== 'string' || p.id === myId || ![p.x, p.z, p.h].every(Number.isFinite)) return;
  const gh = ghostFor(p); setGhostName(gh, p.n);
  gh.tx = p.x; gh.tz = p.z; gh.ty = +p.y || 0; gh.th = p.h; gh.vx = +p.vx || 0; gh.vz = +p.vz || 0; gh.r = +p.r || 0; gh.t = performance.now();
  if (Math.hypot(gh.x - p.x, gh.z - p.z) > 40) { gh.x = p.x; gh.z = p.z; gh.y = gh.ty; gh.h = p.h; }
}
function updateGhosts(dt) {
  const t = performance.now(), k = 1 - Math.exp(-dt * 14);
  for (const [id, gh] of ghosts) {
    if (t - gh.t > 6000) { removeGhost(id); continue; }
    const age = Math.min((t - gh.t) / 1000, 0.35);
    const px = gh.tx + gh.vx * age, pz = gh.tz + gh.vz * age, ph = gh.th + gh.r * age;
    gh.x += (px - gh.x) * k; gh.z += (pz - gh.z) * k; gh.y += (gh.ty - gh.y) * k;
    gh.h += Math.atan2(Math.sin(ph - gh.h), Math.cos(ph - gh.h)) * k;
    gh.m.group.position.set(gh.x, gh.y, gh.z); gh.m.group.rotation.set(0, -gh.h, 0);
  }
}
function setNet(cls, text) { $('netDot').className = cls; $('netStatus').textContent = text; }
function presenceList() { if (!net.ch) return []; const s = net.ch.presenceState(), out = []; for (const k in s) { const m = s[k][s[k].length - 1]; if (m) out.push(m); } return out; }
function renderRoster() {
  const list = presenceList();
  list.sort((a, b) => (a.best == null) - (b.best == null) || (a.best ?? 0) - (b.best ?? 0));
  $('roster').innerHTML = list.map(m => `<li class="${m.id === myId ? 'me' : ''}"><span class="sw" style="background:${hex(m.color)}"></span><span class="who">${esc(cleanName(m.name) || 'Driver')} <small>${esc((carById(m.car) || {}).name || '')}</small></span><b>${fmt(Number.isFinite(m.best) ? m.best : null)}</b></li>`).join('');
  if (net.ready) setNet('ok', `Online · ${mapDef.name.split(' ')[0]} · ${roomName() === 'main' ? '' : roomName() + ' · '}${list.length} driver${list.length === 1 ? '' : 's'}`);
  $('raceBtn').disabled = !net.ready || !!race.state;
}
function trackPresence() { if (!net.ready) return; net.trackT = now; net.ch.track({ id: myId, name: myName(), color: myColor, car: spec.id, best: run.best, laps: run.laps }).catch(() => {}); }
function joinNet() {
  const key = `r29:${mapDef.id}:${roomName()}`;
  if (net.ch && net.key === key) return;
  if (net.ch) { try { net.ch.unsubscribe(); sb.removeChannel(net.ch); } catch (e) {} net.ch = null; net.ready = false; }
  clearGhosts();
  net.key = key;
  if (!sb) { setNet('err', 'Offline · could not load'); return; }
  setNet('', 'Connecting…');
  const ch = sb.channel(key, { config: { broadcast: { self: false, ack: false }, presence: { key: myId } } });
  ch.on('broadcast', { event: 's' }, msg => onState(msg && msg.payload));
  ch.on('broadcast', { event: 'race' }, msg => onRace(msg && msg.payload));
  ch.on('broadcast', { event: 'fin' }, msg => onFinish(msg && msg.payload));
  ch.on('presence', { event: 'sync' }, renderRoster);
  ch.on('presence', { event: 'leave' }, ({ key: k }) => removeGhost(k));
  ch.subscribe(status => {
    if (status === 'SUBSCRIBED') { net.ready = true; net.sendT = 0; trackPresence(); renderRoster(); }
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { net.ready = false; setNet('err', 'Reconnecting…'); }
    else if (status === 'CLOSED') { net.ready = false; setNet('err', 'Offline'); }
  });
  net.ch = ch;
}
function netTick(dt) {
  if (!net.ready) return;
  const sig = `${run.best}|${run.laps}|${spec.id}`;
  if (sig !== net.sig && now - net.trackT > 1) { net.sig = sig; trackPresence(); }
  net.sendT -= dt; if (net.sendT > 0) return;
  const r2 = v => Math.round(v * 100) / 100;
  const p = { id: myId, n: myName(), c: myColor, car: spec.id, x: r2(st.x), z: r2(st.z), y: r2(st.y - car.HCG), h: Math.round(st.h * 1000) / 1000, vx: r2(st.vx), vz: r2(st.vz), r: Math.round(st.r * 1000) / 1000 };
  const l = net.last, still = l && Math.hypot(st.vx, st.vz) < 0.05 && Math.abs(l.x - p.x) < 0.02 && Math.abs(l.z - p.z) < 0.02 && l.n === p.n && l.car === p.car;
  net.sendT = still ? 1 : 1 / 8; net.last = p;
  net.ch.send({ type: 'broadcast', event: 's', payload: p }).catch(() => {});
}
addEventListener('pagehide', () => { try { net.ch && net.ch.untrack(); } catch (e) {} });

const race = { state: null, id: '', laps: 1, goAt: 0, startNow: 0, results: [] };
$('raceBtn').onclick = () => {
  if (!net.ready || race.state) return;
  const msg = { id: myId.slice(0, 8) + Date.now().toString(36), by: myName(), laps: mapDef.mode === 'loop' ? cfg.laps : 1, delay: 6 };
  net.ch.send({ type: 'broadcast', event: 'race', payload: msg }).catch(() => {});
  onRace(msg);
};
function onRace(m) {
  if (!m || typeof m.id !== 'string' || race.id === m.id || !ready) return;
  const list = presenceList().map(p => p.id).filter(Boolean); if (!list.includes(myId)) list.push(myId); list.sort();
  const slot = clamp(list.indexOf(myId), 0, world.grid.length - 1);
  Object.assign(race, { state: 'countdown', id: m.id, laps: clamp(+m.laps || 1, 1, 20), goAt: performance.now() / 1000 + clamp(+m.delay || 6, 3, 10), results: [] });
  hideMenu(); setup.hidden = true; $('results').hidden = true;
  placeAt(world.grid[slot]); resetRun(); frozen = true;
  toast(`${esc(m.by || 'Someone')} started a race · ${race.laps} lap${race.laps > 1 ? 's' : ''} · grid slot ${slot + 1}`, 4);
  renderRoster();
}
function raceTick() {
  if (!race.state) { $('countdown').hidden = true; return; }
  const cd = $('countdown'), left = race.goAt - performance.now() / 1000;
  if (race.state === 'countdown') {
    if (left > 0) { cd.hidden = false; cd.className = ''; cd.textContent = Math.ceil(left); }
    else { race.state = 'running'; race.startNow = now; frozen = false; cd.textContent = 'GO'; cd.className = 'go'; run.started = false; run.cp = 0; setTimeout(() => { if (race.state === 'running') cd.hidden = true; }, 900); }
  }
}
function raceProgress() {
  const done = mapDef.mode === 'loop' ? run.raceLaps >= race.laps : run.finished;
  if (!done || race.state !== 'running') return;
  const t = now - race.startNow, fin = { race: race.id, id: myId, name: myName(), car: spec.id, time: +t.toFixed(3) };
  race.state = 'finished';
  if (net.ready) net.ch.send({ type: 'broadcast', event: 'fin', payload: fin }).catch(() => {});
  onFinish(fin);
}
function onFinish(f) {
  if (!f || f.race !== race.id || !race.state) return;
  if (!race.results.some(r => r.id === f.id)) race.results.push(f);
  race.results.sort((a, b) => a.time - b.time);
  const el = $('results'); el.hidden = false;
  el.innerHTML = `<h3>Race results</h3><ol class="lb">${race.results.map((r, i) => `<li><span class="p">${i + 1}</span><span>${esc(r.name)} <span class="c">${esc(carById(r.car).name)}</span></span><span></span><b>${fmt(r.time)}</b></li>`).join('')}</ol>` +
    `<div class="foot"><button type="button" id="resClose">Close</button></div>`;
  $('resClose').onclick = () => { el.hidden = true; race.state = null; renderRoster(); };
  if (race.state !== 'finished') toast(`${f.name} finished in ${fmt(f.time)}`, 2.5);
}
// mid-race fixes: pit limiter or race state should never leave the player frozen forever
setInterval(() => { if (frozen && race.state !== 'countdown') frozen = false; }, 1000);

/* ---------- cameras ---------- */
const eul = new THREE.Euler(0, 0, 0, 'YXZ'), q1 = new THREE.Quaternion(), v1 = new THREE.Vector3();
let chase = null, smPitch = 0, smRoll = 0;
function placeModelAndCamera(dt) {
  const fx = Math.sin(st.h), fz = -Math.cos(st.h);
  const k = 1 - Math.exp(-dt * (st.contact ? 12 : 2));
  smPitch += (terrPitch - smPitch) * k; smRoll += (terrRoll - smRoll) * k;
  const bodyP = reduceMotion ? 0 : clamp(st.pit * 0.0029, -0.05, 0.05), bodyR = reduceMotion ? 0 : clamp(st.rol * 0.0046, -0.07, 0.07);
  const groundY = st.y - car.HCG;
  model.group.position.set(st.x, groundY, st.z);
  eul.set(smPitch + bodyP, -st.h, smRoll + bodyR); model.group.quaternion.setFromEuler(eul);
  const sp = Math.hypot(st.vx, st.vz);
  model.spin(st.wr * car.RW * dt);
  const bump = (surfName !== 'Asphalt' && surfName !== 'Concrete' && surfName !== 'Curb') && !reduceMotion ? (Math.random() - 0.5) * Math.min(sp, 20) * 0.003 : 0;
  model.group.visible = cfg.cam !== 'cockpit';
  $('wheel').style.visibility = cfg.cam === 'chase' ? 'hidden' : '';
  if (cfg.cam === 'chase') {
    const want = v1.set(st.x - fx * 6.8, groundY + 2.5, st.z - fz * 6.8);
    if (!chase || chase.distanceTo(want) > 25) chase = want.clone(); else chase.lerp(want, 1 - Math.exp(-dt * 6));
    const gy = world.ground(chase.x, chase.z, chase.y).h; if (chase.y < gy + 1) chase.y = gy + 1;
    cam.position.copy(chase); cam.lookAt(st.x + fx * 3, groundY + 1.0, st.z + fz * 3);
  } else {
    chase = null;
    const eye = cfg.cam === 'hood' ? { f: car.A + 0.3, h: spec.physics.eye_height_m - 0.12 } : { f: -0.35, h: spec.physics.eye_height_m + (+cfg.seat || 0) };
    eul.set(smPitch + bodyP * 0.6, -st.h, smRoll + bodyR * 0.6); q1.setFromEuler(eul);
    v1.set(0, eye.h + bump, -eye.f).applyQuaternion(q1);
    cam.position.set(st.x + v1.x, groundY + v1.y, st.z + v1.z); cam.quaternion.copy(q1);
  }
  headlight.position.set(st.x + fx * 2, groundY + 0.8, st.z + fz * 2);
  headlight.target.position.set(st.x + fx * 40, groundY - 1, st.z + fz * 40); headlight.target.updateMatrixWorld();
  if (skyRing) { skyRing.position.x = cam.position.x; skyRing.position.z = cam.position.z; skyRing.position.y = cam.position.y + 150; }
  if (world.oceanMesh) { world.oceanMesh.position.x = cam.position.x; world.oceanMesh.position.z = cam.position.z; }
}

/* ---------- menus + showroom ---------- */
const show = { scene: new THREE.Scene(), cam: new THREE.PerspectiveCamera(36, 1, 0.1, 200), model: null, id: '' };
show.scene.background = new THREE.Color(0x10161b);
show.scene.add(new THREE.HemisphereLight(0xdfefff, 0x202830, 0.9));
const sl = new THREE.DirectionalLight(0xffffff, 0.9); sl.position.set(5, 8, 6); show.scene.add(sl);
const floor = new THREE.Mesh(new THREE.CircleGeometry(7, 64), new THREE.MeshLambertMaterial({ color: 0x1d262d })); floor.rotation.x = -Math.PI / 2; show.scene.add(floor);
const ring = new THREE.Mesh(new THREE.RingGeometry(6.6, 6.75, 64), new THREE.MeshBasicMaterial({ color: 0xffb21f })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01; show.scene.add(ring);
function showroomCar(id) { if (show.id === id) return; show.id = id; if (show.model) show.scene.remove(show.model.group); show.model = makeModelFor(carById(id)); show.scene.add(show.model.group); }
let curScr = 'scrMain', selCar = cfg.carId, selMap = cfg.mapId;
function showMenu(scr) {
  document.body.classList.add('inmenu'); paused = true; curScr = scr;
  document.querySelectorAll('.scr').forEach(s => s.classList.toggle('on', s.id === scr));
  if (scr === 'scrMain') renderMain();
  if (scr === 'scrCar') renderCars();
  if (scr === 'scrMap') renderMaps();
  if (scr === 'scrSettings') renderSettings();
  if (scr === 'scrLb') renderLbScreen();
  if (scr === 'scrPause') $('pauseSub').textContent = `${mapDef.name} · ${spec.name} · ${weather.label} · ${cfg.mode === 'trial' ? 'Time trial' : 'Free roam'}`;
}
function hideMenu() { document.body.classList.remove('inmenu'); paused = false; last = performance.now(); }
function togglePause() {
  if (!ready) return;
  if (document.body.classList.contains('inmenu')) { if (curScr === 'scrPause') hideMenu(); else showMenu('scrPause'); }
  else showMenu('scrPause');
}
document.querySelectorAll('#menu .back').forEach(b => b.onclick = () => showMenu(ready && curScr !== 'scrMain' && document.body.dataset.from === 'pause' ? 'scrPause' : 'scrMain'));
const goFrom = (from, scr) => { document.body.dataset.from = from; showMenu(scr); };
function renderMain() {
  const sp = carById(cfg.carId), m = mapById(cfg.mapId);
  $('mCarName').textContent = `${sp.name} · ${sp.class}`; $('mMapName').textContent = m.name;
  $('mSummary').textContent = `${sp.name} at ${m.name}`;
  $('nameIn').value = myName(); $('roomIn').value = cfg.room || '';
  showroomCar(cfg.carId);
}
$('mDrive').onclick = async () => { if (ready && world && mapDef.id === cfg.mapId) { if (spec.id !== cfg.carId) setCar(cfg.carId, true); hideMenu(); } else { await loadMap(cfg.mapId); hideMenu(); } };
$('mCar').onclick = () => goFrom('main', 'scrCar'); $('mMap').onclick = () => goFrom('main', 'scrMap');
$('mLb').onclick = () => goFrom('main', 'scrLb'); $('mSettings').onclick = () => goFrom('main', 'scrSettings');
$('mWheel').onclick = () => { setup.hidden = false; };
$('nameIn').onchange = e => { const v = cleanName(e.target.value); if (v) { cfg.name = v; save(); trackPresence(); net.sendT = 0; } e.target.value = myName(); };
$('roomIn').onchange = e => { cfg.room = cleanName(e.target.value).replace(/[^\w-]/g, ''); e.target.value = cfg.room; save(); if (ready) joinNet(); };

function renderCars() {
  $('carCards').innerHTML = VEH.map(v => `<button type="button" class="card${v.id === selCar ? ' sel' : ''}" data-id="${v.id}"><b><span class="swatch" style="background:${hex(v.visual.color)}"></span>${esc(v.name)}</b><span>${esc(v.class)}</span><span>${v.drivetrain} · ${v.engine_power_hp} hp · ${v.mass_kg} kg</span></button>`).join('');
  $('carCards').querySelectorAll('.card').forEach(b => b.onclick = () => { selCar = b.dataset.id; renderCars(); });
  const v = carById(selCar), m = v.validated || {}, T = P.TIRES[v.tire_type] || {};
  const chk = (sim, tgt, tol) => Math.abs(sim / tgt - 1) <= tol ? 'ok' : 'warn';
  $('carSpec').innerHTML = `
    <tr><th>Class</th><td>${esc(v.class)} · ${v.drivetrain}</td></tr>
    <tr><th>Engine</th><td>${v.engine_power_hp} hp · ${m.peak_torque_nm || v.torque_nm} N·m</td></tr>
    <tr><th>Mass · weight front</th><td>${v.mass_kg} kg · ${v.front_weight_distribution_percent}%</td></tr>
    <tr><th>Gearbox</th><td>${v.gear_count}-speed ${v.transmission_type.replace('_', '-')}</td></tr>
    <tr><th>Tires</th><td>${esc(T.label || v.tire_type)}</td></tr>
    <tr><th>Aids</th><td>${[v.abs && 'ABS', v.traction_control && 'TC', v.stability_control && 'Stability'].filter(Boolean).join(' · ') || 'None'}</td></tr>
    <tr><th>0–60 mph target · sim</th><td class="${chk(m.zero_to_sixty_s, v.acceleration_0_60_mph_s, 0.05)}">${v.acceleration_0_60_mph_s} s · ${m.zero_to_sixty_s} s</td></tr>
    <tr><th>Top speed target · sim</th><td class="${chk(m.top_speed_mph, v.top_speed_mph, 0.03)}">${v.top_speed_mph} · ${m.top_speed_mph} mph</td></tr>
    <tr><th>60–0 mph target · sim</th><td class="${chk(m.braking_60_0_ft, v.braking_distance_60_0_ft, 0.03)}">${v.braking_distance_60_0_ft} · ${m.braking_60_0_ft} ft</td></tr>`;
  showroomCar(selCar);
}
$('carOk').onclick = () => { cfg.carId = selCar; save(); if (ready) { setCar(selCar, true); loadGhost(); resetRun(); } showMenu(document.body.dataset.from === 'pause' && ready ? 'scrPause' : 'scrMain'); };

function renderMaps() {
  $('mapCards').innerHTML = MAPS.map(m => `<button type="button" class="card${m.id === selMap ? ' sel' : ''}" data-id="${m.id}"><b>${esc(m.name)}</b><span>${esc(m.environment_type)}</span><span>${esc(m.dimensions)}</span></button>`).join('');
  $('mapCards').querySelectorAll('.card').forEach(b => b.onclick = () => { selMap = b.dataset.id; renderMaps(); });
  const m = mapById(selMap);
  $('mapSub').textContent = m.elevation_profile.description;
  $('mapSpec').innerHTML = `
    <tr><th>Size</th><td>${esc(m.dimensions)}</td></tr>
    <tr><th>Surfaces</th><td>${esc(m.road_surface_types.join(', '))}</td></tr>
    <tr><th>Elevation</th><td>${m.elevation_profile.min_m}–${m.elevation_profile.max_m} m · max grade ${Math.round(m.elevation_profile.max_grade * 100)}%</td></tr>
    <tr><th>Hazards</th><td>${esc(m.hazards.join(', '))}</td></tr>`;
  $('oMode').value = cfg.mode;
  $('oWeather').innerHTML = m.weather_presets.map(w => `<option value="${w}">${WEATHER[w].label}</option>`).join(''); $('oWeather').value = cfg.weather[m.id] || m.weather_presets[0];
  $('oTime').innerHTML = m.time_presets.map(w => `<option value="${w}">${TIMES[w].label}</option>`).join(''); $('oTime').value = cfg.time[m.id] || m.time_presets[0];
  $('oTraffic').value = String(cfg.traffic); if (!m.traffic_density) $('oTraffic').value = 'map';
  $('oTraffic').disabled = !m.traffic_density;
  $('oSpawn').innerHTML = m.spawn_points.map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join('');
  $('oLaps').value = String(cfg.laps); $('oLaps').disabled = m.mode !== 'loop';
  renderLb($('mapLb'), m.id, null);
}
$('mapGo').onclick = async () => {
  const m = mapById(selMap);
  cfg.mode = $('oMode').value; cfg.weather[m.id] = $('oWeather').value; cfg.time[m.id] = $('oTime').value;
  if (!$('oTraffic').disabled) cfg.traffic = $('oTraffic').value; cfg.laps = +$('oLaps').value; save();
  await loadMap(m.id, { spawn: cfg.mode === 'trial' ? null : +$('oSpawn').value }); hideMenu();
};
function renderSettings() {
  $('sAssist').value = cfg.assist; $('sShift').value = cfg.shift; $('sCam').value = cfg.cam; $('sSeat').value = cfg.seat; $('sGhost').value = String(cfg.ghost); $('sMini').value = String(cfg.mini); $('sQual').value = cfg.qual;
}
for (const [id, key, num] of [['sAssist', 'assist'], ['sShift', 'shift'], ['sCam', 'cam'], ['sSeat', 'seat', 1], ['sGhost', 'ghost', 1], ['sMini', 'mini', 1], ['sQual', 'qual']])
  $(id).addEventListener(id === 'sSeat' ? 'input' : 'change', e => { cfg[key] = num ? +e.target.value : e.target.value; save(); if (key === 'qual') toast('Quality applies after reloading the page'); });
function renderLbScreen() {
  $('lbMap').innerHTML = MAPS.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join(''); $('lbMap').value = cfg.mapId;
  $('lbCar').innerHTML = '<option value="">All cars</option>' + VEH.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  renderLb($('lbList'), $('lbMap').value, $('lbCar').value || null);
}
$('lbMap').onchange = $('lbCar').onchange = () => renderLb($('lbList'), $('lbMap').value, $('lbCar').value || null);
$('pResume').onclick = () => hideMenu();
$('pRestart').onclick = () => { if (race.state) return; placeAt(cfg.mode === 'trial' || mapDef.mode === 'point' ? world.grid[0] : world.spawns[0]); st.damage = 0; st.pull = 0; model.repair(); resetRun(); hideMenu(); };
$('pReset').onclick = () => { resetToRoad(); hideMenu(); };
$('pRepair').onclick = () => { st.damage = 0; st.pull = 0; model.repair(); if (run.started) run.valid = false; toast('Repaired'); hideMenu(); };
$('pCar').onclick = () => { selCar = cfg.carId; goFrom('pause', 'scrCar'); };
$('pMap').onclick = () => { selMap = cfg.mapId; goFrom('pause', 'scrMap'); };
$('pSettings').onclick = () => goFrom('pause', 'scrSettings');
$('pMain').onclick = () => { document.body.dataset.from = 'main'; showMenu('scrMain'); };
$('menuBtn').onclick = () => togglePause();
$('camBtn').onclick = () => cycleCam();

/* ---------- main loop ---------- */
let last = performance.now();
let qaInput = null;
let qaAuto = 0;
function autopilot() { // test driver: pure-pursuit along the nearest road, speed from curvature ahead
  const sp = Math.hypot(st.vx, st.vz), q = world.nearest(st.x, st.z), out = { thr: 0, brk: 0, clu: 0, ebrake: false, wheel: true, steer: 0, kb: 0 };
  if (!q) { out.brk = 1; return out; }
  let tx, tz, vT = qaAuto;
  const Ld = 7 + sp * 0.55;
  if (q.city) {
    const fx = Math.sin(st.h), fz = -Math.cos(st.h);
    if (q.axis === 'z') { const d = fz < 0 ? -1 : 1; tx = q.c + (d < 0 ? 1.75 : -1.75); tz = st.z + d * Ld; } else { const d = fx > 0 ? 1 : -1; tz = q.c + (d > 0 ? 1.75 : -1.75); tx = st.x + d * Ld; }
  } else {
    const r = q.road, dir = Math.cos(st.h - Math.atan2(r.tx[q.i], -r.tz[q.i])) >= 0 ? 1 : -1, sp2 = r.len / r.n;
    const ii = k => r.closed ? r.idx(k) : clamp(k, 0, r.n - 1);
    const i2 = ii(Math.round((q.s + dir * Ld) / sp2)), lat = r.twoWay && r.kind === 'road' ? dir * r.laneW / 2 : 0;
    tx = r.x[i2] + -r.tz[i2] * lat; tz = r.z[i2] + r.tx[i2] * lat;
    let km = 0; for (let d = 0; d < 40 + sp * 2.2; d += 6) km = Math.max(km, Math.abs(r.k[ii(Math.round((q.s + dir * d) / sp2))]));
    if (km > 1e-4) vT = Math.min(vT, Math.sqrt(0.7 * 9.81 * (weather.wet ? 0.7 : 1) * (weather.snow ? 0.4 : 1) / km));
  }
  const ang = Math.atan2(tx - st.x, -(tz - st.z)) - st.h, a = Math.atan2(Math.sin(ang), Math.cos(ang));
  const delta = Math.atan(2 * car.WB * Math.sin(a) / Ld);
  out.steer = clamp(delta / (cfg.rotation / 2 / car.steerRatio * P.D2R), -1, 1);
  out.thr = clamp((vT - sp) * 0.4, 0, 1); out.brk = clamp((sp - vT) * 0.25, 0, 1);
  return out;
}
function update(dt) {
  now += dt;
  const inp = readInput(dt);
  if (qaInput) Object.assign(inp, qaInput);
  if (qaAuto) Object.assign(inp, autopilot());
  const px = st.x, pz = st.z;
  physicsFrame(dt, inp);
  updateTraffic(dt);
  const others = traffic.list.slice(); for (const [, gh] of ghosts) others.push({ x: gh.x, z: gh.z, y: gh.y + car.HCG, h: gh.h, vx: gh.vx, vz: gh.vz, len: gh.len, wid: gh.wid, mass: gh.mass });
  collide(others);
  if (!frozen) checkGates(px, pz);
  recordGhost(dt); driftUpdate(dt); skids();
  updatePanel(inp.gp); hud(inp, dt); updateAudio(inp); netTick(dt); raceTick();
  if (world.updateLights) world.updateLights(now, st.x, st.z);
}
function frame(t) {
  const dt = Math.min(0.05, (t - last) / 1000); last = t;
  const inMenu = document.body.classList.contains('inmenu');
  const showroom = inMenu && (!ready || curScr === 'scrCar' || curScr === 'scrMain' && !ready);
  if (showroom) {
    if (!show.model) showroomCar(cfg.carId);
    const a = t / 1000 * 0.25, w = innerWidth, h = innerHeight;
    show.cam.aspect = w / h; show.cam.position.set(Math.cos(a) * 9.5, 2.3, Math.sin(a) * 9.5); show.cam.lookAt(0, 0.6, 0);
    if (w > 760) show.cam.setViewOffset(w, h, -w * 0.2, 0, w, h); else show.cam.clearViewOffset();
    show.cam.updateProjectionMatrix();
    if (au) updateAudio({ thr: 0 });
    renderer.render(show.scene, show.cam);
    if (!ready) readInput(dt);
  } else if (ready) {
    if (!paused) update(dt); else { readInput(dt); if (au) updateAudio({ thr: 0 }); }
    if (!paused) { updateGhosts(dt); updateGhost(); minimap(dt); updateParticles(dt); }
    environment(dt);
    placeModelAndCamera(dt);
    if (world.tiles) world.tiles.update(cam.position.x, cam.position.z, paused ? 2 : 4);
    renderer.render(scene, cam);
  }
  requestAnimationFrame(frame);
}
showMenu('scrMain');
requestAnimationFrame(frame);

/* ---------- QA hook (automated tests) ---------- */
window.__qa = {
  loadMap: async (id, o = {}) => { if (o.weather) cfg.weather[id] = o.weather; if (o.time) cfg.time[id] = o.time; if (o.car) cfg.carId = o.car; if (o.mode) cfg.mode = o.mode; if (o.traffic != null) cfg.traffic = o.traffic; await loadMap(id, o); hideMenu(); return window.__qa.snap(); },
  snap: () => ({ map: mapDef && mapDef.id, car: spec.id, x: st.x, y: st.y, z: st.z, h: st.h, mph: Math.hypot(st.vx, st.vz) / MPH, gear: st.gear, rpm: st.we * P.RPM, surf: surfName, contact: st.contact, damage: st.damage,
    tempF: st.tempF, tempR: st.tempR, cp: run.cp, started: run.started, laps: run.laps, lastLap: run.lastLap, traffic: traffic.list.length, tiles: world && world.tiles ? world.tiles.tiles.size : 0, water: inWater, cap: speedCap, abs: st.absOn, esc: st.escOn, tc: st.tcOn, frozen, cam: cfg.cam }),
  mm: () => { mmT = 0; minimap2(0.01); const d = mctx.getImageData(180, 180, 1, 1).data; return [Array.from(d), mm.hidden, cfg.mini, mmT]; },
  input: o => { qaInput = o; }, cam: c => { cfg.cam = c; }, auto: mph => { qaAuto = (mph || 0) * MPH; },
  place: sp => { placeAt(sp); return window.__qa.snap(); },
  world: () => world, run: () => run, hour: h => { hour = h; },
  advance: sec => { for (let t = 0; t < sec - 1e-9; t += 1 / 60) update(1 / 60); return window.__qa.snap(); },
};
})();
