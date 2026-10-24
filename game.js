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
  upBtn: 4, downBtn: 5, ebrakeBtn: 7, resetBtn: 0, modeBtn: 3, camBtn: 2, menuBtn: 9, tcUpBtn: 19, tcDownBtn: 20, tc: 7, shiftByCar: {},
  carId: 'vesper-s4', mapId: 'redline', weather: {}, time: {}, traffic: 'map', mode: 'free', laps: 3,
  assist: 'full', shift: 'car', cam: 'cockpit', seat: 0, ghost: 1, mini: 1, qual: 'high', name: '', room: '', kart: 1, driftBtn: 6, nitroBtn: 11, itemBtn: 13, lookBtn: 10, gunBtn: 1, missileBtn: 8, grenadeBtn: 21, weapons: 'vs', bots: 3, paint: {} };
let cfg = JSON.parse(JSON.stringify(DEF));
try { const old = JSON.parse(localStorage.getItem('g29track.v1') || 'null'); if (old) for (const k of ['steerAxis', 'steerInvert', 'rotation', 'thr', 'brk', 'clu', 'upBtn', 'downBtn', 'ebrakeBtn', 'resetBtn']) if (old[k] != null) cfg[k] = old[k]; } catch (e) {}
try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) cfg = Object.assign(cfg, s); } catch (e) {}
if (cfg.lookBtn == null) { cfg.lookBtn = 10; if (cfg.nitroBtn === 10) cfg.nitroBtn = 11; if (cfg.itemBtn === 11) cfg.itemBtn = 13; } // L3 is now look-back
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} };
const ACTIONS = [['upBtn', 'Upshift'], ['downBtn', 'Downshift'], ['ebrakeBtn', 'E-brake'], ['modeBtn', 'Driver aids'], ['resetBtn', 'Reset car'], ['camBtn', 'Camera'], ['menuBtn', 'Menu / pause'], ['tcUpBtn', 'Traction control +'], ['tcDownBtn', 'Traction control −'], ['driftBtn', 'Kart drift (hold)'], ['nitroBtn', 'Nitro'], ['itemBtn', 'Use item'], ['lookBtn', 'Look back (hold)'], ['gunBtn', 'Fire gun'], ['missileBtn', 'Fire missile'], ['grenadeBtn', 'Throw grenade']];
if (!VEH.find(v => v.id === cfg.carId)) cfg.carId = VEH[0].id;
const savedLvl = String(cfg.mapId || '').startsWith('lvl:') ? cfg.mapId.slice(4) : null; // community level, fetched after start-up
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
let padLook = false, kbSteer = 0, blocked = false, padId = '', prevBtns = [], usingKeys = false;
const moved = new Set();
let detect = null, binding = null;
addEventListener('keydown', e => {
  if (e.target.matches('input,select,textarea')) return;
  if (e.code === 'Escape') { e.preventDefault(); togglePause(); return; }
  if (document.body.classList.contains('inmenu')) return;
  keys.add(e.code); usingKeys = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'AltLeft', 'AltRight'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'KeyR') resetToRoad();
  if (e.code === 'ArrowUp') paddle(1);
  if (e.code === 'ArrowDown') paddle(-1);
  if (e.code === 'KeyM') cycleAssist();
  if (e.code === 'KeyC') cycleCam();
  if (e.code === 'KeyT') toggleShift();
  if (e.code === 'BracketRight' || e.code === 'Equal') tcAdjust(1);
  if (e.code === 'BracketLeft' || e.code === 'Minus') tcAdjust(-1);
  if (e.code === 'KeyF' || e.code === 'Digit1') fireWeapon('gun');
  if (e.code === 'KeyG' || e.code === 'Digit2') fireWeapon('mis');
  if (e.code === 'KeyH' || e.code === 'Digit3') fireWeapon('gre');
  if (e.code === 'KeyN') useNitro();
  if (e.code === 'KeyE') useItem();
  if (e.code === 'KeyK') { cfg.kart = cfg.kart ? 0 : 1; save(); toast(cfg.kart ? 'Kart drift ON · hold Shift (or the e-brake) while steering' : 'Kart drift OFF · e-brake works normally'); }
});
addEventListener('keyup', e => { keys.delete(e.code); if (e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault(); });
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
  const inp = { steer: 0, thr: 0, brk: 0, clu: 0, ebrake: false, drift: false, gp, wheel: false };
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
        if (edge(cfg.tcUpBtn)) tcAdjust(1);
        if (edge(cfg.tcDownBtn)) tcAdjust(-1);
        if (edge(cfg.nitroBtn)) useNitro();
        if (edge(cfg.gunBtn)) fireWeapon('gun');
        if (edge(cfg.missileBtn)) fireWeapon('mis');
        if (edge(cfg.grenadeBtn)) fireWeapon('gre');
        if (edge(cfg.itemBtn)) useItem();
        inp.ebrake = !!b[cfg.ebrakeBtn];
        inp.drift = !!b[cfg.driftBtn];
        padLook = !!b[cfg.lookBtn];
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
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) inp.drift = true;
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
const shiftFor = id => (cfg.shiftByCar || {})[id] || (cfg.shift !== 'car' ? cfg.shift : (carById(id).transmission_type === 'manual' ? 'manual' : 'auto'));
const autoShiftOn = () => shiftFor(spec.id) === 'auto';
let paddleHold = 0;

const paintFor = id => (cfg.paint || {})[id] || {};
function makeModelFor(sp, opts = {}) {
  const c = P.createCar(sp), mine = !opts.ghost && opts.color == null ? paintFor(sp.id) : null;
  const color = opts.color != null ? opts.color : mine && mine.color != null ? mine.color : null;
  const decal = opts.decal || (mine && mine.decal ? { style: mine.decal, color: mine.dcolor ?? 0xffffff, num: mine.num ?? 29 } : null);
  const rim = opts.rim != null ? opts.rim : mine && mine.rim != null ? mine.rim : null;
  return CARS.makeCarModel(Object.assign({}, sp.visual, color != null ? { color } : {}, rim != null ? { rim } : {}), { ghost: !!opts.ghost, decal, cgFromFront: c.A * (sp.visual.wheelbase / c.WB) });
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
  clearVs(); initTraffic(); initParticles(); initItems(); nitro.charge = 1; loadGhost(); resetRun();
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
    assist: ASSIST[cfg.assist] || ASSIST.full, tcLevel: cfg.tc, mode: cfg.assist, speedCap, ambient: weather.ambient ?? 22, wet, q };
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
  toast({ full: 'Driver aids: full (ABS, TC, stability)', sport: 'Driver aids: sport (stability off)', off: car.kfDrift != null ? 'Driver aids: off — stability off, rear-biased drift split' : 'Driver aids: off — stability off' }[cfg.assist] + ' · TC is set separately with [ and ]');
}
function toggleShift() {
  cfg.shiftByCar = cfg.shiftByCar || {}; cfg.shiftByCar[spec.id] = autoShiftOn() ? 'manual' : 'auto'; save(); toast(`${spec.name}: ${autoShiftOn() ? 'automatic' : 'manual (paddles / arrow keys)'}`);
}
function tcAdjust(d) { cfg.tc = clamp((cfg.tc ?? 7) + d, 0, 10); save(); toast(cfg.tc === 0 ? 'Traction control OFF' : `Traction control ${cfg.tc}/10${cfg.tc === 7 ? ' (factory)' : cfg.tc > 7 ? ' — more grip, less wheelspin' : ' — more wheelspin allowed'}`, 1.4); if ($('sTc')) $('sTc').value = cfg.tc; }
function cycleCam() { const o = ['cockpit', 'hood', 'chase']; cfg.cam = o[(o.indexOf(cfg.cam) + 1) % 3]; save(); }

/* ---------- kart drift and boosts ----------
 * Arcade layer on top of the sim. Hold the drift button (Shift, a bound wheel button, or the e-brake) while steering
 * at speed: the car slides at a fixed angle around a radius you tighten or widen with the steering, holding its speed.
 * Holding the drift charges a mini-turbo (blue → orange → purple); letting go fires it. Boost pads give a boost too. */
const kart = { on: false, dir: 0, vh: 0, sp: 0, charge: 0, tier: 0, steer: 0 };
const boost = { t: 0, a: 0, flash: 0 };
const KT = [0, 0.75, 1.9, 3.3], KB = [[0, 0], [0.7, 7], [1.2, 8], [1.9, 9.5]], KCOL = ['#fff', '#3fb4ff', '#ff8a1f', '#c45cff'];
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
function fireBoost(sec, a) { boost.t = Math.max(boost.t, sec); boost.a = Math.max(boost.a, a); boost.flash = 0.5; }
function kartFrame(dt, inp, pin, sp) {
  const sN = clamp(pin.steerAngle / car.maxSteer, -1, 1);
  const want = !!cfg.kart && !frozen && st.gear > 0 && (inp.drift || inp.ebrake);
  if (!kart.on) {
    if (want && sp > 11 && Math.abs(sN) > 0.18 && st.contact) Object.assign(kart, { on: true, dir: Math.sign(sN), vh: Math.atan2(st.vx, -st.vz), sp, charge: 0, tier: 0 });
  } else {
    const hit = sp < kart.sp - 3;
    if (!want || sp < 7 || hit) {
      if (!want && !hit && kart.tier) { const [sec, a] = KB[kart.tier]; fireBoost(sec, a); }
      kart.on = false; kart.tier = 0; kart.charge = 0;
    } else if (st.contact) {
      kart.charge += dt * (0.55 + 0.9 * Math.max(0, sN * kart.dir));
      kart.tier = kart.charge > KT[3] ? 3 : kart.charge > KT[2] ? 2 : kart.charge > KT[1] ? 1 : 0;
    }
  }
  kart.steer = sN;
  if (kart.on) pin.ebrake = false; // the drift replaces the handbrake lock
}
function kartSub(h) {
  if (boost.t > 0 && st.contact) { const a = boost.a * h; st.vx += Math.sin(st.h) * a; st.vz -= Math.cos(st.h) * a; }
  if (!kart.on || !st.contact) return;
  // the drift scrubs speed (more when you steer into it) so you can hold a tight line through the corner
  const k = clamp(0.5 + 0.5 * kart.steer * kart.dir, 0, 1), R = lerp(Math.max(22, kart.sp * 2.2), Math.max(7, kart.sp * 0.7), k), rt = kart.dir * kart.sp / R;
  kart.sp = Math.max(9, kart.sp - (1.5 + 4 * k) * h);
  kart.vh += rt * h;
  const proj = st.vx * Math.sin(kart.vh) - st.vz * Math.cos(kart.vh);
  kart.sp = clamp(proj, kart.sp - 1.6 * h, kart.sp + 2 * h);
  st.vx = Math.sin(kart.vh) * kart.sp; st.vz = -Math.cos(kart.vh) * kart.sp;
  st.r = rt + clamp(wrapA(kart.vh + kart.dir * 0.42 - st.h) * 7, -2.5, 2.5);
}
function boostPads() {
  if (!world.boostPads) return;
  for (const p of world.boostPads) {
    const dx = st.x - p.x, dz = st.z - p.z, f = dx * Math.sin(p.h) - dz * Math.cos(p.h), l = dx * Math.cos(p.h) + dz * Math.sin(p.h);
    if (Math.abs(f) < p.len / 2 && Math.abs(l) < p.wid / 2 + 0.4 && Math.abs(st.y - car.HCG - p.y) < 1.2) { if (boost.t < 0.9) playThump(1.5); fireBoost(1.1, 9); }
  }
}

/* ---------- nitro ----------
 * One shot of nitro (1.4 s of extra push); it refills over 3 seconds after each use. */
const nitro = { charge: 1 };
function useNitro() {
  if (!car || frozen || paused || nitro.charge < 1) return;
  nitro.charge = 0; fireBoost(1.4, 10.5); playThump(2);
}

/* ---------- items ----------
 * Item boxes sit in a row just after every checkpoint. Drive through one to get a random item (one held at a time):
 *  Turbo   - a short, strong speed burst.
 *  Bouncer - a green disc fired forward; it ricochets off walls for 8 s and spins out the first car it hits (yours too).
 * Shots are broadcast to the room; every game simulates them and checks only its own car. */
const items = { boxes: [], im: null, held: null, shots: [] };
const ITEM_NAMES = { turbo: 'TURBO', bouncer: 'BOUNCER' };
function clearItems() {
  if (items.im) { scene.remove(items.im); items.im.geometry.dispose(); items.im.material.dispose(); }
  for (const sh of items.shots) scene.remove(sh.m);
  Object.assign(items, { boxes: [], im: null, shots: [], held: null });
}
function initItems() {
  clearItems();
  if (world.itemSpots) for (const p of world.itemSpots) items.boxes.push({ x: p.x, z: p.z, y: world.ground(p.x, p.z, 5).h + 1.1, back: 0 });
  for (const g of world.checkpoints) {
    const x0 = g.x + g.tx * 30, z0 = g.z + g.tz * 30, q = world.nearest(x0, z0);
    const hwR = q ? (q.road ? q.road.width / 2 : q.hw || 6) : 6, rx = -g.tz, rz = g.tx;
    for (const f of [-0.6, -0.2, 0.2, 0.6]) {
      const x = x0 + rx * f * hwR, z = z0 + rz * f * hwR, y = world.ground(x, z, (g.y || 0) + 4).h;
      items.boxes.push({ x, z, y: y + 1.1, back: 0 });
    }
  }
  if (!items.boxes.length) return;
  items.im = new THREE.InstancedMesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), new THREE.MeshNormalMaterial({ transparent: true, opacity: 0.82 }), items.boxes.length);
  items.im.frustumCulled = false; scene.add(items.im);
}
const shotGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.38, 18), shotMat = new THREE.MeshPhongMaterial({ color: 0x2fc24a, shininess: 90, specular: 0xffffff }), shotRim = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
function addShot(o, own) {
  const m = new THREE.Group(); m.add(new THREE.Mesh(shotGeo, shotMat));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.07, 6, 18), shotRim); rim.rotation.x = Math.PI / 2; m.add(rim);
  scene.add(m);
  items.shots.push({ id: o.id, x: o.x, z: o.z, y: o.y, vx: o.vx, vz: o.vz, t: 0, own, m });
}
function useItem() {
  if (!car || frozen || paused || !items.held) return;
  const it = items.held; items.held = null;
  if (it === 'turbo') { fireBoost(1.5, 12); playThump(2); return; }
  const fx = Math.sin(st.h), fz = -Math.cos(st.h), sp = Math.max(38, Math.hypot(st.vx, st.vz) + 18);
  const o = { id: myId.slice(0, 6) + Math.random().toString(36).slice(2, 7), x: st.x + fx * 3.4, z: st.z + fz * 3.4, y: st.y - car.HCG + 0.5, vx: fx * sp, vz: fz * sp };
  addShot(o, true);
  if (net.ready) net.ch.send({ type: 'broadcast', event: 'shot', payload: o }).catch(() => {});
}
function onShot(o) {
  if (!o || typeof o.id !== 'string' || ![o.x, o.z, o.y, o.vx, o.vz].every(Number.isFinite)) return;
  if (items.shots.some(s2 => s2.id === o.id) || Math.hypot(o.vx, o.vz) > 120) return;
  addShot(o, false);
}
function spinOut() {
  kart.on = false; kart.tier = 0; boost.t = 0; boost.a = 0;
  st.vx *= 0.3; st.vz *= 0.3; st.r = (Math.random() < 0.5 ? -1 : 1) * 6.5;
  toast('Hit by a Bouncer!', 1.6); playThump(5);
}
const o3 = new THREE.Object3D();
function updateItems(dt) {
  // boxes: spin, pick up, respawn
  if (items.im) {
    items.boxes.forEach((b, i) => {
      const live = now >= b.back;
      if (live && !frozen && Math.hypot(st.x - b.x, st.z - b.z) < 2.4 && Math.abs(st.y - car.HCG + 0.6 - b.y) < 2.5) {
        b.back = now + 5;
        if (!items.held) { items.held = Math.random() < 0.55 ? 'turbo' : 'bouncer'; toast(`Got ${ITEM_NAMES[items.held]} · press E${cfg.itemBtn != null ? ' or your item button' : ''}`, 1.4); }
      }
      o3.position.set(b.x, b.y + Math.sin(now * 2 + i) * 0.15, b.z); o3.rotation.set(0.5, now * 1.6 + i, 0.3);
      const k = now >= b.back ? 1 : 0; o3.scale.set(k || 1e-3, k || 1e-3, k || 1e-3); o3.updateMatrix(); items.im.setMatrixAt(i, o3.matrix);
    });
    items.im.instanceMatrix.needsUpdate = true;
  }
  // shots: move in small steps, bounce off walls, follow the ground
  for (let k = items.shots.length - 1; k >= 0; k--) {
    const sh = items.shots[k]; sh.t += dt;
    let dead = sh.t > 8;
    const n = Math.max(1, Math.ceil(Math.hypot(sh.vx, sh.vz) * dt / 0.5));
    for (let j = 0; j < n && !dead; j++) {
      sh.x += sh.vx * dt / n; sh.z += sh.vz * dt / n;
      for (const it of world.cols.query(sh.x, sh.z, 1)) {
        if (sh.y < it.y0 - 0.5 || sh.y > it.y1 + 0.5) continue;
        let nx = 0, nz = 0, pen = 0; const R = 0.5;
        if (it.t === 0) { const ex = it.bx - it.ax, ez = it.bz - it.az, L2 = ex * ex + ez * ez || 1, t = clamp(((sh.x - it.ax) * ex + (sh.z - it.az) * ez) / L2, 0, 1), px = it.ax + ex * t, pz = it.az + ez * t, d = Math.hypot(sh.x - px, sh.z - pz); if (d >= R || d < 1e-6) continue; nx = (sh.x - px) / d; nz = (sh.z - pz) / d; pen = R - d; }
        else if (it.t === 1) { const d = Math.hypot(sh.x - it.x, sh.z - it.z); if (d >= R + it.r || d < 1e-6) continue; nx = (sh.x - it.x) / d; nz = (sh.z - it.z) / d; pen = R + it.r - d; }
        else { const px = clamp(sh.x, it.x0, it.x1), pz = clamp(sh.z, it.z0, it.z1), d = Math.hypot(sh.x - px, sh.z - pz); if (d >= R) continue; if (d > 1e-6) { nx = (sh.x - px) / d; nz = (sh.z - pz) / d; pen = R - d; } else { nx = -Math.sign(sh.vx) || 1; pen = R; } }
        sh.x += nx * pen; sh.z += nz * pen;
        const vn = sh.vx * nx + sh.vz * nz; if (vn < 0) { sh.vx -= 2 * vn * nx; sh.vz -= 2 * vn * nz; }
      }
      const g = world.ground(sh.x, sh.z, sh.y + 1.5);
      if (g.h > sh.y + 1.2) { sh.vx = -sh.vx; sh.vz = -sh.vz; } else sh.y = g.h + 0.35;
      if ((world.ocean && g.h < -0.5) || g.water > 0.6) dead = true;
    }
    // hits: my own car (the shooter is safe for the first moment), traffic for the shooter, remote cars just absorb it
    if (!dead && (!sh.own || sh.t > 0.6) && Math.hypot(st.x - sh.x, st.z - sh.z) < 1.9 && Math.abs(st.y - car.HCG - sh.y) < 2) { spinOut(); dead = true; }
    if (!dead && sh.own) for (const a of traffic.list) if (Math.hypot(a.x - sh.x, a.z - sh.z) < 2.2) { a.crashed = a.crashed || 0.001; a.vx += sh.vx * 0.25; a.vz += sh.vz * 0.25; a.r += 3; dead = true; break; }
    if (!dead) for (const [, gh] of ghosts) if (Math.hypot(gh.x - sh.x, gh.z - sh.z) < 1.9 && Math.abs(gh.y - sh.y) < 2) { dead = true; break; }
    if (dead) { scene.remove(sh.m); items.shots.splice(k, 1); continue; }
    sh.m.position.set(sh.x, sh.y, sh.z); sh.m.rotation.y += dt * 12;
  }
  nitro.charge = Math.min(1, nitro.charge + dt / 3);
}

/* ---------- VS: weapons, wrecks, bots ----------
 * Every car carries a gun (a burst of rounds), missiles (lock onto the nearest car ahead) and grenades (lobbed,
 * bounce, explode after 2 s or on contact): 3 of each. A spent shot comes back 10 s after it was fired.
 * Damage is the health bar: at 100% the car is wrecked, explodes, and respawns repaired 3 s later (every map).
 * Shots are broadcast to the room and simulated by every game; each game applies hits to its own car only and
 * announces its own wrecks (with who did it). Practice bots appear on VS maps when nobody else is in the room. */
const WPN = { gun: { label: 'GUN', key: 'F' }, mis: { label: 'MISSILE', key: 'G' }, gre: { label: 'GRENADE', key: 'H' } };
const RELOAD = 10, MAX_AMMO = 3;
const vs = { dead: 0, kos: 0, wrecks: 0, lastBy: null, lastByT: -99, ammo: {}, proj: [], fx: [], bots: [] };
const weaponsOn = () => !!mapDef && (cfg.weapons === 'all' || (cfg.weapons !== 'off' && mapDef.mode === 'arena'));
function resetAmmo() { for (const k in WPN) vs.ammo[k] = { n: MAX_AMMO, back: [] }; }
resetAmmo();
function poseOf(id) {
  if (id === myId) return st ? { x: st.x, z: st.z, y: st.y - car.HCG, h: st.h, vx: st.vx, vz: st.vz, dead: vs.dead > 0 } : null;
  const b = vs.bots.find(b2 => b2.id === id); if (b) return { x: b.x, z: b.z, y: b.y, h: b.h, vx: b.vx, vz: b.vz, dead: b.dead > 0 };
  const g = ghosts.get(id); return g ? { x: g.x, z: g.z, y: g.y, h: g.h, vx: g.vx, vz: g.vz } : null;
}
const nameOf = id => id === myId ? myName() : (vs.bots.find(b => b.id === id) || {}).name || (ghosts.get(id) || {}).name || 'Someone';
// push a circle of radius R out of static walls; returns the summed push normal or null
function wallPush(o, R) {
  let hit = null;
  for (const it of world.cols.query(o.x, o.z, R + 1)) {
    if (o.y + 0.5 < it.y0 - 0.3 || o.y > it.y1 + 0.3) continue;
    let nx = 0, nz = 0, pen = 0;
    if (it.t === 0) { const ex = it.bx - it.ax, ez = it.bz - it.az, L2 = ex * ex + ez * ez || 1, t = clamp(((o.x - it.ax) * ex + (o.z - it.az) * ez) / L2, 0, 1), px = it.ax + ex * t, pz = it.az + ez * t, d = Math.hypot(o.x - px, o.z - pz); if (d >= R || d < 1e-6) continue; nx = (o.x - px) / d; nz = (o.z - pz) / d; pen = R - d; }
    else if (it.t === 1) { const d = Math.hypot(o.x - it.x, o.z - it.z); if (d >= R + it.r || d < 1e-6) continue; nx = (o.x - it.x) / d; nz = (o.z - it.z) / d; pen = R + it.r - d; }
    else { const px = clamp(o.x, it.x0, it.x1), pz = clamp(o.z, it.z0, it.z1), d = Math.hypot(o.x - px, o.z - pz); if (d >= R) continue; if (d > 1e-6) { nx = (o.x - px) / d; nz = (o.z - pz) / d; pen = R - d; } else { const m = Math.min(o.x - it.x0, it.x1 - o.x, o.z - it.z0, it.z1 - o.z); if (m === o.x - it.x0) nx = -1; else if (m === it.x1 - o.x) nx = 1; else if (m === o.z - it.z0) nz = -1; else nz = 1; pen = m + R; } }
    o.x += nx * pen; o.z += nz * pen; hit = hit || { nx: 0, nz: 0 }; hit.nx += nx; hit.nz += nz;
  }
  return hit;
}
// targets a projectile from `owner` can hit: my car (if someone else fired), local bots (if I or ... fired), remote cars (absorb only)
function targetsFor(owner, selfOk) {
  const out = [];
  if (st && !(vs.dead > 0) && (owner !== myId || selfOk)) out.push({ id: myId, x: st.x, z: st.z, y: st.y - car.HCG, me: true });
  if (owner === myId || selfOk) for (const b of vs.bots) if (!(b.dead > 0) && b.id !== owner) out.push({ id: b.id, x: b.x, z: b.z, y: b.y, bot: b });
  for (const [id, g] of ghosts) if (id !== owner) out.push({ id, x: g.x, z: g.z, y: g.y, remote: true });
  return out;
}
function hurt(t, dmg, owner, nx, nz) { // apply a weapon hit to a local target
  if (t.me && owner && owner.startsWith('bot')) dmg *= 0.4; // practice bots hit softer
  if (t.me) { vs.lastBy = owner; vs.lastByT = now; st.vx += nx * dmg * 18; st.vz += nz * dmg * 18; st.r += (Math.random() - 0.5) * dmg * 6; carDamage(dmg, st.x - nx, st.z - nz, nx, nz, true); }
  else if (t.bot) { t.bot.dmg = Math.min(1, t.bot.dmg + dmg); t.bot.lastBy = owner; t.bot.v *= 0.6; if (t.bot.dmg >= 0.999) botWreck(t.bot); }
}
let EXPL_GEO = null;
function boom(x, y, z, R, dmg, owner, direct) {
  if (!EXPL_GEO) EXPL_GEO = new THREE.SphereGeometry(1, 16, 12);
  const fire = new THREE.Mesh(EXPL_GEO, new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  const smoke = new THREE.Mesh(EXPL_GEO, new THREE.MeshLambertMaterial({ color: 0x2b2b2b, transparent: true, opacity: 0.7, depthWrite: false }));
  fire.position.set(x, y + 0.8, z); smoke.position.set(x, y + 1.2, z); scene.add(fire, smoke);
  vs.fx.push({ fire, smoke, t: 0, R });
  if (st) { const d = Math.hypot(st.x - x, st.z - z); if (d < 60) playThump(Math.max(2, 10 - d / 6)); }
  if (!dmg) return;
  for (const t of targetsFor(owner, true)) {
    if (t.remote) continue;
    const d = Math.hypot(t.x - x, t.z - z), dy = Math.abs(t.y - y);
    if (d > R || dy > R) continue;
    const f = t.id === direct ? 1 : 1 - d / R, nx = (t.x - x) / (d || 1), nz = (t.z - z) / (d || 1);
    hurt(t, dmg * f * (t.id === owner ? 0.5 : 1), owner, nx, nz);
    if (t.me) st.vy += 4 * f;
  }
}
const projGeo = { b: new THREE.BoxGeometry(0.12, 0.12, 1.6), m: new THREE.CylinderGeometry(0.16, 0.2, 1.3, 8).rotateX(Math.PI / 2), g: new THREE.SphereGeometry(0.28, 10, 8) };
const projMat = { b: new THREE.MeshBasicMaterial({ color: 0xffe27a }), m: new THREE.MeshLambertMaterial({ color: 0xe8e8e8 }), g: new THREE.MeshLambertMaterial({ color: 0x3b4a2f }) };
function addProj(p) {
  const m = new THREE.Mesh(projGeo[p.kind], projMat[p.kind]); m.visible = !p.wait;
  if (p.kind === 'm') { const fl = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff6a1f, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })); fl.position.z = 0.8; m.add(fl); }
  scene.add(m); p.m = m; p.t = 0; vs.proj.push(p);
}
function launch(k, from, o) { // o: launch data (from the network or made locally)
  if (k === 'gun') for (let i = 0; i < 10; i++) addProj({ kind: 'b', owner: from, wait: i * 0.055, spread: (Math.random() - 0.5) * 0.03 });
  if (k === 'mis') addProj({ kind: 'm', owner: from, id: o.id, x: o.x, y: o.y, z: o.z, h: o.h, sp: 62, tgt: o.tgt || null });
  if (k === 'gre') addProj({ kind: 'g', owner: from, id: o.id, x: o.x, y: o.y, z: o.z, vx: o.vx, vy: o.vy, vz: o.vz });
}
function pickTarget(p, cone, range) {
  let best = null, bd = Infinity;
  for (const t of targetsFor(p.id === myId ? myId : p.id)) {
    if (t.id === p.id) continue;
    const dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz); if (d > range) continue;
    const a = Math.abs(wrapA(Math.atan2(dx, -dz) - p.h)); if (a > cone) continue;
    const score = d * (1 + a); if (score < bd) { bd = score; best = t.id; }
  }
  return best;
}
function fireFrom(k, shooter) { // shooter: { id, x, y, z, h, vx, vz }
  const fx = Math.sin(shooter.h), fz = -Math.cos(shooter.h);
  let o = { id: shooter.id.slice(0, 6) + Math.random().toString(36).slice(2, 7) };
  if (k === 'mis') Object.assign(o, { x: shooter.x + fx * 3.2, y: shooter.y + 0.9, z: shooter.z + fz * 3.2, h: shooter.h, tgt: pickTarget(shooter, 0.6, 170) });
  if (k === 'gre') Object.assign(o, { x: shooter.x + fx * 2.6, y: shooter.y + 1.4, z: shooter.z + fz * 2.6, vx: shooter.vx + fx * 15, vy: 6.5, vz: shooter.vz + fz * 15 });
  launch(k, shooter.id, o);
  return o;
}
function fireWeapon(k) {
  if (!ready || paused || frozen || !weaponsOn() || vs.dead > 0) return;
  const a = vs.ammo[k]; if (!a || a.n <= 0) { toast(`${WPN[k].label}: reloading`, 0.8); return; }
  a.n--; a.back.push(now + RELOAD);
  const o = fireFrom(k, { id: myId, x: st.x, y: st.y - car.HCG, z: st.z, h: st.h, vx: st.vx, vz: st.vz });
  if (net.ready) net.ch.send({ type: 'broadcast', event: 'wpn', payload: Object.assign({ k, from: myId }, o) }).catch(() => {});
}
function onWpn(m) {
  if (!m || typeof m.from !== 'string' || m.from === myId || !WPN[m.k]) return;
  if (m.k !== 'gun' && ![m.x, m.y, m.z].every(Number.isFinite)) return;
  if (m.k === 'gre' && ![m.vx, m.vy, m.vz].every(v => Number.isFinite(v) && Math.abs(v) < 80)) return;
  launch(m.k, m.from, m);
}
function onKo(m) {
  if (!m || typeof m.victim !== 'string') return;
  const v = cleanName(m.vname) || 'Someone', k = cleanName(m.kname);
  if (m.killer === myId) { vs.kos++; toast(`You wrecked ${v}! · ${vs.kos} KO${vs.kos === 1 ? '' : 's'}`, 2.2); trackPresence(); }
  else toast(k ? `${k} wrecked ${v}` : `${v} wrecked`, 1.8);
}
function checkWreck() {
  if (!st || vs.dead > 0 || st.damage < 0.999) return;
  const by = now - vs.lastByT < 8 ? vs.lastBy : null;
  vs.dead = 3; vs.wrecks++; kart.on = false; boost.t = 0;
  boom(st.x, st.y - car.HCG, st.z, 0, 0, null);
  st.vx *= 0.3; st.vz *= 0.3;
  const kname = by && by !== myId ? nameOf(by) : '';
  toast(kname ? `Wrecked by ${kname}` : 'Wrecked!', 2.5);
  if (net.ready) net.ch.send({ type: 'broadcast', event: 'ko', payload: { victim: myId, vname: myName(), killer: by && !by.startsWith('bot') ? by : null, kname } }).catch(() => {});
  trackPresence();
}
function respawn() {
  if (mapDef.mode === 'arena') {
    let best = world.spawns[0], bd = -1; // the spawn farthest from everyone else
    for (const sp of world.spawns) { let d = 1e9; for (const t of targetsFor('-', true)) if (!t.me) d = Math.min(d, Math.hypot(t.x - sp.x, t.z - sp.z)); d += Math.random() * 30; if (d > bd) { bd = d; best = sp; } }
    placeAt(best);
  } else if (run.started && run.lastGate) { placeAt(run.lastGate.spawn); run.valid = false; }
  else resetToRoad();
  st.damage = 0; st.pull = 0; model.repair(); vs.dead = 0; vs.lastBy = null;
  toast('Back in the game', 1.2);
}
/* practice bots */
const BOT_COLS = [0xe8453c, 0xf2c230, 0xb05ce6, 0xff8a2b, 0x25c6d9, 0xf26bb5];
function botsWanted() { return mapDef && mapDef.mode === 'arena' && weaponsOn() && ghosts.size === 0 ? clamp(+cfg.bots || 0, 0, 6) : 0; }
function clearBots() { for (const b of vs.bots) { scene.remove(b.m.group); disposeGroup(b.m.group); } vs.bots = []; }
function addBot(i) {
  const sp = carById(VEH[(i * 3 + 1) % VEH.length].id), color = BOT_COLS[i % BOT_COLS.length];
  const m = makeModelFor(sp, { color, decal: { style: 'number', color, num: i + 1 } }); scene.add(m.group);
  const b = { id: 'bot' + (i + 1), name: 'Bot ' + (i + 1), m, x: 0, z: 0, y: 0, h: 0, v: 0, vx: 0, vz: 0, dmg: 0, dead: 0, wp: null, wpT: 0, gunT: 3 + Math.random() * 3, misT: 8 + Math.random() * 5, greT: 6, len: sp.visual.length, wid: sp.visual.width, mass: sp.mass_kg };
  b.key = b; m.group.add(makeLabel(b.name, color)); placeBot(b); vs.bots.push(b);
}
function placeBot(b) {
  const sp = world.spawns[Math.floor(Math.random() * world.spawns.length)];
  Object.assign(b, { x: sp.x, z: sp.z, y: 0, h: sp.h, v: 0, vx: 0, vz: 0, dmg: 0, dead: 0, wp: null });
  b.m.group.visible = true;
}
function botWreck(b) {
  if (b.dead > 0) return;
  b.dead = 4; b.m.group.visible = false; boom(b.x, b.y, b.z, 0, 0, null);
  if (b.lastBy === myId) { vs.kos++; toast(`You wrecked ${b.name}! · ${vs.kos} KO${vs.kos === 1 ? '' : 's'}`, 2); }
}
function updateBots(dt) {
  const want = botsWanted();
  while (vs.bots.length > want) { const b = vs.bots.pop(); scene.remove(b.m.group); disposeGroup(b.m.group); }
  while (vs.bots.length < want) addBot(vs.bots.length);
  const pts = world.botPoints || [];
  for (const b of vs.bots) {
    if (b.dead > 0) { b.dead -= dt; if (b.dead <= 0) placeBot(b); continue; }
    const dx = st.x - b.x, dz = st.z - b.z, dist = Math.hypot(dx, dz), alive = !(vs.dead > 0);
    const chase = alive && dist < 110;
    b.wpT -= dt;
    if (!b.wp || b.wpT <= 0 || Math.hypot(b.wp[0] - b.x, b.wp[1] - b.z) < 10) { b.wp = pts.length ? pts[Math.floor(Math.random() * pts.length)] : [0, 0]; b.wpT = 9; }
    const tx = chase ? st.x + st.vx * 0.6 : b.wp[0], tz = chase ? st.z + st.vz * 0.6 : b.wp[1];
    let want2 = Math.atan2(tx - b.x, -(tz - b.z));
    if (chase && dist < 22) want2 = Math.atan2(dx, -dz) + (b.id.charCodeAt(3) % 2 ? 1.4 : -1.4); // circle around instead of ramming
    // look ahead for walls and steer around them
    const probe = h => { const o = { x: b.x + Math.sin(h) * 9, z: b.z - Math.cos(h) * 9, y: b.y }; return !wallPush(o, 2.2); };
    if (!probe(want2)) { for (const d of [0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4]) if (probe(b.h + d)) { want2 = b.h + d; break; } }
    let vT;
    if (b.rev > 0) { b.rev -= dt; b.h += b.revDir * 1.4 * dt; vT = -6; } // backing out of a wall
    else {
      b.h += clamp(wrapA(want2 - b.h), -1.7 * dt, 1.7 * dt);
      vT = (chase && dist < 14 ? 9 : 19) * (1 - 0.5 * Math.min(1, Math.abs(wrapA(want2 - b.h)))) * (1 - 0.4 * b.dmg);
    }
    b.v += clamp(vT - b.v, -12 * dt, 6 * dt);
    b.vx = Math.sin(b.h) * b.v; b.vz = -Math.cos(b.h) * b.v;
    b.x += b.vx * dt; b.z += b.vz * dt;
    if (wallPush(b, 1.1) && !(b.rev > 0)) { b.v = 0; b.rev = 1; b.revDir = Math.random() < 0.5 ? -1 : 1; b.wp = null; }
    b.y = world.ground(b.x, b.z, b.y + 1.5).h;
    // weapons: gun and missiles at the player when lined up, grenades when close
    b.gunT -= dt; b.misT -= dt; b.greT -= dt;
    if (alive && !frozen && weaponsOn()) {
      const ang = Math.abs(wrapA(Math.atan2(dx, -dz) - b.h)), shooter = { id: b.id, x: b.x, y: b.y, z: b.z, h: b.h, vx: b.vx, vz: b.vz };
      if (b.gunT <= 0 && dist < 70 && ang < 0.25) { fireFrom('gun', shooter); b.gunT = 5 + Math.random() * 4; }
      if (b.misT <= 0 && dist < 140 && ang < 0.5) { fireFrom('mis', shooter); b.misT = 13 + Math.random() * 8; }
      if (b.greT <= 0 && dist < 28 && ang < 0.7) { fireFrom('gre', shooter); b.greT = 14 + Math.random() * 8; }
    }
    b.m.group.position.set(b.x, b.y, b.z); b.m.group.rotation.set(0, -b.h, 0); b.m.spin(b.v * dt);
  }
}
function updateVs(dt) {
  for (const k in vs.ammo) { const a = vs.ammo[k]; while (a.back.length && a.back[0] <= now) { a.back.shift(); a.n = Math.min(MAX_AMMO, a.n + 1); } }
  if (vs.dead > 0) { vs.dead -= dt; if (vs.dead <= 0) respawn(); }
  updateBots(dt);
  // projectiles
  for (let k = vs.proj.length - 1; k >= 0; k--) {
    const p = vs.proj[k]; let dead = false;
    if (p.wait != null) { // gun rounds leave the shooter's muzzle one after another
      p.wait -= dt; if (p.wait > 0) continue;
      const s0 = poseOf(p.owner); if (!s0 || s0.dead) { dead = true; } else {
        const h = s0.h + p.spread, fx = Math.sin(h), fz = -Math.cos(h);
        Object.assign(p, { x: s0.x + fx * 3, y: s0.y + 0.75, z: s0.z + fz * 3, vx: s0.vx + fx * 150, vz: s0.vz + fz * 150, h, wait: null }); p.m.visible = true;
      }
    }
    if (!dead) {
      p.t += dt;
      const n = Math.max(1, Math.ceil((p.kind === 'b' ? 150 : 60) * dt / 0.8));
      for (let j = 0; j < n && !dead; j++) {
        const h2 = dt / n;
        if (p.kind === 'b') { p.x += p.vx * h2; p.z += p.vz * h2; if (p.t > 0.9) dead = true; }
        if (p.kind === 'm') {
          const tp = p.tgt ? poseOf(p.tgt) : null;
          if (tp && !tp.dead && p.t > 0.15) { const want = Math.atan2(tp.x - p.x, -(tp.z - p.z)); p.h += clamp(wrapA(want - p.h), -2.4 * h2, 2.4 * h2); }
          p.x += Math.sin(p.h) * p.sp * h2; p.z -= Math.cos(p.h) * p.sp * h2;
          const gy = world.ground(p.x, p.z, p.y + 2).h; p.y += (gy + 0.9 - p.y) * Math.min(1, h2 * 6);
          if (p.t > 5) { boom(p.x, p.y, p.z, 6, 0.25, p.owner); dead = true; }
        }
        if (p.kind === 'g') {
          p.vy -= 9.81 * h2; p.x += p.vx * h2; p.y += p.vy * h2; p.z += p.vz * h2;
          const gy = world.ground(p.x, p.z, p.y + 1).h;
          if (p.y < gy + 0.28) { p.y = gy + 0.28; if (p.vy < 0) p.vy = -p.vy * 0.42; p.vx *= 0.78; p.vz *= 0.78; }
          const w = wallPush(p, 0.3); if (w) { const L = Math.hypot(w.nx, w.nz) || 1, nx = w.nx / L, nz = w.nz / L, vn = p.vx * nx + p.vz * nz; if (vn < 0) { p.vx -= 1.6 * vn * nx; p.vz -= 1.6 * vn * nz; } }
          if (p.t > 2) { boom(p.x, p.y, p.z, 8, 0.3, p.owner); dead = true; }
        }
        if (dead) break;
        if (p.kind !== 'g' && wallPush({ x: p.x, z: p.z, y: p.y }, 0.25)) { if (p.kind === 'm') boom(p.x, p.y, p.z, 6, 0.25, p.owner); dead = true; break; }
        // direct hits
        for (const t of targetsFor(p.owner, p.kind === 'g' && p.t > 0.5)) {
          const r = p.kind === 'b' ? 1.3 : 1.9;
          if (Math.hypot(t.x - p.x, t.z - p.z) > r || Math.abs(t.y + 0.6 - p.y) > 2) continue;
          if (p.kind === 'b') { if (!t.remote) hurt(t, 0.02, p.owner, p.vx / 150, p.vz / 150); }
          else boom(p.x, p.y, p.z, p.kind === 'm' ? 6 : 8, p.kind === 'm' ? 0.3 : 0.3, p.owner, t.id);
          dead = true; break;
        }
      }
    }
    if (dead) { scene.remove(p.m); vs.proj.splice(k, 1); continue; }
    p.m.position.set(p.x, p.y, p.z);
    if (p.kind === 'g') p.m.rotation.x += dt * 10; else p.m.rotation.set(0, -(p.h ?? Math.atan2(p.vx, -p.vz)), 0);
  }
  // explosion effects
  for (let k = vs.fx.length - 1; k >= 0; k--) {
    const e = vs.fx[k]; e.t += dt; const R = Math.max(3, e.R * 0.6), f = e.t / 0.55;
    e.fire.scale.setScalar(R * (0.3 + f)); e.fire.material.opacity = Math.max(0, 1 - f);
    e.smoke.scale.setScalar(R * (0.4 + 0.8 * f)); e.smoke.position.y += dt * 2; e.smoke.material.opacity = Math.max(0, 0.7 * (1 - e.t / 1.4));
    if (e.t > 1.4) { scene.remove(e.fire, e.smoke); e.fire.material.dispose(); e.smoke.material.dispose(); vs.fx.splice(k, 1); }
  }
}
function clearVs() {
  for (const p of vs.proj) scene.remove(p.m); vs.proj = [];
  for (const e of vs.fx) scene.remove(e.fire, e.smoke); vs.fx = [];
  clearBots(); resetAmmo(); Object.assign(vs, { dead: 0, kos: 0, wrecks: 0, lastBy: null });
}

function physicsFrame(dt, inp) {
  const sp = Math.hypot(st.vx, st.vz);
  const env = groundEnv();
  const pin = { thr: inp.thr, brk: inp.brk, clu: inp.clu, ebrake: inp.ebrake, steerAngle: steerAngleFor(inp, sp) };
  if (frozen || vs.dead > 0) { pin.thr = 0; pin.brk = 1; pin.ebrake = true; }
  kartFrame(dt, inp, pin, sp);
  if (kart.on) env.assist = { abs: true, tc: false, esc: false };
  if (boost.t > 0) { boost.t -= dt; if (boost.t <= 0) boost.a = 0; }
  if (boost.flash > 0) boost.flash -= dt;
  lastInp = Object.assign(inp, { steerAngle: pin.steerAngle });
  if (paddleHold > 0) paddleHold -= dt;
  acc += dt; let n = 0;
  while (acc >= H && n < 80) {
    if (autoShiftOn() && paddleHold <= 0) P.autoShift(car, st, pin, H, cfg.assist);
    P.step(car, st, pin, env, H); kartSub(H); acc -= H; n++;
  }
  if (n >= 80) acc = 0;
  if (st.impactV > 6.5) { damage(st.impactV - 6.5, 0, -car.HCG, 0, 1, 'landing'); }
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
  st.damage = clamp(st.damage + dv * 0.024 * DMG_SCALE, 0, 1);
  if (wx != null && model) { // deform near the impact point, in model space
    const v = new THREE.Vector3(wx, st.y - car.HCG + 0.6, wz); model.inner.worldToLocal(v);
    const n = new THREE.Vector3(nx, 0, nz).transformDirection(new THREE.Matrix4().extractRotation(model.inner.matrixWorld).invert());
    model.deform(v.x, v.z, n.x, n.z, Math.min(0.28, dv * 0.03));
    if (v.z < -0.6) st.pull = clamp(st.pull + Math.sign(v.x || 1) * dv * 0.0012, -0.04, 0.04); // bent front suspension pulls
  }
  if (Math.floor(st.damage * 10) > Math.floor(before * 10)) toast(`Damage ${Math.round(st.damage * 100)}%`);
  playThump(dv);
  checkWreck();
}
function collide(others) {
  const cOff = car.A - car.WB / 2, len = spec.visual.length, wid = spec.visual.width, r = wid / 2;
  const cs = bodyCircles(st.x, st.z, st.h, len, wid, cOff);
  const e = 0.25, fx = Math.sin(st.h), fz = -Math.cos(st.h);
  const applyImpulse = (cx, cz, nx, nz, pen, m2, v2x, v2z, other, noDmg) => {
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
    if (!noDmg && dv > 2.2) damage(dv - 2.2, 0, 0, nx, nz, 'hit', cx - nx * r, cz - nz * r); // walls: dent pushes into the body
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
  // other cars (traffic and online players), 3 circles each.
  // Damage rule: scales with closing speed. At 100 mph the car that was hit takes 50%, the car that did the hitting 25%.
  for (const o of others) {
    if (Math.abs(o.x - st.x) > 12 || Math.abs(o.z - st.z) > 12) continue;
    if (Math.abs((o.y ?? st.y) - st.y) > 2.5) continue;
    const oc = bodyCircles(o.x, o.z, o.h, o.len || 4.5, o.wid || 1.8, 0), orr = (o.wid || 1.8) / 2;
    let done = false;
    for (const [cx, cz] of cs) for (const [qx, qz] of oc) {
      if (done) break;
      const d = Math.hypot(cx - qx, cz - qz); if (d >= r + orr || d < 1e-6) continue;
      const nx = (cx - qx) / d, nz = (cz - qz) / d, pen = (r + orr - d) * 0.5;
      const closing = -((st.vx - (o.vx || 0)) * nx + (st.vz - (o.vz || 0)) * nz); // m/s, > 0 when approaching
      const mine = -(st.vx * nx + st.vz * nz), theirs = (o.vx || 0) * nx + (o.vz || 0) * nz;
      const hitter = mine >= theirs, key = o.key || o;
      const cool = hitCool.get(key) ?? -1;
      if (o.remote && !hitter) { // the other driver's game is in charge of this hit: separate now, wait for their message
        st.x += nx * pen; st.z += nz * pen;
        if (closing > 1 && now > cool) { hitCool.set(key, now + 0.8); pendingHits.push({ key, at: now + 0.35, o, nx, nz, closing, px: cx - nx * r, pz: cz - nz * r }); }
        done = true; continue;
      }
      const vBefore = [st.vx, st.vz];
      applyImpulse(cx - nx * r, cz - nz * r, nx, nz, pen, o.mass || 1500, o.vx, o.vz, o, true);
      if (closing > 1 && now > cool) {
        hitCool.set(key, now + 0.8);
        const mph = closing / MPH;
        carDamage((hitter ? 0.25 : 0.5) * mph / 100, cx - nx * r, cz - nz * r, nx, nz);
        if (o.remote && net.ready) {
          const m2 = o.mass || 1500, J = car.M * Math.hypot(st.vx - vBefore[0], st.vz - vBefore[1]);
          net.ch.send({ type: 'broadcast', event: 'hit', payload: { to: o.key, from: myId, dmg: 0.5 * mph / 100, dvx: -nx * J / m2, dvz: -nz * J / m2, px: cx - nx * r, pz: cz - nz * r } }).catch(() => {});
        }
      }
      if (o.onHit && o.hit) { o.onHit(o.hit, car.M); o.hit = null; }
      done = true;
    }
  }
}
const hitCool = new Map(), pendingHits = [];
const DMG_SCALE = 0.5; // collision damage (walls, landings, car-to-car) is half of what it used to be
function carDamage(pct, wx, wz, nx, nz, raw) { // pct: 0..1 of total damage; raw = weapon hit (not scaled)
  if (!raw) pct *= DMG_SCALE;
  if (pct <= 0.002 || vs.dead > 0) return;
  const before = st.damage;
  st.damage = clamp(st.damage + pct, 0, 1);
  if (model && wx != null) {
    const v = new THREE.Vector3(wx, st.y - car.HCG + 0.6, wz); model.inner.worldToLocal(v);
    const n = new THREE.Vector3(nx, 0, nz).transformDirection(new THREE.Matrix4().extractRotation(model.inner.matrixWorld).invert());
    model.deform(v.x, v.z, n.x, n.z, Math.min(0.3, pct * 0.8));
    if (v.z < -0.6) st.pull = clamp(st.pull + Math.sign(v.x || 1) * pct * 0.05, -0.04, 0.04);
  }
  if (Math.floor(st.damage * 10) > Math.floor(before * 10) || pct > 0.05) toast(`Hit · +${Math.round(pct * 100)}% damage (${Math.round(st.damage * 100)}%)`);
  playThump(pct * 60);
  checkWreck();
}
function onHitMsg(m) { // another driver hit us
  if (!m || m.to !== myId || !Number.isFinite(m.dmg)) return;
  for (let i = pendingHits.length - 1; i >= 0; i--) if (pendingHits[i].key === m.from) pendingHits.splice(i, 1);
  st.vx += clamp(+m.dvx || 0, -25, 25); st.vz += clamp(+m.dvz || 0, -25, 25); st.r += (Math.random() - 0.5) * 0.6;
  const d = Math.hypot(st.x - m.px, st.z - m.pz) || 1;
  carDamage(clamp(m.dmg, 0, 1), m.px, m.pz, (st.x - m.px) / d, (st.z - m.pz) / d);
}
function flushPendingHits() { // no message arrived (both games thought they were hit): apply our own estimate
  for (let i = pendingHits.length - 1; i >= 0; i--) {
    const p = pendingHits[i]; if (now < p.at) continue; pendingHits.splice(i, 1);
    const m2 = p.o.mass || 1500, dv = p.closing * 1.25 * m2 / (car.M + m2);
    st.vx += p.nx * dv; st.vz += p.nz * dv;
    carDamage(0.5 * (p.closing / MPH) / 100, p.px, p.pz, p.nx, p.nz);
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
    const straight = pc.axis === 'z' ? { x: pc.c + lane.off, z: p, y: 0, h: lane.dir > 0 ? Math.PI : 0 } : { x: p, z: pc.c + lane.off, y: 0, h: lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2 };
    const rb = cityRoundabout(pc, p);
    if (!rb) return straight;
    // around the island: push the lane out radially (right-hand traffic → counter-clockwise, island on the driver's left)
    const at = pp => { const x = pc.axis === 'z' ? pc.c + lane.off : pp, z = pc.axis === 'z' ? pp : pc.c + lane.off;
      const dx = x - rb.x, dz = z - rb.z, rho = Math.hypot(dx, dz) || 1e-3, Rr = rb.Ri + 2.5 + Math.abs(lane.off);
      const f = Math.max(0, 1 - (rho / (1.6 * Rr)) ** 2), rr = Math.sqrt(rho * rho + Rr * Rr * f * f);
      return [rb.x + dx / rho * rr, rb.z + dz / rho * rr]; };
    const [x, z] = at(p), [xa, za] = at(p - 0.5 * lane.dir), [xb, zb] = at(p + 0.5 * lane.dir);
    return { x, z, y: 0, h: Math.atan2(xb - xa, -(zb - za)) };
  }
  const r = lane.road, sp = r.len / r.n, f = clamp(p / sp, 0, r.n - 1.001), i = Math.floor(f), t = f - i, j = r.idx(i + 1);
  const x = lerp(r.x[i], r.x[j], t), z = lerp(r.z[i], r.z[j], t), y = lerp(r.y[i], r.y[j], t), rx = -r.tz[i], rz = r.tx[i];
  const h = Math.atan2(r.tx[i], -r.tz[i]) + (lane.dir < 0 ? Math.PI : 0);
  return { x: x + rx * lane.off, z: z + rz * lane.off, y, h };
}
function cityRoundabout(pc, p) {
  if (!world.roundAt) return null;
  const B = world.city.B, k = Math.round(p / B), kc = Math.round(pc.c / B);
  const rb = pc.axis === 'z' ? world.roundAt(kc, k) : world.roundAt(k, kc);
  return rb && Math.abs(p - k * B) < rb.Ro * 1.7 ? rb : null;
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
      if (cityRoundabout(pc, a.p + lane.dir * 25) || cityRoundabout(pc, a.p)) target = Math.min(target, 8.5);
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
  if (mapDef.id === LVL + 'local') return;
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
  const offRoad = !['Asphalt', 'Concrete', 'Curb', 'Packed dirt road'].includes(surfName);
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
  const paved = ['Asphalt', 'Concrete', 'Curb', 'Packed dirt road'].includes(surfName);
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
  lamp('lABS', car.abs, as.abs, st.absOn); { const e = $('lTC'); e.textContent = cfg.tc ? 'TC ' + cfg.tc : 'TC OFF'; e.classList.toggle('off', !cfg.tc); e.classList.toggle('on', !!st.tcOn); } lamp('lESC', car.esc, as.esc, st.escOn);
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
  if (vs.dead > 0) { ban.hidden = false; ban.className = 'hud'; ban.textContent = `WRECKED · respawn in ${Math.ceil(vs.dead)}`; }
  else if (speedCap) { ban.hidden = false; ban.className = 'hud info'; ban.textContent = `PIT LANE ${Math.round(speedCap * 3.6)} KM/H`; }
  else if (darkness > 0.5) { ban.hidden = true; }
  else if (surfName === 'Grass' && mapDef.generator === 'circuit' || surfName === 'Gravel' && mapDef.generator === 'circuit') { ban.hidden = false; ban.className = 'hud'; ban.textContent = 'OFF TRACK'; }
  else ban.hidden = true;
  const dr = $('drift');
  if (combo > 0) { dr.hidden = false; dr.className = 'hud'; $('dScore').textContent = Math.round(combo).toLocaleString(); $('dSub').textContent = `DRIFT ${Math.round(Math.abs(st.beta) * 180 / Math.PI)}°`; }
  else if (flashT > 0) { dr.hidden = false; dr.className = 'hud ' + flash; $('dScore').textContent = flash === 'lost' ? 'LOST' : '+' + banked.toLocaleString(); $('dSub').textContent = flash === 'lost' ? 'Spun or went off' : 'DRIFT BANKED'; }
  else dr.hidden = true;
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').hidden = true; }
  $('itemName').textContent = items.held ? ITEM_NAMES[items.held] : '—'; $('itemSlot').className = 'slot ' + (items.held || '');
  $('nitroF').style.width = (nitro.charge * 100).toFixed(0) + '%'; $('pow').classList.toggle('ready', nitro.charge >= 1);
  const wp = $('wpn'), on = weaponsOn(); wp.hidden = !on;
  if (on) {
    for (const k in WPN) { const a = vs.ammo[k], row = $('w_' + k); row.querySelectorAll('i').forEach((e, i) => e.classList.toggle('on', i < a.n)); row.querySelector('em').textContent = a.n < MAX_AMMO && a.back.length ? Math.ceil(a.back[0] - now) + 's' : ''; }
    $('wDmg').style.width = Math.round(st.damage * 100) + '%'; $('wDmgT').textContent = Math.round(st.damage * 100) + '%';
    $('wKo').textContent = `${vs.kos} KO · ${vs.wrecks} wrecked`;
  }
  const kb = $('kart');
  if (boost.flash > 0 || boost.t > 0.2) { kb.hidden = false; kb.className = 'hud boost'; $('kTxt').textContent = 'BOOST'; $('kTxt').style.color = ''; kb.querySelectorAll('i').forEach(e => e.style.background = ''); }
  else if (kart.on) { kb.hidden = false; kb.className = 'hud'; $('kTxt').textContent = 'DRIFT'; $('kTxt').style.color = KCOL[kart.tier]; kb.querySelectorAll('i').forEach((e, i) => e.style.background = kart.tier > i ? KCOL[kart.tier] : ''); }
  else kb.hidden = true;
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
  for (const b of vs.bots) if (!(b.dead > 0)) dot(b.x, b.z, 5, '#ff4a3d');
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
const myCol = () => spec && paintFor(spec.id).color != null ? paintFor(spec.id).color : myColor;
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
  const look = `${p.car}|${p.c}|${p.d}|${p.dc}|${p.dn}|${p.rm}`;
  if (gh && gh.look !== look) { removeGhost(p.id); gh = null; }
  if (gh) return gh;
  const sp = carById(p.car), color = Number.isFinite(p.c) ? p.c : 0x888888;
  const decal = typeof p.d === 'string' && p.d && p.d !== 'none' ? { style: p.d.slice(0, 12), color: Number.isFinite(p.dc) ? p.dc : 0xffffff, num: clamp(Math.round(+p.dn || 0), 0, 99) } : null;
  const m = makeModelFor(sp, { color, decal, rim: Number.isFinite(p.rm) && p.rm >= 0 ? p.rm : undefined }); scene.add(m.group);
  gh = { id: p.id, car: sp.id, look, m, color, name: '', label: null, x: p.x, z: p.z, y: p.y || 0, h: p.h, tx: p.x, tz: p.z, ty: p.y || 0, th: p.h, vx: 0, vz: 0, r: 0, t: performance.now(),
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
  $('roster').innerHTML = list.map(m => `<li class="${m.id === myId ? 'me' : ''}"><span class="sw" style="background:${hex(m.color)}"></span><span class="who">${esc(cleanName(m.name) || 'Driver')} <small>${esc((carById(m.car) || {}).name || '')}</small></span><b>${mapDef && mapDef.mode === 'arena' ? `${+m.ko || 0} KO` : fmt(Number.isFinite(m.best) ? m.best : null)}</b></li>`).join('');
  if (net.ready) setNet('ok', `Online · ${mapDef.name.split(' ')[0]} · ${roomName() === 'main' ? '' : roomName() + ' · '}${list.length} driver${list.length === 1 ? '' : 's'}`);
  $('raceBtn').disabled = !net.ready || !!race.state;
}
function trackPresence() { if (!net.ready) return; net.trackT = now; net.ch.track({ id: myId, name: myName(), color: myCol(), car: spec.id, best: run.best, laps: run.laps, ko: vs.kos, wr: vs.wrecks }).catch(() => {}); }
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
  ch.on('broadcast', { event: 'hit' }, msg => onHitMsg(msg && msg.payload));
  ch.on('broadcast', { event: 'shot' }, msg => onShot(msg && msg.payload));
  ch.on('broadcast', { event: 'wpn' }, msg => onWpn(msg && msg.payload));
  ch.on('broadcast', { event: 'ko' }, msg => onKo(msg && msg.payload));
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
  const pt = paintFor(spec.id), p = { id: myId, n: myName(), c: myCol(), d: pt.decal || '', dc: pt.dcolor ?? 0xffffff, dn: pt.num ?? 29, rm: pt.rim ?? -1, car: spec.id, x: r2(st.x), z: r2(st.z), y: r2(st.y - car.HCG), h: Math.round(st.h * 1000) / 1000, vx: r2(st.vx), vz: r2(st.vz), r: Math.round(st.r * 1000) / 1000 };
  const l = net.last, still = l && Math.hypot(st.vx, st.vz) < 0.05 && Math.abs(l.x - p.x) < 0.02 && Math.abs(l.z - p.z) < 0.02 && l.n === p.n && l.car === p.car && l.c === p.c && l.d === p.d && l.rm === p.rm && l.dc === p.dc;
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

/* ---------- kart drift sparks and boost camera ---------- */
const sparks = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return [0, 1].map(() => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); sp.visible = false; scene.add(sp); return sp; });
})();
let fovK = 0;
function kartFx(dt, fx, fz, groundY) {
  const on = kart.on && kart.tier > 0 && st.contact, rx = Math.cos(st.h), rz = Math.sin(st.h);
  sparks.forEach((sp, i) => {
    sp.visible = on; if (!on) return;
    const side = i ? 1 : -1, s = 0.55 + Math.random() * 0.5 + kart.tier * 0.12;
    sp.position.set(st.x - fx * (car.B + 0.25) + rx * side * car.TW / 2, groundY + 0.18, st.z - fz * (car.B + 0.25) + rz * side * car.TW / 2);
    sp.scale.set(s, s, 1); sp.material.color.set(KCOL[kart.tier]);
  });
  const want = boost.t > 0 ? 1 : 0; fovK += (want - fovK) * (1 - Math.exp(-dt * (want ? 8 : 3)));
  const fov = 72 + (reduceMotion ? 0 : 10 * fovK);
  if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = fov; cam.updateProjectionMatrix(); }
}

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
  model.spin(st.wr * car.RW * dt); model.steer(lastInp.steerAngle || 0);
  const bump = (surfName !== 'Asphalt' && surfName !== 'Concrete' && surfName !== 'Curb') && !reduceMotion ? (Math.random() - 0.5) * Math.min(sp, 20) * 0.003 : 0;
  model.group.visible = cfg.cam !== 'cockpit' && !(vs.dead > 0);
  $('wheel').style.visibility = cfg.cam === 'chase' ? 'hidden' : '';
  const lookBack = padLook || keys.has('AltLeft') || keys.has('AltRight');
  if (lookBack) { // rear view: from just above the front of the car, looking back past it
    chase = null;
    if (cfg.cam === 'chase') { // camera out in front, looking back over the car
      model.group.visible = !(vs.dead > 0);
      cam.position.set(st.x + fx * 7.2, groundY + 3.1, st.z + fz * 7.2); cam.lookAt(st.x - fx * 3, groundY + 1, st.z - fz * 3);
    } else { // rear-view from the back of the car
      model.group.visible = false;
      eul.set(-(smPitch + bodyP * 0.6), -st.h + Math.PI, -(smRoll + bodyR * 0.6)); q1.setFromEuler(eul);
      const r = car.B + 0.4; cam.position.set(st.x - fx * r, groundY + spec.physics.eye_height_m, st.z - fz * r); cam.quaternion.copy(q1);
    }
  } else if (cfg.cam === 'chase') {
    const want = v1.set(st.x - fx * 7.2, groundY + 3.1, st.z - fz * 7.2);
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
  kartFx(dt, fx, fz, groundY);
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
  if (scr === 'scrGarage') { renderPaint(); showroomCar(garCar); }
  if (scr === 'scrMap') renderMaps();
  if (scr === 'scrSettings') renderSettings();
  if (scr === 'scrLb') renderLbScreen();
  if (scr === 'scrPause') renderPauseCtl();
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
  $('carShift').value = shiftFor(selCar);
  showroomCar(selCar);
}
/* garage: paint, decals and rims, saved per car */
const PAINTS = [null, 0xd8432e, 0xff8a2b, 0xf2c230, 0x3ddc84, 0x1f8f5a, 0x25c6d9, 0x2f7de1, 0x1d2f6b, 0xb05ce6, 0xf26bb5, 0xf2f2f2, 0x8a8f94, 0x16181b];
const DCOLS = [0xffffff, 0x16181b, 0xffb21f, 0xd8432e, 0x2f7de1, 0x3ddc84, 0xb05ce6, 0xf26bb5, 0x25c6d9];
const RIMS = [[null, 'Chrome', 0xe2e5e8], [0x1c1e21, 'Black', 0x1c1e21], [0xd4a532, 'Gold', 0xd4a532], [0xf4f4f4, 'White', 0xf4f4f4], [0x8a8f94, 'Gunmetal', 0x8a8f94], ['paint', 'Body color', 0x888888]];
let garCar = cfg.carId;
function setPaint(patch) {
  cfg.paint = cfg.paint || {}; cfg.paint[garCar] = Object.assign({}, cfg.paint[garCar], patch); save();
  show.id = ''; showroomCar(garCar); renderPaint();
  if (ready && spec && spec.id === garCar) { scene.remove(model.group); model = makeModelFor(spec); scene.add(model.group); if (net.ready) { net.sendT = 0; trackPresence(); } }
}
function renderPaint() {
  const pt = paintFor(garCar), base = carById(garCar).visual.color, body = pt.color ?? base;
  if (!$('gCar').options.length) $('gCar').innerHTML = VEH.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  $('gCar').value = garCar;
  $('paintSw').innerHTML = PAINTS.map((c, i) => `<button type="button" class="sw${(pt.color ?? null) === c ? ' sel' : ''}" data-i="${i}" title="${c == null ? 'Factory color' : hex(c)}" aria-label="${c == null ? 'Factory color' : 'Paint ' + hex(c)}" style="background:${hex(c == null ? base : c)}">${c == null ? '<small style="font-size:9px;color:#fff;text-shadow:0 1px 2px #000">F</small>' : ''}</button>`).join('') +
    `<input type="color" id="paintCustom" aria-label="Custom paint color" title="Any color" value="${hex(body)}">`;
  $('paintSw').querySelectorAll('.sw').forEach(b => b.onclick = () => setPaint({ color: PAINTS[+b.dataset.i] }));
  $('paintCustom').oninput = e => setPaint({ color: parseInt(e.target.value.slice(1), 16) });
  const cur = pt.decal || 'none';
  $('decalSw').innerHTML = CARS.DECALS.map(([id, label]) => `<button type="button" class="${id === cur ? 'sel' : ''}" data-id="${id}">${esc(label)}</button>`).join('');
  $('decalSw').querySelectorAll('button').forEach(b => b.onclick = () => setPaint({ decal: b.dataset.id }));
  const dc = pt.dcolor ?? 0xffffff;
  $('decalColSw').innerHTML = DCOLS.map(c => `<button type="button" class="sw${c === dc ? ' sel' : ''}" data-c="${c}" aria-label="Decal ${hex(c)}" style="background:${hex(c)}"></button>`).join('') + `<input type="color" id="decalCol" aria-label="Custom decal color" value="${hex(dc)}">`;
  $('decalColSw').querySelectorAll('.sw').forEach(b => b.onclick = () => setPaint({ dcolor: +b.dataset.c }));
  $('decalCol').oninput = e => setPaint({ dcolor: parseInt(e.target.value.slice(1), 16) });
  $('decalNum').value = pt.num ?? 29; $('decalNum').disabled = !['number', 'race'].includes(cur);
  const rimNow = pt.rimSel ?? null;
  $('rimSw').innerHTML = RIMS.map(([v, label, sw], i) => `<button type="button" class="sw rim${rimNow === v ? ' sel' : ''}" data-i="${i}" style="background:${hex(v === 'paint' ? body : sw)};color:${(v === 0x1c1e21 || (v === 'paint' && body < 0x777777)) ? '#fff' : '#111'}">${label}</button>`).join('');
  $('rimSw').querySelectorAll('.sw').forEach(b => b.onclick = () => { const [v] = RIMS[+b.dataset.i]; setPaint({ rimSel: v, rim: v === 'paint' ? body : v }); });
}
function openGarage(from) { garCar = curScr === 'scrCar' ? selCar : cfg.carId; goFrom(from, 'scrGarage'); }
$('gCar').onchange = e => { garCar = e.target.value; show.id = ''; showroomCar(garCar); renderPaint(); };
$('decalNum').onchange = e => setPaint({ num: clamp(Math.round(+e.target.value || 0), 0, 99) });
$('gReset').onclick = () => { if (cfg.paint) delete cfg.paint[garCar]; save(); show.id = ''; showroomCar(garCar); renderPaint(); if (ready && spec && spec.id === garCar) { scene.remove(model.group); model = makeModelFor(spec); scene.add(model.group); } };
$('gDone').onclick = () => showMenu(document.body.dataset.from === 'pause' && ready ? 'scrPause' : document.body.dataset.from === 'car' ? 'scrCar' : 'scrMain');
$('mGarage').onclick = () => openGarage('main');
$('pGarage').onclick = () => openGarage('pause');
$('carGarage').onclick = () => { garCar = selCar; document.body.dataset.fromCar = '1'; goFrom('car', 'scrGarage'); };
$('carShift').onchange = e => { cfg.shiftByCar = cfg.shiftByCar || {}; cfg.shiftByCar[selCar] = e.target.value; save(); };
$('carOk').onclick = () => { cfg.carId = selCar; save(); if (ready) { setCar(selCar, true); loadGhost(); resetRun(); } showMenu(document.body.dataset.from === 'pause' && ready ? 'scrPause' : 'scrMain'); };

/* ---------- community levels (built in editor.html, stored in the Supabase table `levels`) ---------- */
const LVL = 'lvl:';
function levelMapDef(row) {
  const L = row.data || {}, arena = L.mode === 'arena', size = clamp(+L.size || 400, 100, 1500), th = WB.THEMES[L.theme] || WB.THEMES.grass, by = cleanName(row.author);
  return { id: LVL + row.id, name: String(L.name || row.name || 'Untitled').slice(0, 40), community: true, vs: arena,
    environment_type: (arena ? 'Community arena' : 'Community track') + (by ? ' · by ' + by : ''), dimensions: `${size * 2} × ${size * 2} m`, road_length_km: null,
    road_surface_types: ['asphalt', th.surf], weather_presets: ['clear', 'fog', 'rain'], time_presets: ['noon', 'morning', 'dusk', 'night'], traffic_density: 0,
    elevation_profile: { min_m: 0, max_m: 10, max_grade: 0.2, description: `Made in the level designer${by ? ' by ' + by : ''}. ${arena ? 'VS arena: weapons on.' : 'Race track.'}` },
    road_width: {}, hazards: ['whatever the builders put there'], roadside_objects: [], spawn_points: [{ label: 'Start' }],
    checkpoints: { every_km: 0.5, laps: clamp(Math.round(+L.laps || 3), 1, 20) }, mode: arena ? 'arena' : 'loop', generator: 'custom',
    minimap_m: arena ? Math.min(260, size) : 420, speed_limit_ms: 0, gen: { seed: 7 }, sky: th.sky, level: L };
}
function addLevelMap(row) {
  const d = levelMapDef(row), i = MAPS.findIndex(m => m.id === d.id);
  if (i >= 0) MAPS[i] = d; else MAPS.push(d);
  if (row.id !== 'local') try { localStorage.setItem('r29.lvlcache.' + row.id, JSON.stringify(row)); } catch (e) {}
  return d;
}
async function fetchLevel(id) {
  id = String(id).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16); if (!id) return null;
  if (id === 'local') { try { const t = JSON.parse(localStorage.getItem('r29.level.test') || 'null'); return t ? { id: 'local', name: t.name, author: '', data: t } : null; } catch (e) { return null; } }
  if (sb) try { const { data, error } = await sb.from('levels').select('id,name,author,data').eq('id', id).maybeSingle(); if (!error && data) return data; } catch (e) {}
  try { return JSON.parse(localStorage.getItem('r29.lvlcache.' + id) || 'null'); } catch (e) { return null; }
}
let community = null;
async function loadCommunity() {
  community = [];
  if (sb) try { const { data, error } = await sb.from('levels').select('id,name,author,mode,updated_at').order('updated_at', { ascending: false }).limit(40); if (!error && data) community = data; } catch (e) {}
  if (curScr === 'scrMap') renderMaps();
}
async function pickCommunity(id) {
  selMap = LVL + id; renderMaps();
  if (!MAPS.find(m => m.id === selMap)) { const row = await fetchLevel(id); if (row) { addLevelMap(row); renderMaps(); } else toast('Could not load that level'); }
}
function renderMaps() {
  if (community === null) loadCommunity();
  const builtIn = MAPS.filter(m => !m.community || m.id === LVL + 'local');
  $('mapCards').innerHTML = builtIn.map(m => `<button type="button" class="card${m.id === selMap ? ' sel' : ''}" data-id="${m.id}"><b>${esc(m.name)}</b><span>${esc(m.environment_type)}</span><span>${esc(m.dimensions)}</span></button>`).join('');
  $('mapCards').insertAdjacentHTML('beforeend', `<p class="cardsHead">Community levels · <a href="editor.html" target="_blank" rel="noopener">open the level designer</a></p>` +
    ((community || []).length ? community.map(c => `<button type="button" class="card${LVL + c.id === selMap ? ' sel' : ''}" data-lvl="${esc(c.id)}"><b>${esc(c.name)}</b><span>${c.mode === 'arena' ? 'Arena · weapons' : 'Race track'}</span><span>${c.author ? 'by ' + esc(cleanName(c.author)) : 'Community'}</span></button>`).join('')
      : `<p class="cardsHead note">${community === null ? 'Loading…' : 'None yet. Build one in the level designer.'}</p>`));
  $('mapCards').querySelectorAll('.card').forEach(b => b.onclick = () => { if (b.dataset.lvl) pickCommunity(b.dataset.lvl); else { selMap = b.dataset.id; renderMaps(); } });
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
  if (!MAPS.find(x => x.id === selMap)) return toast('Still loading that level…');
  const m = mapById(selMap);
  cfg.mode = $('oMode').value; cfg.weather[m.id] = $('oWeather').value; cfg.time[m.id] = $('oTime').value;
  if (!$('oTraffic').disabled) cfg.traffic = $('oTraffic').value; cfg.laps = +$('oLaps').value; save();
  await loadMap(m.id, { spawn: cfg.mode === 'trial' ? null : +$('oSpawn').value }); hideMenu();
};
function renderSettings() {
  $('sTc').value = cfg.tc; $('sTcV').textContent = cfg.tc ? cfg.tc + '/10' : 'OFF';
  $('sWeapons').value = cfg.weapons || 'vs'; $('sBots').value = String(cfg.bots ?? 3); $('sKart').value = String(cfg.kart ? 1 : 0); $('sAssist').value = cfg.assist; $('sShift').value = cfg.shift; $('sCam').value = cfg.cam; $('sSeat').value = cfg.seat; $('sGhost').value = String(cfg.ghost); $('sMini').value = String(cfg.mini); $('sQual').value = cfg.qual;
}
for (const [id, key, num] of [['sWeapons', 'weapons'], ['sBots', 'bots', 1], ['sKart', 'kart', 1], ['sAssist', 'assist'], ['sShift', 'shift'], ['sCam', 'cam'], ['sSeat', 'seat', 1], ['sGhost', 'ghost', 1], ['sMini', 'mini', 1], ['sQual', 'qual']])
  $(id).addEventListener(id === 'sSeat' ? 'input' : 'change', e => { cfg[key] = num ? +e.target.value : e.target.value; save(); if (key === 'qual') toast('Quality applies after reloading the page'); });
function renderLbScreen() {
  $('lbMap').innerHTML = MAPS.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join(''); $('lbMap').value = cfg.mapId;
  $('lbCar').innerHTML = '<option value="">All cars</option>' + VEH.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  renderLb($('lbList'), $('lbMap').value, $('lbCar').value || null);
}
$('lbMap').onchange = $('lbCar').onchange = () => renderLb($('lbList'), $('lbMap').value, $('lbCar').value || null);
$('sTc').oninput = e => { cfg.tc = +e.target.value; save(); $('sTcV').textContent = cfg.tc ? cfg.tc + '/10' : 'OFF'; };
function renderPauseCtl() { $('pTcV').textContent = cfg.tc ? 'TC ' + cfg.tc : 'TC OFF'; $('pShift').textContent = autoShiftOn() ? 'Gearbox: automatic' : 'Gearbox: manual'; }
$('pTcDn').onclick = () => { tcAdjust(-1); renderPauseCtl(); }; $('pTcUp').onclick = () => { tcAdjust(1); renderPauseCtl(); };
$('pShift').onclick = () => { toggleShift(); renderPauseCtl(); };
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
  const others = traffic.list.slice(); for (const b of vs.bots) if (!(b.dead > 0)) others.push({ key: b, x: b.x, z: b.z, y: b.y + car.HCG, h: b.h, vx: b.vx, vz: b.vz, len: b.len, wid: b.wid, mass: b.mass, onHit: (hit) => { b.v *= 0.4; b.x -= hit.nx * 0.3; b.z -= hit.nz * 0.3; } }); for (const [, gh] of ghosts) others.push({ key: gh.id, remote: true, x: gh.x, z: gh.z, y: gh.y + car.HCG, h: gh.h, vx: gh.vx, vz: gh.vz, len: gh.len, wid: gh.wid, mass: gh.mass });
  collide(others); flushPendingHits(); boostPads(); updateItems(dt); updateVs(dt);
  if (!frozen) checkGates(px, pz);
  recordGhost(dt); driftUpdate(dt); skids();
  updatePanel(inp.gp); hud(inp, dt); updateAudio(inp); netTick(dt); raceTick();
  if (world.updateLights) world.updateLights(now, st.x, st.z);
  if (world.update) world.update(now);
  if (world.boostPads) { const o = -(now * 1.6 % 1); for (const p of world.boostPads) p.tex.offset.y = o; }
}
function frame(t) {
  const dt = Math.min(0.05, (t - last) / 1000); last = t;
  const inMenu = document.body.classList.contains('inmenu');
  const showroom = inMenu && (!ready || curScr === 'scrCar' || curScr === 'scrGarage' || curScr === 'scrMain' && !ready);
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
// ?level=<id> (shared link or the designer's Test drive) jumps straight into a community level
(async () => {
  const q = new URLSearchParams(location.search).get('level'), want = q || savedLvl; if (!want) return;
  const row = await fetchLevel(want); if (!row) { if (q) toast('Level not found', 3); return; }
  const d = addLevelMap(row); cfg.mapId = d.id; selMap = d.id; if (curScr === 'scrMain') renderMain();
  if (q) { await loadMap(d.id); hideMenu(); toast(`${d.name}${row.id === 'local' ? ' · test drive' : ''}`, 2.5); }
})();

/* ---------- QA hook (automated tests) ---------- */
window.__qa = {
  loadMap: async (id, o = {}) => { if (o.weather) cfg.weather[id] = o.weather; if (o.time) cfg.time[id] = o.time; if (o.car) cfg.carId = o.car; if (o.mode) cfg.mode = o.mode; if (o.traffic != null) cfg.traffic = o.traffic; await loadMap(id, o); hideMenu(); return window.__qa.snap(); },
  snap: () => ({ map: mapDef && mapDef.id, car: spec.id, x: st.x, y: st.y, z: st.z, h: st.h, mph: Math.hypot(st.vx, st.vz) / MPH, gear: st.gear, rpm: st.we * P.RPM, surf: surfName, contact: st.contact, damage: st.damage,
    tempF: st.tempF, tempR: st.tempR, cp: run.cp, started: run.started, laps: run.laps, lastLap: run.lastLap, traffic: traffic.list.length, tiles: world && world.tiles ? world.tiles.tiles.size : 0, water: inWater, cap: speedCap, abs: st.absOn, esc: st.escOn, tc: st.tcOn, frozen, cam: cfg.cam, item: items.held, nitro: nitro.charge, shots: items.shots.length, boxes: items.boxes.length, kart: kart.on, tier: kart.tier, boost: boost.t, vy: st.vy }),
  input: o => { qaInput = o; }, cam: c => { cfg.cam = c; }, auto: mph => { qaAuto = (mph || 0) * MPH; },
  place: sp => { placeAt(sp); return window.__qa.snap(); },
  world: () => world, run: () => run, hour: h => { hour = h; },
  give: it => { items.held = it; }, fire: k => fireWeapon(k), vs: () => ({ kos: vs.kos, wrecks: vs.wrecks, dead: vs.dead, proj: vs.proj.length, bots: vs.bots.map(b => [Math.round(b.x), Math.round(b.z), +b.dmg.toFixed(2), b.dead > 0]), ammo: Object.fromEntries(Object.entries(vs.ammo).map(([k, a]) => [k, a.n])) }), hurtMe: d => { carDamage(d, null, null, 0, 0, true); }, killBots: () => vs.bots.forEach(b => { b.lastBy = myId; botWreck(b); }), setCfg: o => Object.assign(cfg, o), useItem: () => useItem(), useNitro: () => useNitro(), shot: o => onShot(o),
  advance: sec => { for (let t = 0; t < sec - 1e-9; t += 1 / 60) update(1 / 60); return window.__qa.snap(); },
};
})();
