/* R29-Track vehicle dynamics. No rendering code; runs in the browser and in Node (calibrate.js).
 * Single-track (bicycle) chassis with per-axle combined-slip tires, load transfer through spring-damper
 * pitch/roll modes, a heave suspension with travel limits and bump stops, engine + turbo + clutch +
 * gearbox + center coupling, ABS, traction control and stability control. SI units throughout.
 */
(function (root) {
'use strict';
const G = 9.81, RHO = 1.225, RPM = 60 / (2 * Math.PI), D2R = Math.PI / 180;
const MPH = 0.44704, HP = 745.7, FT = 0.3048;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ACCEL_SCALE = 1.2; // game-wide: every car accelerates 1.2x harder than its real-world spec (set in step)

/* Surfaces: base friction (relative to dry asphalt), category and rolling resistance coefficient. */
const SURFACES = {
  asphalt:  { label: 'Asphalt',  mu: 1.0,  cat: 'paved', rr: 0.012 },
  concrete: { label: 'Concrete', mu: 0.96, cat: 'paved', rr: 0.012 },
  curb:     { label: 'Curb',     mu: 0.88, cat: 'paved', rr: 0.016 },
  gravel:   { label: 'Gravel',   mu: 0.6,  cat: 'loose', rr: 0.05 },
  dirt:     { label: 'Dirt',     mu: 0.68, cat: 'loose', rr: 0.03 },
  hardpack: { label: 'Packed dirt road', mu: 0.92, cat: 'paved', rr: 0.016 },
  sand:     { label: 'Sand',     mu: 0.5,  cat: 'loose', rr: 0.11 },
  rock:     { label: 'Rock',     mu: 0.78, cat: 'loose', rr: 0.022 },
  grass:    { label: 'Grass',    mu: 0.55, cat: 'loose', rr: 0.05 },
  water:    { label: 'Water',    mu: 0.42, cat: 'loose', rr: 0.08 },
  snow:     { label: 'Snow',     mu: 0.3,  cat: 'snow',  rr: 0.035 },
};
/* Tire types: multipliers by condition, and the tread temperature window (°C) where grip peaks. */
const TIRES = {
  performance_street:      { label: 'Performance street',        dry: 1.0,  wet: 0.95, loose: 0.8,  snow: 0.55, opt: [60, 100] },
  summer_performance:      { label: 'Summer performance',        dry: 1.04, wet: 0.9,  loose: 0.74, snow: 0.4,  opt: [65, 105] },
  max_performance_summer:  { label: 'Max-performance summer',    dry: 1.08, wet: 0.86, loose: 0.68, snow: 0.32, opt: [75, 110] },
  wide_performance_street: { label: 'Wide performance street',   dry: 1.02, wet: 0.9,  loose: 0.76, snow: 0.45, opt: [60, 100] },
  all_terrain:             { label: 'All-terrain',               dry: 0.86, wet: 0.93, loose: 1.2,  snow: 1.0,  opt: [30, 80] },
  touring:                 { label: 'Touring (1981 spec)',        dry: 0.92, wet: 0.92, loose: 0.82, snow: 0.6,  opt: [35, 90] },
};

/* Available friction for a surface under weather (wet 0..1, snow cover 0..1) on a tire type, before
 * temperature and the per-car calibrated grip scale. */
function surfaceMu(surf, wet, snow, tireType) {
  const s = SURFACES[surf] || SURFACES.asphalt, t = TIRES[tireType] || TIRES.performance_street;
  let mu = s.mu, tf;
  if (s.cat === 'paved') { mu *= 1 - 0.28 * wet; tf = t.dry + (t.wet - t.dry) * wet; }
  else if (s.cat === 'loose') { mu *= 1 - 0.14 * wet; tf = t.loose; }
  else tf = t.snow;
  if (snow > 0 && s.cat !== 'snow') { // snow cover blends toward packed snow
    const sn = SURFACES.snow.mu * t.snow;
    return (mu * tf) * (1 - snow) + sn * snow;
  }
  return mu * tf;
}
function tempGrip(t, opt) {
  if (t < opt[0]) return Math.max(0.86, 1 - (opt[0] - t) * 0.0045);
  if (t > opt[1]) return Math.max(0.8, 1 - (t - opt[1]) * 0.004);
  return 1;
}

/* Build derived simulation constants from a vehicle data record. */
function createCar(spec) {
  const p = spec.physics, cal = spec.calibration || {};
  const M = spec.mass_kg, WB = p.wheelbase_m, fF = spec.front_weight_distribution_percent / 100;
  const A = WB * (1 - fF), B = WB * fF;
  const tqScale = cal.torque_scale || 1;
  const kind = spec.drivetrain;
  const c = {
    spec, id: spec.id, M, WB, A, B,
    HCG: spec.center_of_mass_height_m, TW: p.track_m, RW: p.wheel_radius_m,
    IZ: p.yaw_inertia_kgm2 || M * A * B * 0.92,
    IWF: p.axle_inertia_front || 3.2 + M / 600, IWR: p.axle_inertia_rear || 3.2 + M / 600,
    IE: p.engine_inertia_kgm2 || 0.2,
    TQ: p.torque_curve.map(([r, f]) => [r, f * spec.torque_nm]),
    naFrac: p.turbo ? (p.na_fraction ?? 0.62) : 1, spool: p.turbo ? (p.spool_rate ?? 6) : 60,
    IDLE: p.idle_rpm, LIMIT: p.redline_rpm,
    ratios: [p.reverse_ratio, 0, ...p.ratios], FINAL: p.final_drive * (cal.final_drive_scale || 1), TOP: p.ratios.length,
    trans: spec.transmission_type,
    shiftTime: { manual: 0.3, automatic: 0.2, dual_clutch: 0.07 }[spec.transmission_type] || 0.2,
    shiftCut: { manual: 0, automatic: 0.5, dual_clutch: 0.4 }[spec.transmission_type] ?? 0.4,
    kfNormal: kind === 'FWD' ? 1 : kind === 'RWD' ? 0 : (p.front_torque_split ?? 0.5),
    kfDrift: p.drift_torque_split ?? null,
    coupling: kind === '4WD' ? (p.center_coupling_nm || 9000) : kind === 'AWD' ? (p.center_coupling_nm || 1500) : 0,
    launchControl: !!p.launch_control, launchRpm: p.launch_rpm || 3000,
    maxSteer: p.max_steer_deg * D2R, steerRatio: p.steering_ratio,
    BRK: p.brake_torque_nm || 1.45 * M * G * p.wheel_radius_m, bias: p.brake_bias_front ?? 0.62,
    EBRAKE: p.ebrake_torque_nm || 3200 * M / 1635,
    CdA: cal.cd_a ?? p.cd_a_m2, vLimit: p.speed_limiter ? spec.top_speed_mph * MPH : Infinity,
    grip: cal.grip_scale ?? 1.3, tire: TIRES[spec.tire_type] || TIRES.performance_street, tireType: spec.tire_type,
    ky: 10.5 * (0.85 + 0.3 * spec.steering_response), kx: 13, LS: 0.12,
    rollF: p.roll_front_share ?? 0.55,
    w: 2 * Math.PI * spec.suspension_stiffness, z: spec.suspension_damping, travel: p.suspension_travel_m || 0.12,
    abs: !!spec.abs, tc: !!spec.traction_control, esc: !!spec.stability_control,
    fric: spec.torque_nm / 500,
    eff: p.drivetrain_efficiency || (({ manual: 0.88, automatic: 0.85, dual_clutch: 0.87 }[spec.transmission_type] || 0.86) - (kind === 'AWD' ? 0.03 : kind === '4WD' ? 0.05 : 0)),
  };
  c.K = M * c.w * c.w; c.C = 2 * c.z * M * c.w; c.sag = M * G / c.K;
  c.pitchW = c.w * 0.95; c.rollW = c.w * 1.1; c.FZ0 = M * G / 4;
  // scale the curve so its peak power is exactly the rated horsepower, then apply any calibration nudge
  const peak = () => { let b = 0; for (let r = c.IDLE; r <= c.LIMIT; r += 25) b = Math.max(b, torqueAt(c, r) * r / RPM); return b; };
  if (p.match_rated_power !== false) { const k = spec.engine_power_hp * HP / peak() * tqScale; c.TQ = c.TQ.map(([r, t]) => [r, t * k]); }
  c.peakPowerW = peak();
  c.peakTorque = Math.max(...c.TQ.map(t => t[1]));
  c.fric = c.peakTorque / 500;
  return c;
}
function torqueAt(c, rpm) {
  const T = c.TQ;
  if (rpm <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) if (rpm <= T[i][0]) {
    const [r0, t0] = T[i - 1], [r1, t1] = T[i]; return t0 + (t1 - t0) * (rpm - r0) / (r1 - r0);
  }
  return T[T.length - 1][1];
}

function createState(c, ambient = 22) {
  return { x: 0, z: 0, y: c.HCG, vy: 0, h: 0, vx: 0, vz: 0, r: 0, wf: 0, wr: 0, we: c.IDLE / RPM, boost: 0,
    gear: 1, shiftT: 0, tc: 1, absF: 1, absR: 1, ax: 0, ay: 0, pit: 0, pitV: 0, rol: 0, rolV: 0,
    loads: [0, 0, 0, 0], tempF: ambient + 45, tempR: ambient + 45, u: 0, lat: 0, slip: 0, limiter: false,
    Fz: c.M * G, contact: true, air: 0, escOn: false, absOn: false, tcOn: false, damage: 0, pull: 0,
    autoT: 0, beta: 0, impactV: 0, srF: 0, srR: 0, alphaF: 0, alphaR: 0, launch: false, steerAngle: 0 };
}

function placeState(c, s, x, z, y, h) {
  Object.assign(s, { x, z, y: y + c.HCG, vy: 0, h, vx: 0, vz: 0, r: 0, wf: 0, wr: 0, we: c.IDLE / RPM, boost: 0,
    tc: 1, absF: 1, absR: 1, ax: 0, ay: 0, pit: 0, pitV: 0, rol: 0, rolV: 0, gear: 1, shiftT: 0, air: 0 });
}

function splitFor(c, mode) { return mode === 'off' && c.kfDrift != null ? c.kfDrift : c.kfNormal; }
function couplingFor(c, mode) { return mode === 'off' && c.kfDrift != null ? Math.min(c.coupling, 250) : c.coupling; }

/* One fixed time step.
 * inp: { thr, brk, clu (0..1), ebrake, steerAngle (road-wheel rad) }
 * env: { muF, muR (surface×weather×tire), rr, water (m depth), gx, gz (ground-plane gravity, m/s²), ny,
 *        gH0, gradX, gradZ, x0, z0 (ground height plane for this frame), assist: {abs, tc, esc}, mode, speedCap, ambient, wet }
 */
function step(c, s, inp, env, h) {
  const sn = Math.sin(s.h), cs = Math.cos(s.h);
  const fx = sn, fz = -cs, rx = cs, rz = sn;
  const u = s.vx * fx + s.vz * fz, w = s.vx * rx + s.vz * rz, r = s.r;
  const sp = Math.hypot(s.vx, s.vz);

  // heave: spring/damper between body and ground, travel-limited, with a stiff bump stop
  const gH = env.gH0 + env.gradX * (s.x - env.x0) + env.gradZ * (s.z - env.z0);
  const gV = env.gradX * s.vx + env.gradZ * s.vz;
  const top = gH + c.HCG + c.sag;
  let Fs = 0;
  if (s.y < top) {
    const comp = top - s.y;
    Fs = c.K * comp + c.C * (gV - s.vy);
    const bump = comp - (c.sag + c.travel);
    if (bump > 0) Fs += c.K * 9 * bump + c.C * 2 * (gV - s.vy);
    if (Fs < 0) Fs = 0;
  }
  s.vy += (Fs / c.M - G) * h; s.y += s.vy * h;
  const floor = gH + Math.max(0.1, c.HCG - c.travel - 0.12);
  if (s.y < floor) { s.y = floor; if (s.vy < gV) { s.impactV = Math.max(s.impactV, gV - s.vy); s.vy = gV; } }
  s.contact = Fs > 1;
  s.air = s.contact ? 0 : s.air + h;
  const Fz = Fs * (env.ny || 1);
  s.Fz = Fz;

  // load transfer; ~30% arrives instantly through the links, the rest through the body modes
  const axE = 0.3 * s.ax + 0.7 * s.pit, ayE = 0.3 * s.ay + 0.7 * s.rol;
  const dLong = c.M * axE * c.HCG / c.WB, dLat = c.M * ayE * c.HCG / c.TW;
  const Fzf = Math.max(0.08 * Fz, Fz * c.B / c.WB - dLong * Fz / (c.M * G)), Fzr = Math.max(0.08 * Fz, Fz * c.A / c.WB + dLong * Fz / (c.M * G));
  const dLf = clamp(dLat * c.rollF * Fz / (c.M * G), -Fzf / 2, Fzf / 2), dLr = clamp(dLat * (1 - c.rollF) * Fz / (c.M * G), -Fzr / 2, Fzr / 2);
  const wl = [Fzf / 2 + dLf, Fzf / 2 - dLf, Fzr / 2 + dLr, Fzr / 2 - dLr];
  s.loads = wl;
  const tgF = tempGrip(s.tempF, c.tire.opt), tgR = tempGrip(s.tempR, c.tire.opt);
  const muF = env.muF * c.grip * tgF, muR = env.muR * c.grip * tgR;
  const grip = (mu, f) => mu * f * Math.max(0.5, 1 - c.LS * (f / c.FZ0 - 1));
  const Df = grip(muF, wl[0]) + grip(muF, wl[1]), Dr = grip(muR, wl[2]) + grip(muR, wl[3]);
  const tire = (D, sx, sy) => {
    const ex = c.kx * sx, ey = c.ky * sy, e = Math.hypot(ex, ey);
    if (e < 1e-9 || D <= 0) return [0, 0];
    const F = D * Math.sin(1.42 * Math.atan(e));
    return [F * ex / e, F * ey / e];
  };

  // front axle
  const d = inp.steerAngle + s.pull, cd = Math.cos(d), sd = Math.sin(d);
  const wfl = w + c.A * r;
  const vpar = u * cd + wfl * sd, vperp = -u * sd + wfl * cd;
  const denF = Math.max(Math.abs(vpar), 3.5);
  const srF = (s.wf * c.RW - vpar) / denF;
  const tf = tire(Df, srF, vperp / denF);
  const FxW = tf[0], FyW = -tf[1];
  const Fxf = FxW * cd - FyW * sd, Fyf = FxW * sd + FyW * cd;
  // rear axle
  const wrl = w - c.B * r;
  const denR = Math.max(Math.abs(u), 3.5);
  const srR = (s.wr * c.RW - u) / denR;
  const tr = tire(Dr, srR, wrl / denR);
  const FxR = tr[0], FyR = -tr[1];
  s.srF = srF; s.srR = srR; s.alphaF = Math.atan2(vperp, Math.abs(vpar) + 0.5); s.alphaR = Math.atan2(wrl, Math.abs(u) + 0.5);

  // drivetrain
  const assist = env.assist || {};
  const kf = splitFor(c, env.mode), cap = couplingFor(c, env.mode);
  const ratio = c.ratios[s.gear + 1] * c.FINAL;
  const wd = kf * s.wf + (1 - kf) * s.wr;
  const rpm = s.we * RPM;
  let thr = inp.thr;
  if (env.speedCap && sp > env.speedCap) thr = 0;
  const boostTarget = thr * clamp((rpm - 1200) / 1400, 0, 1);
  s.boost += (boostTarget - s.boost) * Math.min(1, h * (boostTarget > s.boost ? c.spool : 9));
  // traction control trims torque when a driven axle spins well past road speed
  const spinF = kf > 0 ? s.wf * c.RW - Math.abs(u) : 0, spinR = kf < 1 ? s.wr * c.RW - Math.abs(u) : 0;
  const spinV = Math.max(spinF, spinR);
  // traction control: level 0 (off) .. 10 (tightest). Level 7 = factory calibration. Every car gets it when a level is set.
  const lvl = env.tcLevel;
  const tcOn = lvl != null ? lvl > 0 : (assist.tc && c.tc);
  const loose = lvl != null && lvl > 0 ? 0.6 + (10 - lvl) * 0.4 / 3 : 1;
  const allowed = (0.13 * Math.max(Math.abs(u), 3) + 0.25) * loose;   // slip allowed before torque is trimmed
  const tcTarget = !tcOn ? 1 : clamp(1 - (spinV - allowed) / (0.8 + 0.05 * Math.abs(u)), 0.1, 1);
  s.tc += (tcTarget - s.tc) * Math.min(1, h * (tcTarget < s.tc ? 30 : 6));
  s.tcOn = tcOn && s.tc < 0.97;
  let Te;
  if (rpm > c.LIMIT || sp > c.vLimit) { s.limiter = true; Te = -25 * c.fric; }
  else {
    s.limiter = false;
    const full = torqueAt(c, rpm), na = full * c.naFrac;
    Te = thr * (na + (full - na) * s.boost) * (1 - 0.45 * s.damage) - c.fric * (12 + 0.009 * rpm) * (1 - thr);
    if (s.shiftT > 0) Te *= c.shiftCut;
    if (rpm < c.IDLE + 150) Te += clamp((c.IDLE + 150 - rpm) / 150, 0, 1) * 70 * c.fric;
  }
  if (Te > 0) Te *= s.tc * (s.escCut || 1);
  const launchHold = c.launchControl && s.gear > 0 && inp.brk > 0.5 && thr > 0.5 && Math.abs(u) < 1;
  s.launch = launchHold;
  if (launchHold && rpm > c.launchRpm) Te = Math.min(Te, (c.launchRpm - rpm) * 0.6);
  let cl = 1 - inp.clu;
  const wheelRpm = Math.abs(wd * ratio) * RPM;
  if (inp.clu < 0.05 && wheelRpm < c.launchRpm * 0.85 + 400) { // automatic launch: slip the clutch / converter
    const target = c.IDLE + 500 + (c.launchRpm - c.IDLE - 500) * thr;
    cl = Math.min(cl, clamp((rpm - (target - 900 * thr)) / 1000 + wheelRpm / (c.launchRpm + 600), 0.02, 1));
  }
  if (inp.ebrake || s.gear === 0) cl = 0;
  if (launchHold) cl = 0;
  if (c.trans === 'manual' && s.shiftT > 0) cl = 0;
  let Tc = 0;
  if (cl > 0 && ratio !== 0) {
    const need = (s.we - wd * ratio) / (h * (1 / c.IE + ratio * ratio * (kf * kf / c.IWF + (1 - kf) * (1 - kf) / c.IWR)));
    const capT = cl * Math.max(900, torqueAt(c, c.LIMIT * 0.6) * 1.9);
    Tc = clamp(need, -capT, capT);
  }
  s.we = clamp(s.we + (Te - Tc) / c.IE * h, (c.IDLE - 100) / RPM, (c.LIMIT + 500) / RPM);
  s.wf += (Tc * ratio * kf * c.eff - FxW * c.RW) / c.IWF * h;
  s.wr += (Tc * ratio * (1 - kf) * c.eff - FxR * c.RW) / c.IWR * h;
  if (cap > 0) {
    const need = (s.wf - s.wr) / (h * (1 / c.IWF + 1 / c.IWR)), Tk = clamp(need, -cap, cap);
    s.wf -= Tk / c.IWF * h; s.wr += Tk / c.IWR * h;
  }
  // brakes with ABS (per axle pressure modulation on slip ratio)
  const bT = inp.brk * c.BRK;
  let TbF = bT * c.bias, TbR = bT * (1 - c.bias);
  const absOn = assist.abs && c.abs && Math.abs(u) > 1.5 && inp.brk > 0.05;
  if (absOn) {
    // pressure cycling like a real 3-phase ABS: dump on deep slip, hold, slow re-apply (≈90–93% of peak grip)
    s.absF = srF < -0.17 ? Math.max(0.1, s.absF - 30 * h) : srF < -0.09 ? s.absF : Math.min(1, s.absF + 4 * h);
    s.absR = srR < -0.17 ? Math.max(0.1, s.absR - 30 * h) : srR < -0.09 ? s.absR : Math.min(1, s.absR + 4 * h);
    TbF *= s.absF; TbR *= s.absR;
  } else { s.absF = s.absR = 1; }
  s.absOn = absOn && (s.absF < 0.95 || s.absR < 0.95);
  if (inp.ebrake) TbR += c.EBRAKE;
  const brakeFric = (wv, Tb, I) => { const dec = Tb / I * h; return Math.abs(wv) <= dec ? 0 : wv - Math.sign(wv) * dec; };
  s.wf = brakeFric(s.wf, TbF, c.IWF);
  s.wr = brakeFric(s.wr, TbR, c.IWR);
  if (s.shiftT > 0) s.shiftT -= h;

  // stability control: compare yaw rate with what the steering asks for, brake one side to correct
  let escMz = 0, escFx = 0; s.escOn = false; s.escCut = 1;
  if (assist.esc && c.esc && u > 7 && s.contact) {
    const muAvg = 0.5 * (muF + muR);
    const rMax = 0.85 * muAvg * G / u;
    const rRef = clamp(u * Math.tan(d) / (c.WB * (1 + 0.0022 * u * u)), -rMax, rMax);
    const e = r - rRef;
    if (Math.abs(e) > 0.07) {
      const want = -Math.sign(e) * Math.min(Math.abs(e) - 0.07, 0.6) * c.IZ * 9;
      const lim = 0.35 * muAvg * Fz * c.TW / 2;
      escMz = clamp(want, -lim, lim);
      escFx = -Math.abs(escMz) / (c.TW / 2) * 0.6;
      s.escOn = true; s.escCut = 0.6;
    }
  }

  // body
  const sgnU = Math.abs(u) < 0.05 ? 0 : Math.sign(u);
  const roll = (env.rr || 0.012) * Fz * Math.min(1, Math.abs(u) / 0.5) * sgnU;
  const FxT = Fxf + FxR, FyT = Fyf + FyR;
  const gxB = (env.gx || 0) * fx + (env.gz || 0) * fz, gyB = (env.gx || 0) * rx + (env.gz || 0) * rz;
  // acceleration boost: while on the throttle (not braking), the tires' forward drive force counts 1.2x
  const accelK = (root.R29_ACCEL ?? ACCEL_SCALE) - 1, bonus = thr > 0.02 && inp.brk < 0.05 && u > -0.5 ? accelK * Math.max(0, FxT) : 0;
  const Fx = FxT + bonus - roll + escFx * sgnU + c.M * gxB, Fy = FyT + c.M * gyB;
  const Tz = c.A * Fyf - c.B * FyR + escMz;
  const drag = 0.5 * RHO * c.CdA * sp + (env.water ? 140 * env.water * c.TW * sp : 0);
  s.vx += ((fx * Fx + rx * Fy) / c.M - drag * s.vx / c.M) * h;
  s.vz += ((fz * Fx + rz * Fy) / c.M - drag * s.vz / c.M) * h;
  s.r += Tz / c.IZ * h;
  if (sp < 0.3 && thr < 0.05 && Math.abs(gxB) < 0.4) { s.r *= 0.9; s.vx *= 0.98; s.vz *= 0.98; }
  s.h += s.r * h;
  s.x += s.vx * h; s.z += s.vz * h;
  s.ax = FxT / c.M; s.ay = FyT / c.M;
  s.pitV += (c.pitchW * c.pitchW * (s.ax - s.pit) - 2 * c.z * c.pitchW * s.pitV) * h; s.pit += s.pitV * h;
  s.rolV += (c.rollW * c.rollW * (s.ay - s.rol) - 2 * c.z * c.rollW * s.rolV) * h; s.rol += s.rolV * h;

  // tire temperatures: heat from slip power, cooling toward ambient (faster with speed and water)
  const amb = env.ambient ?? 22, cool = (0.006 + 0.0004 * sp) * (1 + 1.5 * (env.wet || 0) + (env.water ? 3 : 0));
  const vsF = Math.hypot(s.wf * c.RW - vpar, vperp), vsR = Math.hypot(s.wr * c.RW - u, wrl);
  s.tempF += (Math.hypot(FxW, FyW) * vsF * 4.5e-5 - (s.tempF - amb) * cool) * h;
  s.tempR += (Math.hypot(FxR, FyR) * vsR * 4.5e-5 - (s.tempR - amb) * cool) * h;

  s.u = u; s.lat = Fy / c.M;
  s.slip = sp > 3 ? clamp(Math.max(0, Math.abs(s.alphaR) - 0.1) * 4 + Math.max(0, Math.abs(srR) - 0.15) * 1.5 + Math.max(0, -srF - 0.25) * 1.2, 0, 1) : 0;
}

/* Gear changes. Returns true if the gear changed. Rev-matched downshifts, over-rev protection. */
function shift(c, s, dir, mode) {
  const kf = splitFor(c, mode);
  if (dir > 0) {
    if (s.gear < c.TOP) { s.gear++; if (s.gear > 1) s.shiftT = c.shiftTime; return true; }
    return false;
  }
  if (s.gear > 1) {
    const target = Math.abs((kf * s.wf + (1 - kf) * s.wr) * c.ratios[s.gear] * c.FINAL) * RPM;
    if (target > c.LIMIT + 200) return false;
    s.gear--;
    s.shiftT = c.shiftTime * 0.8;
    s.we = clamp(target, c.IDLE, c.LIMIT) / RPM;
    s.boost = Math.max(s.boost, 0.5);
    return true;
  }
  if (s.gear === 1) { s.gear = 0; return true; }
  if (s.gear === 0 && s.u < 2) { s.gear = -1; return true; }
  return false;
}

/* Automatic gear selection for automatic/DCT cars (and manual cars with auto-shift switched on). */
function autoShift(c, s, inp, h, mode) {
  if (s.gear < 1 || s.shiftT > 0) return;
  s.autoT -= h; if (s.autoT > 0) return;
  const kf = splitFor(c, mode);
  const wd = Math.abs(kf * s.wf + (1 - kf) * s.wr);
  const rw = wd * c.ratios[s.gear + 1] * c.FINAL * RPM;     // engine speed the wheels are asking for
  const thr = inp.thr;
  const up = thr > 0.85 ? c.LIMIT - 120 : 1900 + (c.LIMIT - 2500) * thr;
  if (s.gear < c.TOP && rw > up && !s.launch) { shift(c, s, 1, mode); s.autoT = 0.35; return; }
  if (s.gear > 1) {
    const lower = wd * c.ratios[s.gear] * c.FINAL * RPM;
    const down = 1200 + (c.LIMIT * 0.55 - 1200) * thr * thr;
    if (rw < down && lower < c.LIMIT - 600) { shift(c, s, -1, mode); s.autoT = 0.45; }
  }
}

const api = { G, RHO, RPM, D2R, MPH, HP, FT, SURFACES, TIRES, surfaceMu, tempGrip, createCar, createState, placeState,
  step, shift, autoShift, torqueAt, splitFor };
if (typeof module === 'object' && module.exports) module.exports = api; else root.R29Physics = api;
})(typeof self !== 'undefined' ? self : this);
