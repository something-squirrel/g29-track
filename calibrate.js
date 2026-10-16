/* Repeatable vehicle validation + calibration. Run: node calibrate.js [--fit]
 * Scenario: flat dry asphalt, 22 °C, tires at operating temperature, driver-aid defaults, no wind.
 *  0–60:  launch control if fitted (brake+throttle 1.5 s, then release), otherwise full throttle from rest;
 *         auto-shift at redline. Timed from release until 60 mph.
 *  Top:   full throttle from rest for up to 200 s; max speed reached.
 *  60–0:  stabilised at 60 mph, full brake (ABS); without ABS, the best constant pedal (threshold braking).
 * --fit adjusts calibration.torque_scale (0–60) and calibration.grip_scale (60–0) and prints JSON.
 */
const P = require('./physics.js');
const VEH = require('./vehicles.js');
const H = 1 / 1000;
const flat = (mu) => ({ muF: mu, muR: mu, rr: 0.012, water: 0, gx: 0, gz: 0, ny: 1, gH0: 0, gradX: 0, gradZ: 0, x0: 0, z0: 0,
  assist: { abs: true, tc: true, esc: true }, mode: 'normal', ambient: 22, wet: 0 });

function setup(spec) {
  const c = P.createCar(spec), s = P.createState(c);
  const mid = (c.tire.opt[0] + c.tire.opt[1]) / 2; s.tempF = s.tempR = mid;
  return { c, s, env: flat(P.surfaceMu('asphalt', 0, 0, spec.tire_type)) };
}
function settle(c, s, env) { for (let i = 0; i < 1500; i++) P.step(c, s, { thr: 0, brk: 1, clu: 0, ebrake: false, steerAngle: 0 }, env, H); }
const speed = s => Math.hypot(s.vx, s.vz);
const keepTemp = (c, s) => { const mid = (c.tire.opt[0] + c.tire.opt[1]) / 2; s.tempF = s.tempR = mid; };

function zeroToSixty(spec) {
  const { c, s, env } = setup(spec); settle(c, s, env);
  if (c.launchControl) for (let i = 0; i < 1500; i++) { P.step(c, s, { thr: 1, brk: 1, clu: 0, ebrake: false, steerAngle: 0 }, env, H); }
  let t = 0;
  while (t < 30) {
    const inp = { thr: 1, brk: 0, clu: 0, ebrake: false, steerAngle: 0 };
    P.autoShift(c, s, inp, H, 'normal');
    P.step(c, s, inp, env, H); keepTemp(c, s); t += H;
    if (speed(s) >= 60 * P.MPH) return t;
  }
  return Infinity;
}
function topSpeed(spec) {
  const { c, s, env } = setup(spec); settle(c, s, env);
  let t = 0, vmax = 0, lastGain = 0;
  while (t < 200) {
    const inp = { thr: 1, brk: 0, clu: 0, ebrake: false, steerAngle: 0 };
    P.autoShift(c, s, inp, H, 'normal');
    P.step(c, s, inp, env, H); keepTemp(c, s); t += H;
    const v = speed(s); if (v > vmax + 0.01) { vmax = v; lastGain = t; }
    if (t - lastGain > 8) break;
  }
  return vmax / P.MPH;
}
function brakeRun(spec, pedal, abs) {
  const { c, s, env } = setup(spec); env.assist.abs = abs;
  const v0 = 60 * P.MPH;
  s.vx = 0; s.vz = -v0; s.h = 0; s.wf = s.wr = v0 / c.RW; s.gear = Math.max(1, Math.min(c.TOP, 4)); s.y = c.HCG;
  // let the suspension settle at speed (no throttle needed: hold speed artificially)
  for (let i = 0; i < 800; i++) { P.step(c, s, { thr: 0, brk: 0, clu: 1, ebrake: false, steerAngle: 0 }, env, H); s.vz = -v0; s.vx = 0; s.wf = s.wr = v0 / c.RW; }
  let dist = 0, t = 0;
  while (speed(s) > 0.05 && t < 20) {
    P.step(c, s, { thr: 0, brk: pedal, clu: 1, ebrake: false, steerAngle: 0 }, env, H); keepTemp(c, s);
    dist += speed(s) * H; t += H;
  }
  return dist / P.FT;
}
function braking(spec) {
  if (spec.abs) return brakeRun(spec, 1, true);
  let best = Infinity; // threshold braking without ABS
  for (let p = 0.3; p <= 1.001; p += 0.02) best = Math.min(best, brakeRun(spec, p, false));
  return best;
}
function measure(spec) { return { zero_to_sixty_s: +zeroToSixty(spec).toFixed(2), top_speed_mph: +topSpeed(spec).toFixed(1), braking_60_0_ft: +braking(spec).toFixed(1) }; }

function bisect(f, lo, hi, target, increasing, iters = 22) {
  for (let i = 0; i < iters; i++) {
    const m = (lo + hi) / 2, v = f(m);
    if ((v > target) === increasing) hi = m; else lo = m;
  }
  return (lo + hi) / 2;
}

const fit = process.argv.includes('--fit');
const out = {};
for (const spec of VEH) {
  if (fit) {
    const cal = spec.calibration;
    cal.torque_scale = 1; cal.final_drive_scale = 1;
    const with_ = (o) => ({ ...spec, calibration: { ...cal, ...o } });
    for (let pass = 0; pass < 2; pass++) {
      cal.grip_scale = +bisect(g => braking(with_({ grip_scale: g })), 0.7, 2.2, spec.braking_distance_60_0_ft, false).toFixed(3);
      // gearing first: search final-drive scale 0.85..1.2 that keeps the top-speed target reachable
      let best = null;
      for (let k = 0.85; k <= 1.2001; k += 0.01) {
        const t = zeroToSixty(with_({ final_drive_scale: k, torque_scale: 1 }));
        const e = Math.abs(t / spec.acceleration_0_60_mph_s - 1);
        if (!best || e < best.e) best = { k: +k.toFixed(2), e, t };
      }
      cal.final_drive_scale = best.k; cal.torque_scale = 1;
      if (best.e > 0.02) { // gearing alone can't get there: nudge torque (bounded ±5%), keep it only if it helps
        const k = +bisect(k => zeroToSixty(with_({ torque_scale: k })), 0.95, 1.05, spec.acceleration_0_60_mph_s, false).toFixed(3);
        const t = zeroToSixty(with_({ torque_scale: k }));
        if (Math.abs(t / spec.acceleration_0_60_mph_s - 1) < 0.02) cal.torque_scale = k;
      }
    }
  }
  const m = measure(spec);
  const c = P.createCar(spec);
  out[spec.id] = { calibration: spec.calibration, validated: m, peak_hp: +(c.peakPowerW / P.HP).toFixed(0), peak_nm: +c.peakTorque.toFixed(0) };
  const pct = (a, b) => ((a / b - 1) * 100).toFixed(1).padStart(6) + '%';
  console.log(`${spec.name.padEnd(24)} 0-60 ${String(m.zero_to_sixty_s).padStart(5)}s (target ${spec.acceleration_0_60_mph_s}, ${pct(m.zero_to_sixty_s, spec.acceleration_0_60_mph_s)})  ` +
    `top ${String(m.top_speed_mph).padStart(5)} mph (${spec.top_speed_mph}, ${pct(m.top_speed_mph, spec.top_speed_mph)})  ` +
    `60-0 ${String(m.braking_60_0_ft).padStart(5)} ft (${spec.braking_distance_60_0_ft}, ${pct(m.braking_60_0_ft, spec.braking_distance_60_0_ft)})  ` +
    `power ${out[spec.id].peak_hp} hp / ${out[spec.id].peak_nm} Nm  cal ${JSON.stringify(spec.calibration)}`);
}
if (fit) require('fs').writeFileSync(__dirname + '/calibration.json', JSON.stringify(out, null, 1));
