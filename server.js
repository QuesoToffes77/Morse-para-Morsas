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
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const REQUEST_MS = Number(process.env.REQUEST_MS) || 20000;   // cuánto espera una solicitud
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const html = () => fs.readFileSync(path.join(__dirname, 'index.html'));

// ---------- Datos que sobreviven a un reinicio: nombres, conexiones y salas ----------
let db = { names: {}, links: [], rooms: {} };   // links: ["a|b"], rooms: { CODIGO: { host, members: [dev] } }
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch {}
const save = () => { try { fs.writeFileSync(DATA, JSON.stringify(db)); } catch (e) { console.error('No pude guardar:', e.message); } };

const key = (a, b) => [a, b].sort().join('|');
const isLinked = (a, b) => db.links.includes(key(a, b));
const nameOf = d => db.names[d] || 'Dispositivo ' + d.slice(0, 4);

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

const server = http.createServer((req, res) => {
  const file = path.join(PUBLIC, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const type = TYPES[path.extname(file)];
  // path.join + startsWith evita salir de public/ con rutas tipo "../"
  if (type && file.startsWith(PUBLIC + path.sep) && fs.existsSync(file)) {
    return res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' }).end(fs.readFileSync(file));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html());
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('error', () => {}); // ws reenvía los errores del server; los maneja server.on('error') más abajo

const open = c => c.readyState === 1;
const socketsOf = dev => [...wss.clients].filter(c => c.dev === dev && open(c));
const onlineDevs = () => new Set([...wss.clients].filter(open).map(c => c.dev));
const pressing = new Set(); // sockets con el botón apretado

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
const newId = () => Math.random().toString(36).slice(2, 10);

function stateFor(dev) {
  const nb = neighbors(dev);
  const reqs = [...pending.values()];
  return {
    t: 'state',
    me: { d: dev, n: nameOf(dev) },
    busy: busy(dev),
    online: [...onlineDevs()].filter(d => d !== dev).map(d => ({ d, n: nameOf(d), linked: nb.has(d), busy: busy(d) })),
    links: db.links.map(k => k.split('|')).filter(p => p.includes(dev)).map(p => p.find(d => d !== dev))
      .map(d => ({ d, n: nameOf(d), online: onlineDevs().has(d) })),
    rooms: Object.entries(db.rooms).filter(([, r]) => r.members.includes(dev)).map(([code, r]) => ({
      code, host: r.host === dev, hostName: nameOf(r.host),
      members: r.members.map(m => ({ n: nameOf(m), me: m === dev, online: onlineDevs().has(m) })),
    })),
    inbox: reqs.filter(r => r.to === dev && !r.ignored).map(r => ({ id: r.id, kind: r.kind, code: r.code, from: nameOf(r.from) })),
    sent: reqs.filter(r => r.from === dev).map(r => ({
      id: r.id, kind: r.kind, to: r.to, toName: nameOf(r.to), code: r.code, left: Math.max(0, r.until - Date.now()),
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
      const n = String(o.n || '').trim().slice(0, 20);
      if (n && db.names[dev] !== n) { db.names[dev] = n; save(); broadcastState(); }
      break;
    }
    case 'link': {
      const to = String(o.to);
      if (to === dev || !onlineDevs().has(to)) return fail(ws, 'Esa persona no está conectada');
      if (isLinked(dev, to)) return fail(ws, 'Ya están conectados');
      if (busy(dev)) return fail(ws, 'Ya estás conectado: desconectate primero');
      if (busy(to)) return fail(ws, nameOf(to) + ' ya está conectado con alguien');
      createRequest(ws, 'link', to);
      break;
    }
    case 'create': {
      if (busy(dev)) return fail(ws, 'Ya estás conectado: desconectate o salí de tu sala primero');
      db.rooms[newCode()] = { host: dev, members: [dev] };
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
      else if (o.ok && (busy(req.from) || (req.kind === 'link' && busy(req.to)))) {
        // Mientras esperaba, alguno de los dos se conectó con otro.
        fail(ws, 'No se pudo: alguno ya está conectado con otro');
        resolve(req, 'busy');
      } else resolve(req, o.ok ? 'accepted' : 'rejected');
      break;
    }
    case 'unlink': {
      db.links = db.links.filter(k => k !== key(dev, String(o.d)));
      save(); broadcastState(); notify();
      break;
    }
    case 'leave': {
      const code = String(o.code);
      const room = db.rooms[code];
      if (!room || !room.members.includes(dev)) return;
      if (room.host === dev) delete db.rooms[code];   // si se va el anfitrión, la sala se cierra
      else room.members = room.members.filter(m => m !== dev);
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

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const d = q.get('d');
  ws.dev = d && /^[\w-]{1,32}$/.test(d) ? d : Math.random().toString(36).slice(2);
  ws.svc = q.get('s') === '1';   // servicio en segundo plano de la app
  ws.last = null;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    const m = String(raw);
    if (m === '1') { pressing.add(ws); notify(); }
    else if (m === '0') { pressing.delete(ws); notify(); }
    else if (m[0] === '{') {
      let o;
      try { o = JSON.parse(m); } catch { return; }
      if (o && typeof o === 'object') handle(ws, o);
    }
  });
  ws.on('close', () => {
    pressing.delete(ws);
    if (!socketsOf(ws.dev).length)   // se fue del todo: sus solicitudes salientes ya no tienen sentido
      for (const r of [...pending.values()])
        if (r.from === ws.dev) { clearTimeout(r.timer); pending.delete(r.id); }
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
  console.log('Abrí en cualquier dispositivo de la red:');
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list)
      if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${PORT}`);
  console.log(`  http://localhost:${PORT}`);
}
