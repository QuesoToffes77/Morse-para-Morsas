// Servidor: sirve la página y retransmite por WebSocket. Cliente->servidor: "1"/"0" (apretado/suelto).
// Servidor->cliente: "1"/"0" = ¿hay OTRO dispositivo apretando?
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const html = () => fs.readFileSync(path.join(__dirname, 'index.html'));

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html());
});

const wss = new WebSocketServer({ server });
wss.on('error', () => {}); // ws reenvía los errores del server; los maneja server.on('error') más abajo
const pressing = new Set(); // sockets con el botón apretado

// Manda a cada cliente si hay otro apretando; solo si cambió, para no mandar de más.
// "Otro" = un dispositivo distinto: la página y el servicio de la app de un mismo celu comparten
// identificador (?d=), así que su propio toque no los hace vibrar.
function notify() {
  const devs = new Map(); // dispositivo -> cuántos sockets suyos están apretando
  for (const p of pressing) devs.set(p.dev, (devs.get(p.dev) || 0) + 1);
  for (const c of wss.clients) {
    const others = devs.size - (devs.has(c.dev) ? 1 : 0) > 0 ? '1' : '0';
    if (c.last !== others && c.readyState === 1) { c.last = others; c.send(others); }
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
  ws.dev = new URL(req.url, 'http://x').searchParams.get('d') || Math.random().toString(36);
  ws.last = null;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', m => {
    if (String(m) === '1') pressing.add(ws); else pressing.delete(ws);
    notify();
  });
  ws.on('close', () => { pressing.delete(ws); notify(); });
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
