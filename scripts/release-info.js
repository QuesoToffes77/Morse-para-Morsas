// Genera latest.json, el archivo que la app de Android consulta en GitHub para saber si hay una versión nueva.
//
// Uso (después de compilar y copiar el APK a Senal.apk):
//   npm run release-info                         # sin notas
//   npm run release-info -- "Qué cambió"         # con notas, que se muestran en la ventana de actualización
//
// Lee versionCode y versionName de android-app/app/build.gradle y calcula el tamaño y el SHA-256 de Senal.apk.
// Si volvés a compilar el APK, hay que volver a correr esto: el hash cambia con cada compilación.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const GRADLE = process.env.GRADLE_FILE || path.join(ROOT, 'android-app', 'app', 'build.gradle');
const APK = process.env.APK_FILE || path.join(ROOT, 'Senal.apk');
const OUT = process.env.OUT_FILE || path.join(ROOT, 'latest.json');

function fail(msg) { console.error('Error: ' + msg); process.exit(1); }

const gradle = fs.existsSync(GRADLE) ? fs.readFileSync(GRADLE, 'utf8') : fail('no encuentro ' + GRADLE);
const code = /versionCode\s+(\d+)/.exec(gradle);
const name = /versionName\s+["']([^"']+)["']/.exec(gradle);
if (!code || !name) fail('no pude leer versionCode / versionName de build.gradle');
if (!fs.existsSync(APK)) fail('no encuentro ' + APK + ' (compilá y copiá el APK primero)');

const apk = fs.readFileSync(APK);
const info = {
  versionCode: Number(code[1]),
  versionName: name[1],
  size: apk.length,
  sha256: crypto.createHash('sha256').update(apk).digest('hex'),
  notes: (process.argv[2] || '').slice(0, 500),
};
fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + '\n');
console.log(`latest.json: versión ${info.versionName} (código ${info.versionCode}), ${info.size} bytes, sha256 ${info.sha256.slice(0, 12)}…`);
