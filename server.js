// Servidor: sirve la página y retransmite por WebSocket.
//
// Señal (la parte rápida): cliente->servidor "1"/"0" (apretado/suelto); servidor->cliente "1"/"0" = ¿hay
// alguien CONECTADO conmigo apretando? Solo se avisa entre dispositivos conectados (por solicitud directa
// o por sala), nunca de un dispositivo a sí mismo.
//
// Control (conexiones y salas): mensajes JSON, que siempre empiezan con "{".
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const REQUEST_MS = Number(process.env.REQUEST_MS) || 20000;   // cuánto espera una solicitud
// Código de acceso compartido (sin cuentas): si está definido, solo entran dispositivos que lo conozcan.
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';          // detrás de un proxy inverso (NAS): usar X-Forwarded-For
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 24 * 3600 * 1000;   // una sala sin nadie en línea se borra después de esto
const SWEEP_MS = Number(process.env.SWEEP_MS) || 60000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const html = () => fs.readFileSync(path.join(__dirname, 'index.html'));

// ---------- Datos que sobreviven a un reinicio: nombres, conexiones y salas ----------
// names y rooms se indexan con texto que manda el cliente (ids, códigos): por eso son objetos SIN prototipo.
// Con un objeto común, un código como "__proto__" o "constructor" encontraría propiedades heredadas.
const dict = o => Object.assign(Object.create(null), o);
let db = { names: dict(), links: [], rooms: dict() };   // links: ["a|b"], rooms: { CODIGO: { host, members: [dev] } }
try {
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  // Se valida lo leído: un archivo editado a mano o dañado a medias no debe romper el servidor después.
  for (const [d, n] of Object.entries(raw.names || {})) if (typeof n === 'string') db.names[d] = n;
  db.links = (Array.isArray(raw.links) ? raw.links : []).filter(k => typeof k === 'string' && k.split('|').length === 2);
  for (const [code, r] of Object.entries(raw.rooms || {}))
    if (r && typeof r.host === 'string' && Array.isArray(r.members) && r.members.every(m => typeof m === 'string'))
      db.rooms[code] = { host: r.host, members: r.members, seen: Number.isFinite(r.seen) ? r.seen : Date.now() };
} catch {}
// Se guarda en un archivo temporal y se renombra: si el servidor se corta a mitad de la escritura, no queda a medias.
const save = () => {
  try { fs.writeFileSync(DATA + '.tmp', JSON.stringify(db)); fs.renameSync(DATA + '.tmp', DATA); }
  catch (e) { console.error('No pude guardar:', e.message); }
};

const key = (a, b) => [a, b].sort().join('|');
const isLinked = (a, b) => db.links.includes(key(a, b));
// El id de dispositivo (?d=) es SECRETO: quien lo conoce puede hacerse pasar por ese dispositivo. A los demás
// nunca se les muestra; ven un identificador público derivado con un hash, que no permite recuperar el original.
const pub = d => crypto.createHash('sha256').update(d).digest('hex').slice(0, 12);
const nameOf = d => db.names[d] || 'Dispositivo ' + pub(d).slice(0, 4);
// Sin caracteres de control ni de dirección de texto (que podrían disfrazar o desordenar el nombre).
const cleanName = n => String(n == null ? '' : n)
  .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, '').trim().slice(0, 20);

/** Un dispositivo solo puede estar en una conexión a la vez: con una persona O dentro de una sala. */
const busy = dev => db.links.some(k => k.split('|').includes(dev)) ||
                    Object.values(db.rooms).some(r => r.members.includes(dev));

/** Dispositivos con los que `dev` comparte señal: conexiones directas + miembros de sus salas. */
function neighbors(dev) {
  const s = new Set();
  for (const k of db.links) {
    const [a, b] = k.split('|');
    if (a === dev) s.add(b); else if (b === dev) s.add(a);
  }
  for (const r of Object.values(db.rooms))
    if (r.members.includes(dev)) for (const m of r.members) if (m !== dev) s.add(m);
  return s;
}

// ---------- Servidor HTTP + WebSocket ----------
// Archivos estáticos (logo, íconos) desde public/; cualquier otra ruta devuelve la página.
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function staticFile(url) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(url, 'http://x').pathname); } catch { return null; }   // "%" suelto, etc.
  const file = path.join(PUBLIC, pathname);
  const type = TYPES[path.extname(file)];
  // path.join + startsWith evita salir de public/ con rutas tipo "../"
  try {
    if (type && file.startsWith(PUBLIC + path.sep) && fs.statSync(file).isFile()) return { file, type };
  } catch {}
  return null;
}

const server = http.createServer((req, res) => {
  try {
    const s = staticFile(req.url);
    if (s) return res.writeHead(200, { 'Content-Type': s.type, 'Cache-Control': 'public, max-age=3600' }).end(fs.readFileSync(s.file));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html());
  } catch (e) {   // un pedido raro nunca debe tumbar el servidor
    console.error('Error HTTP:', e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// Solo se aceptan WebSockets de la propia página (mismo origen) o de la app, que no manda Origin.
// Sin esto, cualquier sitio web abierto en un navegador de la red podría conectarse al servidor.
const sameOrigin = ({ origin, req }) => {
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
};

const wss = new WebSocketServer({ server, maxPayload: 4096, verifyClient: sameOrigin });
wss.on('error', () => {}); // ws reenvía los errores del server; los maneja server.on('error') más abajo

const open = c => c.readyState === 1;
const socketsOf = dev => [...wss.clients].filter(c => c.dev === dev && open(c));
const onlineDevs = () => new Set([...wss.clients].filter(c => open(c) && c.dev).map(c => c.dev));
/** Dispositivo (id secreto) que corresponde a un identificador público, entre los `pool` dados. */
const devByPub = (h, pool) => { for (const d of pool) if (pub(d) === h) return d; return null; };

// ---------- Límites contra abuso ----------
// Contador por ventana de tiempo: devuelve false cuando se pasó del máximo.
const hits = new Map();   // "tipo:clave" -> [cantidad, vence]
function rate(kind, k, max, ms) {
  const id = kind + ':' + k, now = Date.now();
  let h = hits.get(id);
  if (!h || h[1] <= now) hits.set(id, h = [0, now + ms]);
  return ++h[0] <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h[1] <= now) hits.delete(k); }, 30000).unref();

const clientIp = req => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const sameCode = k => {   // comparación de tiempo constante
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(k), h(ACCESS_CODE));
};
let socketSeq = 0;
const pressing = new Set(); // sockets con el botón apretado (y con permiso para hablar)

// ---------- Turno de palabra ----------
// En cada conexión (o sala) habla una sola persona a la vez. Al soltar, la palabra queda reservada
// FLOOR_MS: nadie más puede tomarla en ese lapso (quien habló último sí puede volver a apretar enseguida,
// si no los puntos y rayas rápidos de un mensaje en Morse serían imposibles).
const FLOOR_MS = Number(process.env.FLOOR_MS) || 500;
const floors = new Map();   // id del grupo -> { holder, last, freeAt }

/** Grupo de señal de un dispositivo: su conexión directa o su sala (solo puede estar en uno). */
function groupOf(dev) {
  for (const k of db.links) { const p = k.split('|'); if (p.includes(dev)) return { id: 'l:' + k, devs: p }; }
  for (const [c, r] of Object.entries(db.rooms)) if (r.members.includes(dev)) return { id: 'r:' + c, devs: r.members };
  return null;
}
function floorInfo(g) {
  const f = g && floors.get(g.id);
  if (!f) return { d: null, last: null, left: 0 };
  return { d: f.holder ? pub(f.holder) : null, last: f.last ? pub(f.last) : null,
           left: f.holder ? 0 : Math.max(0, f.freeAt - Date.now()) };
}
function sendFloor(g) {
  const msg = JSON.stringify({ t: 'floor', ...floorInfo(g) });
  for (const d of g.devs) for (const c of socketsOf(d)) if (!c.svc) c.send(msg);
}
function press(ws) {
  const g = groupOf(ws.dev);
  if (!g) { pressing.add(ws); return notify(); }   // sin conexión: solo se prende la luz propia
  const f = floors.get(g.id) || { holder: null, last: null, freeAt: 0 };
  const mine = f.holder === ws.dev || (!f.holder && (f.last === ws.dev || Date.now() >= f.freeAt));
  if (!mine) return ws.send(JSON.stringify({ t: 'deny', ...floorInfo(g) }));
  f.holder = ws.dev; f.last = ws.dev; floors.set(g.id, f);
  pressing.add(ws);
  notify(); sendFloor(g);
}
function release(ws) {
  pressing.delete(ws);
  const still = [...pressing].some(p => p.dev === ws.dev);
  for (const [id, f] of floors) {
    if (f.holder !== ws.dev || still) continue;
    f.holder = null; f.freeAt = Date.now() + FLOOR_MS;
    const g = groupOf(ws.dev);
    if (g && g.id === id) sendFloor(g);
  }
  notify();
}

// ---------- Señal ----------
// Manda a cada cliente si hay un dispositivo conectado apretando; solo si cambió, para no mandar de más.
function notify() {
  const pressingDevs = new Set([...pressing].map(p => p.dev));
  const byDev = new Map();
  for (const c of wss.clients) {
    if (!byDev.has(c.dev)) {
      const nb = neighbors(c.dev);
      byDev.set(c.dev, [...pressingDevs].some(p => nb.has(p)) ? '1' : '0');
    }
    const v = byDev.get(c.dev);
    if (c.last !== v && open(c)) { c.last = v; c.send(v); }
  }
}

// ---------- Solicitudes (conectar con alguien / unirse a una sala) ----------
const pending = new Map();   // id -> { id, kind: 'link'|'join', from, to, code, ignored, timer }
const newId = () => crypto.randomBytes(6).toString('hex');

function stateFor(dev) {
  const nb = neighbors(dev);
  const reqs = [...pending.values()];
  return {
    t: 'state',
    me: { d: pub(dev), n: nameOf(dev) },
    busy: busy(dev),
    online: [...onlineDevs()].filter(d => d !== dev).map(d => ({ d: pub(d), n: nameOf(d), linked: nb.has(d), busy: busy(d) })),
    links: db.links.map(k => k.split('|')).filter(p => p.includes(dev)).map(p => p.find(d => d !== dev))
      .map(d => ({ d: pub(d), n: nameOf(d), online: onlineDevs().has(d) })),
    rooms: Object.entries(db.rooms).filter(([, r]) => r.members.includes(dev)).map(([code, r]) => ({
      code, host: r.host === dev, hostName: nameOf(r.host),
      members: r.members.map(m => ({ d: pub(m), n: nameOf(m), me: m === dev, online: onlineDevs().has(m) })),
    })),
    floor: floorInfo(groupOf(dev)),
    inbox: reqs.filter(r => r.to === dev && !r.ignored).map(r => ({ id: r.id, kind: r.kind, code: r.code, from: nameOf(r.from) })),
    sent: reqs.filter(r => r.from === dev).map(r => ({
      id: r.id, kind: r.kind, to: pub(r.to), toName: nameOf(r.to), code: r.code, left: Math.max(0, r.until - Date.now()),
    })),
  };
}

function broadcastState() {
  const cache = new Map();
  for (const c of wss.clients) {
    if (c.svc || !open(c)) continue;   // el servicio en segundo plano no necesita el estado completo
    if (!cache.has(c.dev)) cache.set(c.dev, JSON.stringify(stateFor(c.dev)));
    c.send(cache.get(c.dev));
  }
}

const sendDev = (dev, obj, pageOnly) => {
  const msg = JSON.stringify(obj);
  for (const c of socketsOf(dev)) if (!(pageOnly && c.svc)) c.send(msg);
};
const fail = (ws, msg) => ws.send(JSON.stringify({ t: 'ev', k: 'error', msg }));

function resolve(req, outcome) {
  clearTimeout(req.timer);
  pending.delete(req.id);
  if (outcome === 'accepted') {
    if (req.kind === 'link') {
      if (!isLinked(req.from, req.to)) db.links.push(key(req.from, req.to));
    } else if (db.rooms[req.code] && !db.rooms[req.code].members.includes(req.from)) {
      db.rooms[req.code].members.push(req.from);
    }
    save();
  }
  sendDev(req.from, { t: 'ev', k: outcome, kind: req.kind, who: nameOf(req.to), code: req.code }, true);
  broadcastState();
  notify();
}

function createRequest(ws, kind, to, code) {
  const mine = [...pending.values()].filter(r => r.from === ws.dev);
  if (mine.length >= 10) return fail(ws, 'Demasiadas solicitudes pendientes');
  if (!rate('req', ws.dev, 10, 60000)) return fail(ws, 'Demasiadas solicitudes seguidas, esperá un minuto');
  if ([...pending.values()].some(r => r.kind === kind && r.code === code &&
        ((r.from === ws.dev && r.to === to) || (r.from === to && r.to === ws.dev))))
    return fail(ws, 'Ya hay una solicitud pendiente');
  const req = { id: newId(), kind, from: ws.dev, to, code, ignored: false, until: Date.now() + REQUEST_MS };
  req.timer = setTimeout(() => resolve(req, 'expired'), REQUEST_MS);
  pending.set(req.id, req);
  // Los dispositivos con la app cerrada (solo servicio) reciben aviso para mostrar una notificación.
  sendDev(to, { t: 'req', kind, from: nameOf(ws.dev), code }, false);
  broadcastState();
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    if (!db.rooms[c]) return c;
  }
}

function handle(ws, o) {
  const dev = ws.dev;
  switch (o.t) {
    case 'name': {
      const n = cleanName(o.n);
      if (n && db.names[dev] !== n) { db.names[dev] = n; save(); broadcastState(); }
      break;
    }
    case 'link': {
      const to = devByPub(String(o.to), onlineDevs());   // `o.to` es el identificador público, no el id secreto
      if (!to || to === dev) return fail(ws, 'Esa persona no está conectada');
      if (isLinked(dev, to)) return fail(ws, 'Ya están conectados');
      if (busy(dev)) return fail(ws, 'Ya estás conectado: desconectate primero');
      if (busy(to)) return fail(ws, nameOf(to) + ' ya está conectado con alguien');
      createRequest(ws, 'link', to);
      break;
    }
    case 'create': {
      if (busy(dev)) return fail(ws, 'Ya estás conectado: desconectate o salí de tu sala primero');
      if (Object.values(db.rooms).length >= 500) return fail(ws, 'Hay demasiadas salas');
      db.rooms[newCode()] = { host: dev, members: [dev], seen: Date.now() };
      save(); broadcastState();
      break;
    }
    case 'join': {
      const code = String(o.code || '').toUpperCase().trim();
      const room = db.rooms[code];
      if (!room) return fail(ws, 'No existe una sala con ese código');
      if (room.members.includes(dev)) return fail(ws, 'Ya estás en esa sala');
      if (busy(dev)) return fail(ws, 'Ya estás conectado: desconectate o salí de tu sala primero');
      if (!onlineDevs().has(room.host)) return fail(ws, 'El anfitrión de la sala no está conectado');
      createRequest(ws, 'join', room.host, code);
      break;
    }
    case 'answer': case 'ignore': {
      const req = pending.get(String(o.id));
      if (!req || req.to !== dev) return;
      if (o.t === 'ignore') { req.ignored = true; broadcastState(); }   // el otro sigue esperando hasta que venza
      else if (o.ok === true && req.kind === 'join' && !db.rooms[req.code]) {
        resolve(req, 'closed');   // la sala se cerró mientras la solicitud esperaba
      } else if (o.ok === true && (busy(req.from) || (req.kind === 'link' && busy(req.to)))) {
        // Mientras esperaba, alguno de los dos se conectó con otro.
        fail(ws, 'No se pudo: alguno ya está conectado con otro');
        resolve(req, 'busy');
      } else resolve(req, o.ok === true ? 'accepted' : 'rejected');   // "ok" tiene que ser exactamente true
      break;
    }
    case 'unlink': {
      const partners = db.links.map(k => k.split('|')).filter(p => p.includes(dev)).map(p => p.find(d => d !== dev));
      const other = devByPub(String(o.d), partners);
      if (!other) return;
      db.links = db.links.filter(k => k !== key(dev, other));
      save(); broadcastState(); notify();
      break;
    }
    case 'leave': {
      const code = String(o.code);
      const room = db.rooms[code];
      if (!room || !room.members.includes(dev)) return;
      if (room.host === dev) {   // si se va el anfitrión, la sala se cierra
        delete db.rooms[code];
        for (const r of [...pending.values()]) if (r.kind === 'join' && r.code === code) resolve(r, 'closed');
      } else room.members = room.members.filter(m => m !== dev);
      save(); broadcastState(); notify();
      break;
    }
  }
}

// Latido: un celu que se durmió o perdió el wifi no avisa que se fue; sin esto su botón quedaría
// "apretado" para siempre y la luz de los demás no se apagaría.
setInterval(() => {
  for (const c of wss.clients) {
    if (c.alive === false) { c.terminate(); continue; } // dispara 'close' y lo saca de pressing
    c.alive = false;
    c.ping();
  }
}, 10000).unref();

// Una sala en la que no hay nadie en línea durante ROOM_TTL_MS se borra (y con ella, su código).
setInterval(() => {
  const online = onlineDevs(), now = Date.now();
  let changed = false;
  for (const [code, r] of Object.entries(db.rooms)) {
    if (r.members.some(m => online.has(m))) { r.seen = now; continue; }
    if (now - (r.seen || now) < ROOM_TTL_MS) continue;
    delete db.rooms[code];
    for (const q of [...pending.values()]) if (q.kind === 'join' && q.code === code) resolve(q, 'closed');
    changed = true;
  }
  for (const [id, f] of floors) if (!f.holder && now - f.freeAt > 60000) floors.delete(id);   // turnos viejos
  if (changed) { save(); broadcastState(); notify(); }
}, SWEEP_MS).unref();

// Cierres con código propio: la página y la app los distinguen de una caída del servidor.
const CLOSE_NEED_CODE = 4001, CLOSE_BLOCKED = 4029, CLOSE_BUSY = 4008;

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const ip = clientIp(req);
  ws.dev = null;   // hasta que se acepte la conexión no cuenta como dispositivo
  ws.on('error', () => {});
  if (!rate('conn', ip, 120, 60000)) return ws.close(CLOSE_BLOCKED, 'demasiadas conexiones');

  if (ACCESS_CODE) {
    const k = q.get('k');
    // Después de 5 códigos incorrectos seguidos desde la misma dirección, se bloquea un minuto (contra adivinar).
    const f = hits.get('fail:' + ip);
    if (f && f[1] > Date.now() && f[0] >= 5) return ws.close(CLOSE_BLOCKED, 'demasiados intentos');
    if (k === null || k === '') return ws.close(CLOSE_NEED_CODE, 'falta el código');
    if (!sameCode(k)) { rate('fail', ip, 5, 60000); return ws.close(CLOSE_NEED_CODE, 'código incorrecto'); }
  }

  const d = q.get('d');
  ws.dev = d && /^[\w-]{1,64}$/.test(d) ? d : crypto.randomBytes(16).toString('hex');
  if (socketsOf(ws.dev).length >= 8) { ws.dev = null; return ws.close(CLOSE_BUSY, 'demasiadas conexiones de este dispositivo'); }
  ws.id = ++socketSeq;
  ws.svc = q.get('s') === '1';   // servicio en segundo plano de la app
  ws.last = null;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    try {
      const m = String(raw);
      if (m === '1' || m === '0') {
        if (!rate('sig', ws.id, 100, 5000)) return;   // un humano no aprieta más de ~20 veces por segundo
        if (m === '1') press(ws); else release(ws);
      } else if (m[0] === '{') {
        if (!rate('ctl', ws.id, 40, 10000)) return fail(ws, 'Más despacio');
        let o;
        try { o = JSON.parse(m); } catch { return; }
        if (o && typeof o === 'object' && typeof o.t === 'string') handle(ws, o);
      }
    } catch (e) {   // un mensaje raro nunca debe tumbar el servidor ni a los demás
      console.error('Error al procesar un mensaje:', e);
    }
  });
  ws.on('close', () => {
    release(ws);   // si tenía la palabra, la suelta (con la misma espera de siempre)
    if (!socketsOf(ws.dev).length) {   // el dispositivo se fue del todo (ni página ni servicio)
      for (const r of [...pending.values()]) {
        if (r.from === ws.dev) { clearTimeout(r.timer); pending.delete(r.id); }   // su solicitud ya no tiene sentido
        else if (r.to === ws.dev) resolve(r, 'offline');                          // avisarle ya a quien esperaba
      }
    }
    broadcastState();
    notify();
  });
  broadcastState();   // aparece en la lista de conectados de los demás
  notify();
});

// Si el puerto está ocupado por otro proceso de Node (el servidor anterior), lo cierra y reintenta.
function freePort(cb) {
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32'
    ? `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { $p = Get-Process -Id $_.OwningProcess; if ($p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force; 'ok' } }"`
    : `lsof -ti tcp:${PORT} -sTCP:LISTEN | xargs -r kill`;
  exec(cmd, (err, out) => cb(!err && (process.platform !== 'win32' || out.includes('ok'))));
}

let retried = false;
server.on('error', err => {
  if (err.code !== 'EADDRINUSE' || retried) throw err;
  retried = true;
  console.log(`Puerto ${PORT} ocupado, cerrando el servidor anterior...`);
  freePort(ok => {
    if (!ok) { console.log(`No pude liberar el puerto ${PORT}: lo usa otro programa que no es Node.`); process.exit(1); }
    setTimeout(start, 500);
  });
});

function start() { server.listen(PORT, '0.0.0.0', onListen); }
start();

function onListen() {
  console.log(ACCESS_CODE ? 'Código de acceso: activado (cada dispositivo lo escribe una vez).'
    : 'Sin código de acceso: cualquiera que llegue al servidor puede entrar. Definí ACCESS_CODE para protegerlo.');
  console.log('Abrí en cualquier dispositivo de la red:');
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list)
      if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${PORT}`);
  console.log(`  http://localhost:${PORT}`);
}
