// Tests del servidor. Se corren con:  npm test   (usa el runner integrado de Node, sin dependencias extra)
//
// Cada test levanta su propio servidor en un puerto al azar, con un data.json temporal, y lo cierra al terminar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms = 2500, what = 'la condición') {
  const t = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('Se agotó el tiempo esperando ' + what);
    await sleep(15);
  }
}

/** Un dispositivo (página o servicio) conectado al servidor. */
class Client {
  constructor(srv, dev, { name, svc = false, origin } = {}) {
    this.dev = dev;
    this.signals = [];   // "1"/"0" recibidos
    this.events = [];    // {t:'ev'} (aceptada, rechazada, error...)
    this.reqs = [];      // {t:'req'} (aviso de solicitud entrante)
    this.st = null;      // último {t:'state'}
    this.closed = false;
    this.ws = new WebSocket(`ws://127.0.0.1:${srv.port}/?d=${dev}${svc ? '&s=1' : ''}`, origin ? { origin } : {});
    this.ws.on('message', m => {
      m = String(m);
      if (m[0] !== '{') return this.signals.push(m);
      const o = JSON.parse(m);
      if (o.t === 'state') this.st = o; else if (o.t === 'ev') this.events.push(o); else if (o.t === 'req') this.reqs.push(o);
    });
    this.ws.on('close', () => { this.closed = true; });
    this.ws.on('error', e => { this.error = e; });
    this.opened = new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    if (name) this.opened.then(() => this.tx({ t: 'name', n: name })).catch(() => {});
    srv.clients.push(this);
  }
  tx(o) { this.ws.send(JSON.stringify(o)); }
  press() { this.ws.send('1'); }
  release() { this.ws.send('0'); }
  get last() { return this.signals[this.signals.length - 1]; }
  async ready() {
    await this.opened;
    if (!this.svc) await waitFor(() => this.st || this.isSvc, 2500, 'el estado inicial');
    return this;
  }
  close() { this.ws.close(); return waitFor(() => this.closed, 2500, 'el cierre'); }
  event(k) { return this.events.find(e => e.k === k); }
}

async function startServer({ dir, port, requestMs = 500 } = {}) {
  dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'morse-test-'));
  port = port || 41000 + Math.floor(Math.random() * 8000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_FILE: path.join(dir, 'data.json'), REQUEST_MS: String(requestMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  await waitFor(() => out.includes('localhost:') || child.exitCode !== null, 6000, 'el arranque del servidor');
  const srv = {
    port, dir, child, clients: [],
    log: () => out,
    alive: () => child.exitCode === null,
    client(dev, opts) { const c = new Client(srv, dev, opts); c.isSvc = !!(opts && opts.svc); return c; },
    async stop(keepDir) {
      for (const c of srv.clients) try { c.ws.terminate(); } catch {}
      child.kill();
      await new Promise(r => (child.exitCode !== null ? r() : child.once('exit', r)));
      if (!keepDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return srv;
}

const withServer = (fn, opts) => async () => {
  const srv = await startServer(opts);
  try { await fn(srv); } finally { await srv.stop(); }
};

/** a pide conectarse con b y b acepta. */
async function link(a, b) {
  a.tx({ t: 'link', to: b.dev });
  await waitFor(() => b.st.inbox.length, 2500, 'la solicitud en la bandeja');
  b.tx({ t: 'answer', id: b.st.inbox[0].id, ok: true });
  await waitFor(() => a.st.links.length && b.st.links.length, 2500, 'la conexión');
}

const httpGet = (srv, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: srv.port, path: p }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

// ---------------------------------------------------------------- señal

test('sin conexión no llega ninguna señal', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  a.press(); await sleep(150); a.release(); await sleep(100);
  assert.ok(!b.signals.includes('1'));
}));

test('entre dispositivos conectados la señal llega, y nunca a uno mismo', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  const aSvc = srv.client('aaaa', { svc: true }); await aSvc.opened;   // servicio en segundo plano del mismo celu
  await link(a, b);
  a.press();
  await waitFor(() => b.last === '1', 2500, 'que B reciba 1');
  a.release();
  await waitFor(() => b.last === '0', 2500, 'que B reciba 0');
  await sleep(100);
  assert.ok(!a.signals.includes('1'), 'A no debe recibir su propio toque');
  assert.ok(!aSvc.signals.includes('1'), 'el servicio de A tampoco');
}));

test('un tercero sin conexión no recibe la señal', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready(), c = await srv.client('cccc').ready();
  await link(a, b);
  a.press(); await waitFor(() => b.last === '1'); await sleep(100);
  assert.ok(!c.signals.includes('1'));
}));

test('si A está con B y B con C, A y C no se ven (no hay transitividad)', withServer(async srv => {
  // Una sola conexión a la vez: B no puede estar con A y con C. Se verifica que ni siquiera lo permite.
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready(), c = await srv.client('cccc').ready();
  await link(a, b);
  c.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => c.event('error'), 2500, 'el error de C');
  assert.match(c.event('error').msg, /ya está conectado/);
}));

// ---------------------------------------------------------------- solicitudes

test('aceptar crea la conexión en los dos lados y avisa a quien la mandó', withServer(async srv => {
  const a = await srv.client('aaaa', { name: 'Ana' }).ready(), b = await srv.client('bbbb', { name: 'Beto' }).ready();
  await waitFor(() => a.st.online.some(o => o.n === 'Beto'), 2500, 'que A vea a Beto');
  a.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => b.st.inbox.length === 1 && a.st.sent.length === 1);
  assert.equal(b.st.inbox[0].from, 'Ana');
  assert.equal(a.st.sent[0].toName, 'Beto');
  b.tx({ t: 'answer', id: b.st.inbox[0].id, ok: true });
  await waitFor(() => a.event('accepted'));
  assert.equal(a.st.links[0].n, 'Beto');
  assert.equal(b.st.links[0].n, 'Ana');
  assert.equal(a.st.sent.length + b.st.inbox.length, 0);
}));

test('rechazar no conecta y avisa', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  a.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => b.st.inbox.length);
  b.tx({ t: 'answer', id: b.st.inbox[0].id, ok: false });
  await waitFor(() => a.event('rejected'));
  assert.equal(a.st.links.length, 0);
  assert.equal(b.st.links.length, 0);
}));

test('ignorar la saca de la bandeja, y a quien la mandó le vence', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  a.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => b.st.inbox.length);
  b.tx({ t: 'ignore', id: b.st.inbox[0].id });
  await waitFor(() => b.st.inbox.length === 0);
  assert.equal(a.st.sent.length, 1, 'para A sigue pendiente');
  await waitFor(() => a.event('expired'), 3000, 'que venza');
  assert.equal(a.st.sent.length, 0);
}));

test('sin respuesta, la solicitud vence', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  a.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => a.event('expired'), 3000);
  await waitFor(() => b.st.inbox.length === 0);
}));

test('no se puede mandar dos solicitudes iguales ni a uno mismo ni a alguien desconectado', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  a.tx({ t: 'link', to: 'bbbb' }); a.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => a.event('error'));
  assert.match(a.event('error').msg, /pendiente/);
  a.tx({ t: 'link', to: 'aaaa' }); a.tx({ t: 'link', to: 'nadie' });
  await waitFor(() => a.events.filter(e => e.k === 'error').length === 3);
  assert.equal(a.st.sent.length, 1);
}));

test('solo el destinatario puede responder', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready(), c = await srv.client('cccc').ready();
  a.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => b.st.inbox.length);
  c.tx({ t: 'answer', id: b.st.inbox[0].id, ok: true });
  a.tx({ t: 'answer', id: b.st.inbox[0].id, ok: true });
  await sleep(150);
  assert.equal(a.st.links.length, 0);
  assert.equal(b.st.inbox.length, 1);
}));

test('"ok" solo cuenta si es el booleano true', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  a.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => b.st.inbox.length);
  b.tx({ t: 'answer', id: b.st.inbox[0].id, ok: 'false' });   // texto, no booleano
  await waitFor(() => a.event('rejected') || a.event('accepted'));
  assert.ok(a.event('rejected'), 'debe tratarse como rechazo');
  assert.equal(a.st.links.length, 0);
}));

// ---------------------------------------------------------------- una conexión a la vez

test('con una conexión activa no se puede conectar, crear sala ni unirse a otra', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready(), c = await srv.client('cccc').ready();
  const d = await srv.client('dddd').ready();
  d.tx({ t: 'create' }); await waitFor(() => d.st.rooms.length);
  const code = d.st.rooms[0].code;
  await link(a, b);
  a.tx({ t: 'link', to: 'cccc' });   // A ocupada
  c.tx({ t: 'link', to: 'bbbb' });   // B ocupada
  a.tx({ t: 'create' });             // A ocupada
  a.tx({ t: 'join', code });         // A ocupada
  await waitFor(() => a.events.filter(e => e.k === 'error').length === 3 && c.event('error'));
  assert.equal(a.st.rooms.length, 0);
  assert.equal(a.st.sent.length, 0);
}));

test('si alguien se ocupa mientras la solicitud espera, al aceptar se cancela', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready(), c = await srv.client('cccc').ready();
  a.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => b.st.inbox.length);
  b.tx({ t: 'create' });   // B arma una sala: ahora está ocupada
  await waitFor(() => b.st.rooms.length);
  b.tx({ t: 'answer', id: b.st.inbox[0].id, ok: true });
  await waitFor(() => a.event('busy'));
  assert.equal(a.st.links.length, 0);
  assert.match(b.event('error').msg, /ya está conectado/);
}));

// ---------------------------------------------------------------- salas

test('sala: se crea, se une quien el anfitrión acepta y comparten señal', withServer(async srv => {
  const host = await srv.client('hhhh', { name: 'Hugo' }).ready(), m1 = await srv.client('mmm1', { name: 'Mia' }).ready();
  const m2 = await srv.client('mmm2').ready(), out = await srv.client('oooo').ready();
  host.tx({ t: 'create' });
  await waitFor(() => host.st.rooms.length);
  const code = host.st.rooms[0].code;
  assert.match(code, /^[A-Z2-9]{4}$/);
  assert.ok(host.st.rooms[0].host);
  for (const m of [m1, m2]) {
    m.tx({ t: 'join', code: code.toLowerCase() });   // el código no distingue mayúsculas
    await waitFor(() => host.st.inbox.some(r => r.kind === 'join' && r.code === code));
    host.tx({ t: 'answer', id: host.st.inbox[0].id, ok: true });
    await waitFor(() => m.st.rooms.length);
  }
  assert.deepEqual(host.st.rooms[0].members.map(x => x.n).sort(), ['Hugo', 'Mia', 'Dispositivo mmm2'].sort());
  m1.press();
  await waitFor(() => host.last === '1' && m2.last === '1');
  await sleep(100);
  assert.ok(!out.signals.includes('1'), 'quien no está en la sala no recibe');
  assert.ok(!m1.signals.includes('1'));
}));

test('sala: rechazar, código inexistente, y salir', withServer(async srv => {
  const host = await srv.client('hhhh').ready(), m = await srv.client('mmmm').ready();
  host.tx({ t: 'create' });
  await waitFor(() => host.st.rooms.length);
  const code = host.st.rooms[0].code;
  m.tx({ t: 'join', code: 'ZZZZ' });
  await waitFor(() => m.event('error'));
  assert.match(m.event('error').msg, /No existe/);
  m.tx({ t: 'join', code });
  await waitFor(() => host.st.inbox.length);
  host.tx({ t: 'answer', id: host.st.inbox[0].id, ok: false });
  await waitFor(() => m.event('rejected'));
  assert.equal(m.st.rooms.length, 0);
  // ahora sí entra, y sale
  m.tx({ t: 'join', code });
  await waitFor(() => host.st.inbox.length);
  host.tx({ t: 'answer', id: host.st.inbox[0].id, ok: true });
  await waitFor(() => m.st.rooms.length);
  m.tx({ t: 'leave', code });
  await waitFor(() => m.st.rooms.length === 0 && host.st.rooms[0].members.length === 1);
  host.press(); await sleep(150);
  assert.ok(!m.signals.includes('1'), 'ya salió: no recibe');
}));

test('sala: si el anfitrión la cierra, se disuelve para todos', withServer(async srv => {
  const host = await srv.client('hhhh').ready(), m = await srv.client('mmmm').ready();
  host.tx({ t: 'create' });
  await waitFor(() => host.st.rooms.length);
  const code = host.st.rooms[0].code;
  m.tx({ t: 'join', code });
  await waitFor(() => host.st.inbox.length);
  host.tx({ t: 'answer', id: host.st.inbox[0].id, ok: true });
  await waitFor(() => m.st.rooms.length);
  host.tx({ t: 'leave', code });
  await waitFor(() => m.st.rooms.length === 0 && host.st.rooms.length === 0);
  assert.equal(m.st.busy, false, 'queda libre para conectarse con otro');
}));

test('sala: una solicitud de ingreso pendiente no se "acepta" si la sala ya se cerró', withServer(async srv => {
  const host = await srv.client('hhhh').ready(), m = await srv.client('mmmm').ready();
  host.tx({ t: 'create' });
  await waitFor(() => host.st.rooms.length);
  const code = host.st.rooms[0].code;
  m.tx({ t: 'join', code });
  await waitFor(() => host.st.inbox.length);
  const id = host.st.inbox[0].id;
  host.tx({ t: 'leave', code });                       // el anfitrión cierra la sala con la solicitud pendiente
  await waitFor(() => host.st.rooms.length === 0);
  host.tx({ t: 'answer', id, ok: true });              // y (por una carrera) igual intenta aceptar
  await sleep(200);
  assert.equal(m.event('accepted'), undefined, 'no puede decirle "aceptado" por una sala que no existe');
  assert.equal(m.st.rooms.length, 0);
  assert.equal(m.st.busy, false);
}));

// ---------------------------------------------------------------- desconexiones

test('si uno se desconecta con el botón apretado, a los demás se les apaga la luz', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  await link(a, b);
  a.press();
  await waitFor(() => b.last === '1');
  await a.close();                                     // se corta el wifi, se cierra la app, etc.
  await waitFor(() => b.last === '0', 2500, 'que se apague la luz de B');
}));

test('si se desconecta tu pareja, la conexión se conserva y se marca "sin conexión"; al volver, anda', withServer(async srv => {
  const a = await srv.client('aaaa', { name: 'Ana' }).ready(), b = await srv.client('bbbb').ready();
  await link(a, b);
  await a.close();
  await waitFor(() => b.st.links[0] && b.st.links[0].online === false, 2500, 'que B vea a Ana sin conexión');
  assert.equal(b.st.online.length, 0, 'ya no está en la lista de conectados');
  assert.equal(b.st.busy, true, 'B sigue conectado con ella');
  const a2 = await srv.client('aaaa').ready();
  await waitFor(() => b.st.links[0].online === true);
  a2.press();
  await waitFor(() => b.last === '1');
}));

test('con la app cerrada (solo el servicio), el dispositivo sigue en línea y recibe la señal', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb', { name: 'Beto' }).ready();
  const bSvc = srv.client('bbbb', { svc: true }); await bSvc.opened;
  await link(a, b);
  await b.close();                                     // se cierra la pantalla, queda el servicio
  await sleep(150);
  assert.equal(a.st.links[0].online, true);
  a.press();
  await waitFor(() => bSvc.last === '1', 2500, 'que el servicio reciba la señal');
}));

test('si quien mandó la solicitud se desconecta, desaparece de la bandeja del otro', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  a.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => b.st.inbox.length === 1);
  await a.close();
  await waitFor(() => b.st.inbox.length === 0, 2500, 'que se limpie la bandeja');
}));

test('si el destinatario se desconecta, quien esperaba se entera enseguida', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb', { name: 'Beto' }).ready();
  a.tx({ t: 'link', to: 'bbbb' });
  await waitFor(() => b.st.inbox.length === 1);
  await b.close();
  await waitFor(() => a.event('offline'), 400, 'el aviso de desconexión (antes de que venza)');
  assert.equal(a.st.sent.length, 0);
}), { requestMs: 5000 });

test('si el anfitrión se desconecta, la sala sigue pero nadie puede pedir entrar', withServer(async srv => {
  const host = await srv.client('hhhh').ready(), m = await srv.client('mmmm').ready(), x = await srv.client('xxxx').ready();
  host.tx({ t: 'create' });
  await waitFor(() => host.st.rooms.length);
  const code = host.st.rooms[0].code;
  m.tx({ t: 'join', code });
  await waitFor(() => host.st.inbox.length);
  host.tx({ t: 'answer', id: host.st.inbox[0].id, ok: true });
  await waitFor(() => m.st.rooms.length);
  await host.close();
  await waitFor(() => m.st.rooms[0].members.some(u => !u.online));
  x.tx({ t: 'join', code });
  await waitFor(() => x.event('error'));
  assert.match(x.event('error').msg, /anfitri/);
  const host2 = await srv.client('hhhh').ready();      // vuelve y todo sigue
  assert.equal(host2.st.rooms.length, 1);
  host2.press();
  await waitFor(() => m.last === '1');
}));

test('una persona con la app abierta en dos lugares (mismo id) se cuenta como un solo dispositivo', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), a2 = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  await waitFor(() => b.st.online.length === 1);
  await a.close();
  assert.equal(b.st.online.length, 1, 'sigue en línea por la otra conexión');
}));

test('las conexiones y salas sobreviven a un reinicio del servidor', async () => {
  const first = await startServer({ requestMs: 500 });
  const { dir, port } = first;
  const a = await first.client('aaaa', { name: 'Ana' }).ready(), b = await first.client('bbbb', { name: 'Beto' }).ready();
  await link(a, b);
  const c = await first.client('cccc', { name: 'Carla' }).ready();
  c.tx({ t: 'create' });
  await waitFor(() => c.st.rooms.length);
  const code = c.st.rooms[0].code;
  await sleep(100);
  await first.stop(true);
  const second = await startServer({ dir, port, requestMs: 500 });
  try {
    const a2 = await second.client('aaaa').ready(), c2 = await second.client('cccc').ready();
    assert.equal(a2.st.links.length, 1);
    assert.equal(a2.st.links[0].n, 'Beto');
    assert.equal(c2.st.rooms[0].code, code);
  } finally { await second.stop(); }
});

test('un data.json dañado no impide arrancar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morse-test-'));
  fs.writeFileSync(path.join(dir, 'data.json'), '{esto no es json');
  const srv = await startServer({ dir });
  try {
    const a = await srv.client('aaaa').ready();
    assert.equal(a.st.links.length, 0);
  } finally { await srv.stop(); }
});

// ---------------------------------------------------------------- robustez ante entradas raras o maliciosas

test('mensajes basura o con tipos raros no tumban el servidor', withServer(async srv => {
  const a = await srv.client('aaaa').ready();
  const garbage = [
    '{', '{"t":', '[]', 'null', 'basura', '', '{}', '{"t":"zzz"}', '{"t":null}',
    '{"t":"link","to":{}}', '{"t":"link","to":null}', '{"t":"join","code":["x"]}', '{"t":"join"}',
    '{"t":"leave","code":"__proto__"}', '{"t":"leave","code":"constructor"}', '{"t":"leave","code":"toString"}',
    '{"t":"join","code":"constructor"}', '{"t":"unlink","d":"__proto__"}', '{"t":"answer","id":1,"ok":true}',
    '{"t":"answer"}', '{"t":"ignore","id":{}}', '{"t":"name","n":{"a":1}}', '{"t":"name","n":null}',
  ];
  for (const m of garbage) a.ws.send(m);
  await sleep(300);
  assert.ok(srv.alive(), 'el servidor se cayó:\n' + srv.log());
  const b = await srv.client('bbbb').ready();          // y sigue atendiendo
  assert.equal(b.st.online.length, 1);
}));

test('un mensaje enorme cierra esa conexión pero no tumba el servidor', withServer(async srv => {
  const a = await srv.client('aaaa').ready();
  a.ws.send('{"t":"name","n":"' + 'x'.repeat(6000) + '"}');
  await waitFor(() => a.closed, 2500, 'que se cierre la conexión abusiva');
  await sleep(100);
  assert.ok(srv.alive(), 'el servidor se cayó:\n' + srv.log());
  const b = await srv.client('bbbb').ready();
  assert.ok(b.st);
}));

test('ids de dispositivo raros no rompen nada', withServer(async srv => {
  const weird = srv.client('__proto__'); await weird.ready();
  const odd = srv.client('con%20espacio'); await odd.opened;     // inválido: el servidor le asigna otro
  const b = await srv.client('bbbb').ready();
  await waitFor(() => b.st.online.length >= 1);
  for (const o of b.st.online) assert.equal(typeof o.n, 'string', 'el nombre debe ser texto: ' + JSON.stringify(o));
  b.tx({ t: 'link', to: '__proto__' });
  await waitFor(() => weird.st.inbox.length === 1);
  assert.equal(typeof weird.st.inbox[0].from, 'string');
  assert.ok(srv.alive());
}));

test('los nombres se limpian: largo máximo y sin caracteres de control', withServer(async srv => {
  const a = await srv.client('aaaa').ready(), b = await srv.client('bbbb').ready();
  a.tx({ t: 'name', n: '  Ana\n‮\u0007' + 'z'.repeat(40) });
  await waitFor(() => b.st.online.length && b.st.online[0].n.startsWith('Ana'));
  const n = b.st.online[0].n;
  assert.ok(n.length <= 20, 'largo ' + n.length);
  assert.ok(!/[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(n), JSON.stringify(n));
}));

test('un sitio web cualquiera no puede abrir un WebSocket contra el servidor (origen distinto)', withServer(async srv => {
  const evil = srv.client('evil', { origin: 'http://sitio-malicioso.example' });
  await assert.rejects(evil.opened, /403|Unexpected server response/);
  const same = srv.client('okok', { origin: `http://127.0.0.1:${srv.port}` });   // la propia página
  await same.opened;
  const native = srv.client('app1');                                            // la app (OkHttp) no manda Origin
  await native.opened;
}));

// ---------------------------------------------------------------- HTTP

test('la página y el logo se sirven bien', withServer(async srv => {
  const page = await httpGet(srv, '/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body.toString(), /<title>Morse<\/title>/);
  for (const f of ['/logo.png', '/icon-192.png', '/favicon-32.png', '/favicon-64.png']) {
    const r = await httpGet(srv, f);
    assert.equal(r.status, 200, f);
    assert.equal(r.type, 'image/png', f);
    assert.equal(r.body.subarray(1, 4).toString(), 'PNG', f);
  }
}));

test('rutas raras no tumban el servidor ni filtran archivos', withServer(async srv => {
  const secret = fs.readFileSync(path.join(ROOT, 'server.js'));
  for (const p of ['/%', '/%E0%A4%A', '/..%2fserver.js', '/..%2f..%2fserver.js', '/%2e%2e/server.js', '/..\\server.js',
                   '/public/../server.js', '/nada.png', '/logo.png/', '//logo.png', '/?x=%']) {
    const r = await httpGet(srv, p);
    assert.equal(r.status, 200, p);
    assert.notDeepEqual(r.body, secret, 'filtró server.js con ' + p);
  }
  assert.ok(srv.alive(), 'el servidor se cayó:\n' + srv.log());
}));

// ---------------------------------------------------------------- la página

test('el JavaScript de la página no tiene errores de sintaxis', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script));
});
