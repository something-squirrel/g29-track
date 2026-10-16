/* R29-Track vehicle visuals. Procedural low-poly models built from the `visual` block of each vehicle.
 * Physics never reads anything here. Bodies support simple impact deformation (vertex push) and repair. */
(function (root) {
'use strict';
const PROFILES = { // side silhouettes: [fraction of length from rear, fraction of height]
  sedan:  { body: [[0, 0.24], [0, 0.6], [0.05, 0.66], [0.2, 0.68], [0.31, 0.98], [0.62, 1], [0.74, 0.7], [0.96, 0.6], [1, 0.5], [1, 0.24]], glass: [[0.32, 0.69], [0.335, 0.94], [0.61, 0.96], [0.72, 0.7]] },
  coupe:  { body: [[0, 0.26], [0, 0.58], [0.12, 0.65], [0.3, 0.96], [0.55, 1], [0.7, 0.68], [0.96, 0.55], [1, 0.42], [1, 0.26]], glass: [[0.17, 0.66], [0.31, 0.93], [0.55, 0.96], [0.67, 0.68]] },
  gt:     { body: [[0, 0.26], [0, 0.6], [0.1, 0.67], [0.27, 0.97], [0.5, 1], [0.62, 0.7], [0.97, 0.58], [1, 0.45], [1, 0.26]], glass: [[0.13, 0.68], [0.28, 0.94], [0.5, 0.96], [0.6, 0.71]] },
  muscle: { body: [[0, 0.28], [0, 0.66], [0.1, 0.7], [0.27, 0.98], [0.52, 1], [0.62, 0.73], [0.97, 0.68], [1, 0.56], [1, 0.28]], glass: [[0.13, 0.71], [0.28, 0.95], [0.51, 0.96], [0.6, 0.74]] },
  suv:    { body: [[0, 0.2], [0, 0.94], [0.04, 1], [0.72, 1], [0.8, 0.66], [0.98, 0.6], [1, 0.5], [1, 0.2]], glass: [[0.05, 0.68], [0.06, 0.95], [0.7, 0.96], [0.77, 0.68]] },
  wedge:  { body: [[0, 0.3], [0, 0.6], [0.2, 0.66], [0.3, 1], [0.58, 1], [0.68, 0.66], [0.98, 0.47], [1, 0.4], [1, 0.3]], glass: [[0.31, 0.68], [0.33, 0.96], [0.57, 0.96], [0.66, 0.68]] },
  hatch:  { body: [[0, 0.24], [0, 0.88], [0.05, 0.96], [0.5, 1], [0.66, 0.7], [0.97, 0.6], [1, 0.48], [1, 0.24]], glass: [[0.06, 0.7], [0.08, 0.92], [0.48, 0.95], [0.62, 0.7]] },
};
function extrudeProfile(pts, L, H, W, bevel) {
  const s = new THREE.Shape();
  pts.forEach(([f, h], i) => { const x = (f - 0.5) * L, y = h * H; i ? s.lineTo(x, y) : s.moveTo(x, y); });
  const g = new THREE.ExtrudeGeometry(s, { depth: W - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 2 });
  g.translate(0, 0, -(W - 2 * bevel) / 2);
  g.rotateY(Math.PI / 2); // +x (front) -> -z
  return g.index ? g.toNonIndexed() : g;
}
function makeCarModel(v, opts = {}) {
  const prof = PROFILES[v.body] || PROFILES.sedan;
  const L = v.length, W = v.width, H = v.height, wb = v.wheelbase || L * 0.6, wr = v.wheel_radius || (v.body === 'suv' ? 0.4 : 0.33);
  const grp = new THREE.Group();
  const paint = v.metallic
    ? new THREE.MeshPhongMaterial({ color: v.color, shininess: 110, specular: 0x9aa0a6 })
    : new THREE.MeshPhongMaterial({ color: v.color, shininess: 60, specular: 0x444444 });
  if (opts.ghost) { paint.transparent = true; paint.opacity = 0.35; paint.depthWrite = false; }
  const bodyGeo = extrudeProfile(prof.body, L, H, W, 0.06);
  const body = new THREE.Mesh(bodyGeo, paint); grp.add(body);
  const glassMat = new THREE.MeshPhongMaterial({ color: 0x1b242c, shininess: 120, specular: 0x88939c, transparent: !!opts.ghost, opacity: opts.ghost ? 0.3 : 1 });
  const glass = new THREE.Mesh(extrudeProfile(prof.glass, L, H, W + 0.03, 0.02), glassMat); grp.add(glass);
  const op = opts.ghost ? { transparent: true, opacity: 0.3 } : {};
  const tireMat = new THREE.MeshLambertMaterial(Object.assign({ color: 0x1c1c1c }, op));
  const wallMat = new THREE.MeshLambertMaterial(Object.assign({ color: 0x3a3a3a }, op));
  const rimMat = new THREE.MeshPhongMaterial(Object.assign({ color: 0xe2e5e8, shininess: 110, specular: 0xffffff }, op));
  const hubMat = new THREE.MeshPhongMaterial(Object.assign({ color: 0x2a2d30, shininess: 60 }, op));
  // big, visible wheels: wide tire, sidewall ring, bright 5-spoke rim; they sit partly outside the bodywork
  const TW2 = 0.38;
  const tg = new THREE.CylinderGeometry(wr, wr, TW2, 24); tg.rotateZ(Math.PI / 2);
  const sw = new THREE.TorusGeometry(wr * 0.82, wr * 0.13, 6, 24); sw.rotateY(Math.PI / 2);
  const rg = new THREE.CylinderGeometry(wr * 0.66, wr * 0.66, TW2 + 0.02, 18); rg.rotateZ(Math.PI / 2);
  const spoke = new THREE.BoxGeometry(TW2 + 0.05, wr * 1.25, wr * 0.16);
  const hub = new THREE.CylinderGeometry(wr * 0.18, wr * 0.18, TW2 + 0.08, 10); hub.rotateZ(Math.PI / 2);
  const front = wb / 2 + (v.wheel_offset || 0), wheels = [], steerers = [];
  for (const [sx, sz, f] of [[-1, -front, 1], [1, -front, 1], [-1, wb - front, 0], [1, wb - front, 0]]) {
    const steer = new THREE.Group(), w = new THREE.Group();
    w.add(new THREE.Mesh(tg, tireMat), new THREE.Mesh(rg, rimMat), new THREE.Mesh(hub, hubMat));
    for (const so of [-1, 1]) { const s2 = new THREE.Mesh(sw, wallMat); s2.position.x = so * TW2 / 2; w.add(s2); }
    for (let k = 0; k < 5; k++) { const s = new THREE.Mesh(spoke, hubMat); s.rotation.x = k * Math.PI * 2 / 5; s.scale.set(1, 1, 1); w.add(s); }
    steer.add(w); steer.position.set(sx * (W / 2 + 0.08), wr, sz); grp.add(steer); wheels.push(w); if (f) steerers.push(steer);
  }
  const lampW = new THREE.MeshBasicMaterial({ color: 0xfff6dc }), lampR = new THREE.MeshBasicMaterial({ color: 0xb01818 });
  const hl = new THREE.BoxGeometry(0.34, 0.1, 0.06);
  const lights = [];
  for (const sx of [-1, 1]) {
    const f = new THREE.Mesh(hl, lampW); f.position.set(sx * (W / 2 - 0.3), H * (prof.body.find(p => p[0] === 1) ? prof.body.filter(p => p[0] === 1)[0][1] * 0.95 : 0.5), -L / 2 - 0.02); grp.add(f);
    const r = new THREE.Mesh(hl, lampR); r.userData.rear = true; r.position.set(sx * (W / 2 - 0.3), H * prof.body[1][1] * 0.92, L / 2 + 0.02); grp.add(r); lights.push(f, r);
  }
  if (v.body === 'wedge') { // rear louvers
    const lm = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
    for (let k = 0; k < 6; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, 0.03, 0.08), lm); b.position.set(0, H * (0.66 + k * 0.006) + 0.02, L * (0.5 - 0.06 - k * 0.035) - L * 0.0); b.position.z = L / 2 - 0.25 - k * 0.14; b.position.y = H * 0.63 + k * 0.035; grp.add(b); }
  }
  const orig = Float32Array.from(bodyGeo.attributes.position.array);
  const model = { group: grp, body, wheels, lights, wr, paint, L, W, H,
    deform(lx, lz, nx, nz, amount) { // local impact point (x right, z back) and push direction
      const a = bodyGeo.attributes.position, arr = a.array, R = 0.95;
      for (let i = 0; i < arr.length; i += 3) {
        const dx = arr[i] - lx, dz = arr[i + 2] - lz, d = Math.hypot(dx, dz); if (d > R) continue;
        const k = amount * (1 - d / R);
        let nxp = arr[i] + nx * k, nzp = arr[i + 2] + nz * k;
        const ox = orig[i], oz = orig[i + 2];
        if (Math.hypot(nxp - ox, nzp - oz) > 0.4) continue;
        arr[i] = nxp; arr[i + 2] = nzp; arr[i + 1] -= k * 0.15;
      }
      a.needsUpdate = true; bodyGeo.computeVertexNormals();
    },
    repair() { bodyGeo.attributes.position.array.set(orig); bodyGeo.attributes.position.needsUpdate = true; bodyGeo.computeVertexNormals(); },
    spin(dist) { for (const w of wheels) w.rotation.x -= dist / wr; },
    steer(a) { for (const s of steerers) s.rotation.y = -a; },
  };
  if (opts.cgFromFront != null) { // put the physics centre of mass at the group origin
    const outer = new THREE.Group(); outer.add(grp); grp.position.z = wb / 2 - opts.cgFromFront; model.group = outer; model.inner = grp;
  } else model.inner = grp;
  return model;
}
/* merged low-poly car with vertex colors (body white → tinted by instanceColor) for traffic and parked cars */
function trafficGeometry() {
  const parts = [];
  const add = (g, col) => { const n = g.index ? g.toNonIndexed() : g; const c = new Float32Array(n.attributes.position.count * 3); for (let i = 0; i < c.length; i += 3) { c[i] = col[0]; c[i + 1] = col[1]; c[i + 2] = col[2]; } n.setAttribute('color', new THREE.BufferAttribute(c, 3)); parts.push(n); };
  const body = new THREE.BoxGeometry(1.8, 0.7, 4.5); body.translate(0, 0.62, 0); add(body, [1, 1, 1]);
  const cab = new THREE.BoxGeometry(1.6, 0.55, 2.2); cab.translate(0, 1.24, 0.25); add(cab, [0.16, 0.18, 0.2]);
  for (const [x, z] of [[-0.82, -1.45], [0.82, -1.45], [-0.82, 1.35], [0.82, 1.35]]) { const w = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 10); w.rotateZ(Math.PI / 2); w.translate(x, 0.33, z); add(w, [0.05, 0.05, 0.05]); }
  const tl = new THREE.BoxGeometry(1.5, 0.12, 0.05); tl.translate(0, 0.78, 2.26); add(tl, [0.7, 0.05, 0.05]);
  let count = 0; for (const p of parts) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), col = new Float32Array(count * 3); let o = 0;
  for (const p of parts) { pos.set(p.attributes.position.array, o * 3); nor.set(p.attributes.normal.array, o * 3); col.set(p.attributes.color.array, o * 3); o += p.attributes.position.count; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
root.R29Cars = { makeCarModel, trafficGeometry, PROFILES };
})(typeof self !== 'undefined' ? self : this);
