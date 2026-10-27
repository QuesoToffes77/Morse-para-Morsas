# Morse para Morsas

Una página con un botón en el medio. Mientras alguien lo mantiene apretado, se prende una luz roja arriba en todos los demás dispositivos de la red, y los celulares vibran. Cuando todos lo sueltan, la luz se apaga.

## Cómo usarlo

1. Instalá [Node.js](https://nodejs.org) y, en esta carpeta, corré:

   ```bash
   npm install
   node server.js
   ```

2. La consola muestra direcciones como `http://192.168.1.16:3000`. Abrí esa dirección en cada dispositivo conectado al mismo wifi.

Si volvés a correr `node server.js` con el servidor anterior todavía abierto, el nuevo cierra al anterior solo.

Si otro dispositivo no puede entrar, puede ser el firewall de Windows. En PowerShell como administrador:

```bash
netsh advfirewall firewall add rule name="Senal 3000" dir=in action=allow protocol=TCP localport=3000 profile=private,public
```

## App de Android

[`Senal.apk`](Senal.apk) abre la página del servidor y además corre un **servicio en segundo plano**: aunque cierres la app, el celular sigue conectado y vibra cuando otro dispositivo aprieta.

1. Pasá el APK al celular e instalalo (hay que permitir instalar apps desconocidas).
2. Con el servidor corriendo, abrí la app una vez. Por defecto va a `http://192.168.1.16:3000`. Si no puede conectarse, muestra un cuadro para escribir la dirección correcta y la guarda.
3. Aceptá el permiso de notificaciones (Android lo exige para servicios permanentes) y la exención de ahorro de batería, para que Android no duerma la conexión con la pantalla apagada.
4. Listo: queda una notificación discreta "Señal activa". Tiene un botón **Detener**; el servicio también arranca solo al prender el celular, salvo que lo hayas detenido.

Cómo cuida la batería: una sola conexión, sin wakelock ni consultas periódicas (solo un ping cada 30 s), reconexión con espera creciente (2 s hasta 60 s) y reintento inmediato cuando vuelve la red. Si el servidor está apagado o estás en otro wifi, casi no consume.

Para recompilarlo hace falta JDK 17 y el SDK de Android; el proyecto está en [`android-app/`](android-app) y se genera con `gradle assembleDebug`.

## Cómo funciona

- El celular y el servidor hablan por un WebSocket y se mandan un solo carácter: `1` (apretado) o `0` (soltado).
- El servidor responde a cada dispositivo `1` si hay **otro** dispositivo apretando, y `0` si no. Solo manda cuando el valor cambia.
- La luz se prende si apretás vos o si hay otro apretando. La vibración es solo cuando aprieta otro.
- "Otro" significa otro dispositivo: la página y el servicio de un mismo celular comparten identificador (`?d=`), así que tu propio toque no te hace vibrar.
- Los toques muy cortos se mantienen al menos 60 ms en el receptor para que se alcancen a sentir (`MIN_MS` en `index.html`).
- El servidor revisa cada 10 segundos que cada dispositivo siga conectado, para que uno dormido o sin wifi no deje la luz prendida.

## Archivos

| Archivo | Qué es |
| --- | --- |
| `server.js` | Servidor HTTP + WebSocket |
| `index.html` | La página (botón, luz, vibración) |
| `android-app/` | Proyecto de la app de Android |
| `Senal.apk` | App ya compilada |

## Ojo

No hay contraseña: cualquiera en tu red puede abrir la página y activar la luz. Pensado para uso en casa.
