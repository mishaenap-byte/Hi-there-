// Город в 3D: three.js + модели Kenney (жители — Mini Characters, промзона на горизонте — City Kit Industrial).
// Логика игры (карта, путь, квесты, разговоры) остаётся в index.html; здесь только картинка и нажатия.
import * as THREE from "./three-r169.js";

// житель → модель Kenney
const SKIN = { me: "male-a", barista: "female-b", neighbour: "male-f", pharmacist: "male-d", clerk: "female-d", grandma: "female-c", kid: "male-e", shopkeeper: "female-f", postman: "male-c", librarian: "female-e" };
const DIR_ANG = [0, -Math.PI / 2, Math.PI / 2, Math.PI];   // 0 вниз (к камере), 1 влево, 2 вправо, 3 вверх
const hash = (x, y) => { let h = x * 374761393 + y * 668265263; h = (h ^ (h >> 13)) * 1274126177; return ((h ^ (h >> 16)) >>> 0) / 4294967295; };
const angTo = (a, b, k) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * k; };

export async function start(G) {
  const { MAP, W, H, B, NPC, CT, state: CG, host } = G;
  const tile = (x, y) => x < 0 || y < 0 || x >= W || y >= H ? "#" : MAP[y][x];

  // ---------- сцена ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const el = renderer.domElement; el.className = "ct-cv ct-cv3"; el.setAttribute("aria-label", "Город");
  const scene = new THREE.Scene();
  const SKY = new THREE.Color("#BFE6FF");
  scene.background = SKY; scene.fog = new THREE.Fog(SKY, 30, 80);
  const cam = new THREE.PerspectiveCamera(45, 1, 0.5, 200);
  scene.add(new THREE.HemisphereLight("#E9F6FF", "#7FA866", 1.6));
  const sun = new THREE.DirectionalLight("#FFF4DC", 2.2);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 60 });
  scene.add(sun, sun.target);

  // ---------- земля: рисуем те же клетки, что и в 2D, на одну текстуру ----------
  const gc = document.createElement("canvas"); gc.width = W * CT; gc.height = H * CT;
  G.paintGround(gc.getContext("2d"));
  const gtex = new THREE.CanvasTexture(gc); gtex.colorSpace = THREE.SRGBColorSpace; gtex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, H).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: gtex }));
  ground.position.set(W / 2, 0, H / 2); ground.receiveShadow = true; scene.add(ground);
  const far = new THREE.Mesh(new THREE.PlaneGeometry(260, 260).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: "#8CCB6E" }));
  far.position.set(W / 2, -0.02, H / 2); far.receiveShadow = true; scene.add(far);

  // ---------- статичные предметы: копим кусочки, потом склеиваем по цвету (меньше работы телефону) ----------
  const mats = {}, parts = [];
  const mat = c => mats[c] || (mats[c] = new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
  const put = (g, c) => { g = g.index ? g.toNonIndexed() : g; g.clearGroups(); g.deleteAttribute("uv"); parts.push([g, c]); };
  const box = (w, h, d, x, y, z, c, rx = 0, ry = 0) => { const g = new THREE.BoxGeometry(w, h, d); if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); g.translate(x, y, z); put(g, c); };
  const cyl = (rt, rb, h, x, y, z, c, seg = 10) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.translate(x, y, z); put(g, c); };
  const ball = (r, x, y, z, c, sy = 1) => { const g = new THREE.IcosahedronGeometry(r, 1); g.scale(1, sy, 1); g.translate(x, y, z); put(g, c); };

  // дороги за краем карты, чтобы город не обрывался
  const road = "#5E6370";
  box(40, 0.02, 2, -20, -0.005, 7, road); box(40, 0.02, 2, W + 20, -0.005, 7, road);
  box(40, 0.02, 2, -20, -0.005, 23, road); box(40, 0.02, 2, W + 20, -0.005, 23, road);
  box(2, 0.02, 40, 12, -0.005, H + 20, road);

  const tree = (x, z, s) => {
    const n = hash(Math.round(x * 3), Math.round(z * 7)), k = (0.85 + n * 0.35) * (s || 1);
    cyl(0.07 * k, 0.1 * k, 0.55 * k, x, 0.27 * k, z, "#8A5A2B", 6);
    ball(0.42 * k, x, 0.82 * k, z, n > 0.5 ? "#5DBB63" : "#3FA34D", 1.05);
    ball(0.28 * k, x + 0.08, 1.16 * k, z - 0.05, n > 0.5 ? "#6CCB6E" : "#4DB45A");
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = tile(x, y), X = x + 0.5, Z = y + 0.5;
    if (t === "T") tree(X, Z);
    else if (t === "L") { cyl(0.035, 0.05, 1.45, X, 0.72, Z, "#3A3F4B", 6); box(0.2, 0.08, 0.2, X, 1.48, Z, "#3A3F4B"); box(0.14, 0.1, 0.14, X, 1.39, Z, "#FFE58A"); }
    else if (t === "b") { box(0.8, 0.07, 0.32, X, 0.34, Z, "#B97A3E"); box(0.8, 0.26, 0.06, X, 0.52, Z - 0.14, "#B97A3E"); box(0.06, 0.32, 0.28, X - 0.32, 0.16, Z, "#3A3F4B"); box(0.06, 0.32, 0.28, X + 0.32, 0.16, Z, "#3A3F4B"); }
    else if (t === "o") { cyl(0.47, 0.5, 0.26, X, 0.13, Z, "#CFD6E0", 16); cyl(0.4, 0.4, 0.03, X, 0.25, Z, "#7FCBF2", 16); cyl(0.06, 0.08, 0.55, X, 0.45, Z, "#CFD6E0", 8); cyl(0.2, 0.1, 0.08, X, 0.72, Z, "#CFD6E0", 12); cyl(0.15, 0.15, 0.02, X, 0.76, Z, "#A9DDF7", 12); }
    else if (t === "h") { box(0.98, 0.42, 0.62, X, 0.21, Z, "#57B05A"); ["#FF6FB5", "#FFEC3D", "#FFFFFF"].forEach((c, k) => ball(0.06, X - 0.3 + k * 0.3, 0.44, Z + (k % 2 ? 0.12 : -0.1), c)); }
    else if (t === "f") { box(1, 0.06, 0.05, X, 0.24, Z, "#FFFFFF"); box(1, 0.06, 0.05, X, 0.44, Z, "#FFFFFF"); for (const o of [-0.36, 0, 0.36]) box(0.08, 0.56, 0.08, X + o, 0.28, Z, "#FFFFFF"); }
    else if (t === "~" && tile(x, y - 1) !== "~") box(1, 0.08, 0.1, X, 0.04, y + 0.05, "#CFD6E0");
  }
  // деревья вокруг карты
  for (let i = -3; i < W + 3; i += 1.7) { tree(i + 0.3, -1.4 - hash(i * 5, 1) * 1.2); tree(i + 0.8, H + 1.2 + hash(i * 3, 2) * 1.5); }
  for (let j = 0; j < H; j += 1.6) { if (Math.abs(j - 7) > 1.6 && Math.abs(j - 23) > 1.6) { tree(-1.3 - hash(3, j * 4), j + 0.4); tree(W + 1.3 + hash(5, j * 4), j + 0.7); } }

  // ---------- здания из карты ----------
  const signTex = (text, bg, fg, big) => {
    const c = document.createElement("canvas"), x = c.getContext("2d"), f = big ? 64 : 48;
    x.font = `900 ${f}px system-ui, -apple-system, sans-serif`;
    const w = Math.ceil(x.measureText(text).width + f * 1.1), h = Math.round(f * 1.6);
    c.width = w; c.height = h;
    x.fillStyle = bg; x.strokeStyle = "#17171F"; x.lineWidth = 8;
    x.beginPath(); x.roundRect(4, 4, w - 8, h - 8, 18); x.fill(); x.stroke();
    x.fillStyle = fg; x.font = `900 ${f}px system-ui, -apple-system, sans-serif`; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(text, w / 2, h / 2 + 3);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return { t, a: w / h };
  };
  const plane = (tex, w, h, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ map: tex, transparent: true }));
    m.position.set(x, y, z); m.rotation.x = rx; scene.add(m); return m;
  };
  const awningTex = c => {
    const cv = document.createElement("canvas"); cv.width = 128; cv.height = 8; const x = cv.getContext("2d");
    for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? "#FFFFFF" : c; x.fillRect(i * 16, 0, 16, 8); }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.magFilter = THREE.NearestFilter; return t;
  };
  const boxes = [];
  for (const b of B) {
    const x0 = b.x, z0 = b.y, cx = x0 + b.w / 2, cz = z0 + b.h / 2, front = z0 + b.h;
    const house = b.id === "home" || b.id === "house2", gable = house || b.id === "library";
    const Hh = b.id === "station" ? 2.5 : b.id === "library" ? 2.2 : house ? 1.45 : 2.15;
    box(b.w - 0.1, Hh, b.h - 0.1, cx, Hh / 2, cz, b.wall);
    box(b.w - 0.02, 0.14, b.h - 0.02, cx, 0.07, cz, "#B9B2A6");
    const win = (x, y, z, w, h, ry = 0) => { box(w + 0.1, h + 0.1, 0.04, x, y, z, "#FFFFFF", 0, ry); box(w, h, 0.05, x, y, z + (ry ? 0 : 0.005), "#9FD3F0", 0, ry); };
    for (let i = 0; i < b.w; i++) {
      const X = x0 + i + 0.5;
      if (x0 + i === b.door) {
        box(0.62, 0.95, 0.04, X, 0.5, front - 0.03, "#FFFFFF"); box(0.5, 0.86, 0.06, X, 0.45, front - 0.02, "#6B4A2F");
        box(0.06, 0.06, 0.04, X + 0.15, 0.45, front + 0.02, "#FFE58A");
        box(0.9, 0.06, 0.3, X, 0.03, front + 0.15, "#CFC6B6");
      } else win(X, b.awning ? 0.62 : 0.68, front - 0.02, b.awning ? 0.66 : 0.5, b.awning ? 0.62 : 0.46);
      if (Hh > 2) win(X, Hh - 0.48, front - 0.02, 0.42, 0.4);
    }
    for (let j = 0; j < b.h - 1; j++) for (const sx of [x0 + 0.03, x0 + b.w - 0.03]) if (Hh > 2) win(sx, Hh - 0.48, z0 + j + 0.5, 0.42, 0.4, Math.PI / 2);
    if (gable) {   // двускатная крыша
      const ov = 0.18, rh = house ? 0.85 : 0.7, half = b.h / 2 + ov, L = Math.hypot(half, rh), a = Math.atan2(rh, half);
      const sh = new THREE.Shape([new THREE.Vector2(-b.h / 2 + 0.05, 0), new THREE.Vector2(b.h / 2 - 0.05, 0), new THREE.Vector2(0, rh - 0.05)]);
      const g = new THREE.ExtrudeGeometry(sh, { depth: b.w - 0.1, bevelEnabled: false }); g.rotateY(Math.PI / 2); g.translate(x0 + 0.05, Hh, cz); put(g, b.wall);
      box(b.w + ov * 2, 0.09, L, cx, Hh + rh / 2, cz + half / 2, b.roof, a); box(b.w + ov * 2, 0.09, L, cx, Hh + rh / 2, cz - half / 2, b.roof, -a);
      if (house) box(0.26, 0.6, 0.26, x0 + b.w - 0.9, Hh + 0.55, cz - 0.5, "#B05A45");
    } else {       // плоская крыша с бортиком
      box(b.w, 0.12, b.h, cx, Hh + 0.06, cz, b.roof);
      box(b.w, 0.18, 0.1, cx, Hh + 0.2, front - 0.05, b.roof); box(b.w, 0.18, 0.1, cx, Hh + 0.2, z0 + 0.05, b.roof);
      box(0.1, 0.18, b.h, x0 + 0.05, Hh + 0.2, cz, b.roof); box(0.1, 0.18, b.h, x0 + b.w - 0.05, Hh + 0.2, cz, b.roof);
    }
    if (b.id === "station") {   // часы на башенке
      box(1.4, 1, 1.2, cx, Hh + 0.5, front - 1, b.wall); box(1.6, 0.12, 1.4, cx, Hh + 1.06, front - 1, b.roof);
      cyl(0.36, 0.36, 0.06, cx, Hh + 0.5, front - 0.38, "#FFFFFF", 20); box(0.04, 0.24, 0.02, cx, Hh + 0.58, front - 0.34, "#17171F"); box(0.18, 0.04, 0.02, cx + 0.07, Hh + 0.5, front - 0.34, "#17171F");
    }
    if (b.awning) {
      const t = awningTex(b.awning); t.repeat.set(b.w / 2, 1);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(b.w - 0.1, 0.42), new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide }));
      m.position.set(cx, 1.28, front + 0.16); m.rotation.x = -Math.PI / 2 + 0.55; m.castShadow = true; scene.add(m);
    }
    if (b.sign) {
      const { t, a } = signTex(b.sign, "#FFFFFF", "#17171F", b.id === "station");
      const h = b.id === "station" ? 0.62 : b.id === "library" ? 0.5 : 0.4, y = b.id === "station" ? Hh + 0.45 : Hh + 0.32;   // вывеска стоит на крыше над фасадом
      plane(t, h * a, h, cx, y, front + (b.id === "library" ? 0.2 : 0.01));
    }
    boxes.push({ b, box: new THREE.Box3(new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x0 + b.w, Hh + 0.6, front)) });
  }

  // склеиваем по цвету
  const byC = {};
  for (const [g, c] of parts) (byC[c] = byC[c] || []).push(g);
  for (const c in byC) {
    const m = new THREE.Mesh(THREE.mergeGeometries(byC[c]), mat(c));
    m.castShadow = true; m.receiveShadow = true; scene.add(m);
    byC[c].forEach(g => g.dispose());
  }

  // ---------- модели Kenney ----------
  const loader = new THREE.GLTFLoader();
  const url = p => new URL(p, import.meta.url).href;
  const load = p => loader.loadAsync(url(p));
  const crisp = o => o.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; if (m.material.map) { m.material.map.magFilter = THREE.NearestFilter; m.material.map.minFilter = THREE.NearestFilter; m.material.map.generateMipmaps = false; } } });
  // промзона на горизонте
  const IND = [["building-l", -7, -7, 0], ["building-a", 4, -6.5, 0], ["water-tower", 11, -6, 0], ["building-r", 17, -7.5, 0], ["building-n", 26, -6, Math.PI / 2], ["windmill", -3, -3.5, 0], ["chimney-large", 21.5, -9, 0],
    ["building-d", 33, 3, -Math.PI / 2], ["building-q", 33, 14, -Math.PI / 2], ["detail-tank-large", 31.5, 19, 0], ["building-a", 33, 30, -Math.PI / 2], ["windmill", 30, 37, 0], ["shipping-container-a", 30, 9.5, 0.2], ["shipping-container-b", 30.2, 11.4, 0],
    ["building-r", -7, 13, Math.PI / 2], ["building-l", -7.5, 29, Math.PI / 2], ["water-tower", -4.5, 37, 0], ["shipping-container-b", -4, 20, Math.PI / 2]];
  const kinds = [...new Set(IND.map(i => i[0]))];
  const charP = Promise.all(Object.entries(SKIN).map(([id, f]) => load(`chars/character-${f}.glb`).then(g => [id, g])));
  const bldP = Promise.all(kinds.map(k => load(`bld/${k}.glb`).then(g => [k, g.scene]))).catch(() => []);
  const [chars, blds] = await Promise.all([charP, bldP]);
  const BL = Object.fromEntries(blds);
  for (const [k, x, z, r] of IND) {
    if (!BL[k]) continue;
    const o = BL[k].clone(); o.scale.setScalar(k.startsWith("shipping") ? 1.6 : k === "windmill" || k === "water-tower" ? 3.2 : 4.2); o.position.set(x, 0, z); o.rotation.y = r; crisp(o); scene.add(o);
  }

  // жители и герой
  const P = {};
  const marks = {};
  for (const [id, g] of chars) {
    const o = g.scene; crisp(o); o.scale.setScalar(1.5);
    const mixer = new THREE.AnimationMixer(o), A = {};
    for (const c of g.animations) A[c.name] = mixer.clipAction(c);
    const idle = A.idle || A.static; idle.play(); idle.time = Math.random() * 2;
    P[id] = { o, mixer, A, cur: idle, ang: 0 };
    mixer.addEventListener("finished", () => to(P[id], "idle"));
    if (id !== "me") { const n = NPC[id]; o.position.set(n.x + 0.5, 0, n.y + 0.5); P[id].ang = o.rotation.y = DIR_ANG[n.dir || 0]; }
    scene.add(o);
  }
  function to(p, name, once) {
    const a = p.A[name]; if (!a || (p.cur === a && !once)) return;
    a.reset(); a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat); a.clampWhenFinished = !!once;
    a.fadeIn(0.15); if (p.cur && p.cur !== a) p.cur.fadeOut(0.15); a.play(); p.cur = a;
  }
  // кольцо под героем, кружок цели, значки ! и ? над тем, кто ждёт
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.38, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#FFEC3D", transparent: true, opacity: 0.95, depthWrite: false }));
  ring.position.y = 0.015; scene.add(ring);
  const goal = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.28, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#17171F", transparent: true, opacity: 0.45, depthWrite: false }));
  goal.position.y = 0.015; scene.add(goal);
  const markTex = ch => {
    const c = document.createElement("canvas"); c.width = c.height = 128; const x = c.getContext("2d");
    x.fillStyle = ch === "!" ? "#FFEC3D" : "#FFFFFF"; x.strokeStyle = "#17171F"; x.lineWidth = 10;
    x.beginPath(); x.arc(64, 64, 52, 0, 7); x.fill(); x.stroke();
    x.fillStyle = "#17171F"; x.font = "900 76px system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(ch, 64, 68);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  };
  for (const ch of ["!", "?"]) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: markTex(ch), depthTest: false })); s.scale.setScalar(0.48); s.renderOrder = 5; s.visible = false; scene.add(s); marks[ch] = s; }

  // ---------- камера и кадр ----------
  const look = new THREE.Vector3(), camAt = new THREE.Vector3(), v = new THREE.Vector3();
  let dist = 24, zoom = 1, last = 0, lastMe = null, first = true;
  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1, asp = w / h;
    renderer.setSize(w, h, false); cam.aspect = asp; cam.updateProjectionMatrix();
    const t = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    dist = Math.max(9.5 / (2 * t * asp), 13 / (2 * t));
    scene.fog.near = dist + 6; scene.fog.far = dist + 50;
  }
  const meAt = () => [CG.px / CT + 0.5, CG.py / CT + 0.5];
  function frame(t) {
    const dt = Math.min(0.06, last ? (t - last) / 1000 : 0.016); last = t;
    const me = P.me, [mx, mz] = meAt();
    // герой: идёт — смотрит по ходу; говорит — смотрит на собеседника
    let want = me.ang;
    if (lastMe) { const dx = mx - lastMe[0], dz = mz - lastMe[1]; if (Math.abs(dx) + Math.abs(dz) > 1e-4) want = Math.atan2(dx, dz); }
    const talk = CG.dlg && P[CG.dlg.id] ? NPC[CG.dlg.id] : null;
    if (talk) want = Math.atan2(talk.x + 0.5 - mx, talk.y + 0.5 - mz);
    me.ang = angTo(me.ang, want, Math.min(1, dt * 14)); me.o.rotation.y = me.ang;
    me.o.position.set(mx, 0, mz); lastMe = [mx, mz];
    to(me, CG.walk ? "walk" : "idle");
    if (me.A.walk) me.A.walk.timeScale = 1.25;
    for (const id in NPC) {
      const p = P[id]; if (!p) continue;
      const n = NPC[id], face = talk === n ? Math.atan2(mx - n.x - 0.5, mz - n.y - 0.5) : DIR_ANG[n.dir || 0];
      p.ang = angTo(p.ang, face, Math.min(1, dt * 8)); p.o.rotation.y = p.ang;
    }
    for (const id in P) P[id].mixer.update(dt);
    ring.position.x = mx; ring.position.z = mz;
    if (CG.path.length) { const [gx, gy] = CG.path[CG.path.length - 1]; goal.visible = true; goal.position.x = gx + 0.5; goal.position.z = gy + 0.5; } else goal.visible = false;
    const tid = G.target(), mk = G.mark();
    for (const ch in marks) marks[ch].visible = false;
    if (tid && P[tid] && !CG.dlg) { const s = marks[mk]; s.visible = true; s.position.set(NPC[tid].x + 0.5, 1.3 + Math.sin(t / 260) * 0.07, NPC[tid].y + 0.5); }
    // камера мягко следует за героем
    // в разговоре камера подъезжает к двоим и держит их над окном диалога
    zoom += ((talk ? 0.62 : 1) - zoom) * Math.min(1, dt * 4);
    const k = (1 - zoom) / 0.38, el = THREE.MathUtils.degToRad(46 + 18 * k), d = dist * zoom;   // в разговоре — ближе и сверху, чтобы дома не загораживали
    if (talk) look.set((mx + talk.x + 0.5) / 2, 0, (mz + talk.y + 0.5) / 2 + d * 0.15);
    else look.set(Math.max(3, Math.min(W - 3, mx)), 0, Math.max(4, Math.min(H - 6, mz)));
    if (first) { camAt.copy(look); first = false; } else camAt.lerp(look, Math.min(1, dt * 4));
    cam.position.set(camAt.x, Math.sin(el) * d, camAt.z + Math.cos(el) * d); cam.lookAt(camAt);
    sun.position.set(camAt.x - 7, 16, camAt.z + 5); sun.target.position.copy(camAt);
    const sc = sun.shadow.camera, half = Math.min(22, dist * 0.62); if (sc.right !== half) { sc.left = sc.bottom = -half; sc.right = sc.top = half; sc.updateProjectionMatrix(); }
    renderer.render(scene, cam);
  }
  // ---------- нажатия ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), gp = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3(), hb = new THREE.Vector3();
  const proj = (x, y, z) => { v.set(x, y, z).project(cam); return [(v.x + 1) / 2 * host.clientWidth, (1 - v.y) / 2 * host.clientHeight]; };
  function pick(cx, cy) {
    const r = el.getBoundingClientRect(), sx = cx - r.left, sy = cy - r.top;
    let best = null, bd = 30;
    for (const id in NPC) { const n = NPC[id], [px, py] = proj(n.x + 0.5, 0.5, n.y + 0.5), d = Math.hypot(px - sx, py - sy); if (d < bd) { bd = d; best = id; } }
    if (best) return { npc: best };
    ndc.set(sx / r.width * 2 - 1, -(sy / r.height) * 2 + 1); ray.setFromCamera(ndc, cam);
    const g = ray.ray.intersectPlane(gp, hit), gd = g ? g.distanceTo(ray.ray.origin) : Infinity;
    let bb = null, bdist = Infinity;
    for (const x of boxes) { const p = ray.ray.intersectBox(x.box, hb); if (p) { const d = p.distanceTo(ray.ray.origin); if (d < bdist) { bdist = d; bb = x.b; } } }
    if (bb && bdist < gd) return { b: bb };
    return g ? { x: Math.floor(g.x), y: Math.floor(g.z) } : null;
  }
  const screen = id => { const n = NPC[id]; return proj(n.x + 0.5, 0.6, n.y + 0.5); };
  const emote = (id, ok) => { const p = P[id]; if (p) to(p, ok ? "emote-yes" : "emote-no", true); };

  host.insertBefore(el, host.firstChild);
  resize();
  frame(performance.now());
  return { el, frame, pick, screen, emote, resize, dispose: () => { renderer.dispose(); el.remove(); } };
}
