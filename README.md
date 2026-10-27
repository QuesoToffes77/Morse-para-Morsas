# Morse para Morsas

Una página con un botón en el medio. Mientras alguien lo mantiene apretado, se prende una luz roja arriba en los dispositivos **conectados con esa persona**, y los celulares vibran. Cuando todos lo sueltan, la luz se apaga.

## Conexiones y salas

La señal solo llega entre dispositivos conectados, y cada dispositivo puede estar en **una sola conexión a la vez**: con una persona o dentro de una sala (para cambiar, primero hay que desconectarse o salir). Abajo hay un botón **Conexión** que abre un panel con tres pestañas:

- **Personas:** todos los que tienen la app abierta o en segundo plano. Con **Conectar** les mandás una solicitud; el botón dice "Conectando… 20 s" mientras esperás. Abajo ves tus conexiones y podés desconectarte.
- **Salas:** **Crear sala** te da un código de 4 letras; el resto se une con **Unirme** y ese código. Quien crea la sala es el anfitrión y decide quién entra. Todos los miembros de una sala se ven entre sí. Si el anfitrión cierra la sala, se disuelve.
- **Solicitudes** (a la derecha): lo que te mandaron, con **Aceptar**, **Rechazar** o **Ignorar**. Si no respondés (o ignorás), a quien la mandó le vence a los 20 segundos y ve "no respondió". Si la app está cerrada, te llega una notificación.

La primera vez te pide un nombre (es lo que ven los demás). Las conexiones, salas y nombres se guardan en `data.json` junto al servidor, así sobreviven a un reinicio.

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

- El celular y el servidor hablan por un WebSocket. La señal es un solo carácter: `1` (apretado) o `0` (soltado). Las conexiones y salas se manejan con mensajes JSON por el mismo WebSocket.
- El servidor responde a cada dispositivo `1` si hay otro dispositivo **conectado con él** apretando, y `0` si no. Solo manda cuando el valor cambia.
- La luz se prende si apretás vos o si hay otro apretando. La vibración es solo cuando aprieta otro: nadie se vibra a sí mismo.
- "Otro" significa otro dispositivo: la página y el servicio de un mismo celular comparten identificador (`?d=`), así que el servidor no te avisa de tu propio toque.
- Los toques muy cortos se mantienen al menos 100 ms (luz y vibración) en el receptor para que se alcancen a sentir (`MIN_MS` en `index.html` y `MIN_VIBRATION_MS` en `SignalService.java`).
- El servidor revisa cada 10 segundos que cada dispositivo siga conectado, para que uno dormido o sin wifi no deje la luz prendida.

## Qué pasa cuando alguien se desconecta

| Situación | Qué ocurre |
| --- | --- |
| Se corta el wifi o se cierra la app **con el botón apretado** | Para los demás la luz se apaga y la vibración para enseguida. |
| Se cierra la pantalla pero queda el servicio en segundo plano | Sigue "en línea" y recibe la señal; es el uso normal con la app cerrada. |
| Se desconecta tu pareja o un miembro de tu sala | La conexión se **conserva** y aparece "sin conexión". Al volver, todo sigue funcionando sin repetir nada. |
| Se desconecta el anfitrión de una sala | La sala sigue entre sus miembros, pero nadie nuevo puede pedir entrar hasta que vuelva. |
| Alguien se desconecta con una solicitud **enviada** | La solicitud se cancela y desaparece de la bandeja del otro. |
| Alguien se desconecta con una solicitud **recibida** | Quien esperaba se entera enseguida ("se desconectó"), sin esperar los 20 s. |
| El anfitrión cierra la sala con solicitudes de ingreso pendientes | Esas solicitudes se cancelan ("la sala se cerró"); nunca se "aceptan" una sala inexistente. |
| Se cae el servidor | La página y la app reintentan solas (1, 2, 4, 8 y luego cada 10 s) y al volver recuperan conexiones y salas, que se guardan en `data.json`. |
| Un celular se queda sin red sin avisar (se durmió, se alejó del wifi) | El servidor revisa cada 10 s y lo da de baja; no deja la luz de nadie prendida. |

## Tests

```bash
npm test
```

Son 34 tests del servidor (usan el runner integrado de Node, no hace falta instalar nada más). Cada uno levanta su propio servidor en un puerto al azar y con un `data.json` temporal. Cubren la señal, las solicitudes (aceptar, rechazar, ignorar, vencer), las reglas de una sola conexión, las salas, todas las desconexiones de la tabla anterior, que los datos sobrevivan a un reinicio, y la robustez ante mensajes basura, mensajes enormes, ids raros, rutas HTTP maliciosas y WebSockets de otros sitios web.

## Archivos

| Archivo | Qué es |
| --- | --- |
| `server.js` | Servidor HTTP + WebSocket |
| `index.html` | La página (botón, luz, vibración) |
| `test/` | Tests del servidor (`npm test`) |
| `public/` | Logo e íconos (los sirve el servidor) |
| `android-app/` | Proyecto de la app de Android |
| `Senal.apk` | App ya compilada |

## Ojo

No hay contraseña: cualquiera en tu red puede abrir la página y activar la luz. Pensado para uso en casa.
