# Morse para Morsas

Una página con un botón en el medio. Mientras alguien lo mantiene apretado, se prende una luz roja arriba en los dispositivos **conectados con esa persona**, y los celulares vibran. Cuando todos lo sueltan, la luz se apaga.

## Conexiones y salas

La señal solo llega entre dispositivos conectados, y cada dispositivo puede estar en **una sola conexión a la vez**: con una persona o dentro de una sala (para cambiar, primero hay que desconectarse o salir). Abajo hay un botón **Conexión** que abre un panel con tres pestañas:

- **Personas:** todos los que tienen la app abierta o en segundo plano. Con **Conectar** les mandás una solicitud; el botón dice "Conectando… 20 s" mientras esperás. Abajo ves tus conexiones y podés desconectarte.
- **Salas:** **Crear sala** te da un código de 4 letras; el resto se une con **Unirme** y ese código. Quien crea la sala es el anfitrión y decide quién entra. Todos los miembros de una sala se ven entre sí. Si el anfitrión cierra la sala, se disuelve.
- **Solicitudes** (a la derecha): lo que te mandaron, con **Aceptar**, **Rechazar** o **Ignorar**. Si no respondés (o ignorás), a quien la mandó le vence a los 20 segundos y ve "no respondió". Si la app está cerrada, te llega una notificación.

## Quién habla

Cuando estás conectado con alguien o dentro de una sala, a la **izquierda** de la pantalla principal aparece la lista de quiénes están ahí (en pantallas grandes con su nombre al lado). **Habla una sola persona a la vez**:

- Quien tiene la palabra se marca con un **círculo verde** en su perfil, y su nombre se resalta.
- Si otra persona aprieta mientras alguien habla, no se envía nada: la luz no se prende y el botón muestra "Esperá tu turno".
- Al soltar, el círculo verde **se va consumiendo como una ruedita** durante 500 ms. Hasta que termina, nadie más puede tomar la palabra; después, cualquiera puede.
- Quien habló último puede volver a apretar enseguida, sin esperar. Si no, los puntos y rayas rápidos de un mensaje en Morse serían imposibles.
- Si quien tiene la palabra se desconecta, la suelta (con la misma espera de 500 ms).
- Sin conexión con nadie no hay turnos: la luz propia se prende igual, sin que nadie más la reciba.

El servidor es quien decide el turno; la espera se puede cambiar con la variable `FLOOR_MS`.

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
3. Si el servidor tiene código de acceso, la app lo pide la primera vez. Aceptá el permiso de notificaciones (Android lo exige para servicios permanentes) y la exención de ahorro de batería, para que Android no duerma la conexión con la pantalla apagada.
4. Listo: queda una notificación discreta "Señal activa". Tiene un botón **Detener**; el servicio también arranca solo al prender el celular, salvo que lo hayas detenido.

Cómo cuida la batería: una sola conexión, sin wakelock ni consultas periódicas (solo un ping cada 30 s), reconexión con espera creciente (2 s hasta 60 s) y reintento inmediato cuando vuelve la red. Si el servidor está apagado o estás en otro wifi, casi no consume.

**Firma:** el APK está firmado con una clave propia (release), no la de debug de Android. Android puede seguir mostrando el aviso de "app de origen desconocido" la primera vez, pero la app ya tiene una firma estable. La clave vive fuera del repositorio, en `~/.morse-keys/` (`morse-release.jks` y `keystore.properties`), y **hay que guardarla en un lugar seguro**: sin ella no se pueden publicar actualizaciones que se instalen encima de la anterior. Si el archivo no existe (por ejemplo, otra persona que clonó el repo), se compila con la clave de debug. Se genera con `gradle assembleRelease`.

Para recompilarlo hace falta JDK 17 y el SDK de Android; el proyecto está en [`android-app/`](android-app) y se genera con `gradle assembleRelease` (o `assembleDebug`).

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

Son 49 tests del servidor (usan el runner integrado de Node, no hace falta instalar nada más). Cada uno levanta su propio servidor en un puerto al azar y con un `data.json` temporal. Cubren la señal, las solicitudes (aceptar, rechazar, ignorar, vencer), las reglas de una sola conexión, las salas, todas las desconexiones de la tabla anterior, que los datos sobrevivan a un reinicio, y la robustez ante mensajes basura, mensajes enormes, ids raros, rutas HTTP maliciosas, WebSockets de otros sitios web, el código de acceso (incluido el bloqueo), que no se filtren los ids secretos, los límites de mensajes y solicitudes, el vencimiento de salas vacías y los turnos de palabra (uno solo habla, espera de 500 ms, desconexión de quien habla).

## Archivos

| Archivo | Qué es |
| --- | --- |
| `server.js` | Servidor HTTP + WebSocket |
| `index.html` | La página (botón, luz, vibración) |
| `test/` | Tests del servidor (`npm test`) |
| `public/` | Logo e íconos (los sirve el servidor) |
| `android-app/` | Proyecto de la app de Android |
| `Senal.apk` | App ya compilada |

## Seguridad

No hay cuentas ni usuarios. La protección es un **código de acceso compartido** que definís al arrancar el servidor:

```bash
ACCESS_CODE=mi-clave node server.js          # Linux / Mac / NAS
$env:ACCESS_CODE="mi-clave"; node server.js  # PowerShell
```

- Cada dispositivo (página o app) pide el código **una sola vez** y lo recuerda. Sin el código correcto el servidor cierra la conexión: quien no lo sabe no aparece en la lista de personas, no ve nada y no puede mandar señales.
- Después de 5 códigos incorrectos seguidos desde la misma dirección, esa dirección queda bloqueada un minuto.
- Si no definís `ACCESS_CODE`, el servidor funciona abierto como antes (y lo avisa al arrancar). **Si lo vas a exponer fuera de tu casa (NAS, servidor), definilo siempre.**
- Los identificadores de dispositivo (`?d=`) son secretos y largos (32 caracteres). A los demás dispositivos el servidor solo les muestra un identificador público derivado con un hash, así que nadie puede hacerse pasar por otro ni desconectarlo conociendo lo que ve en pantalla.
- Límites contra abuso: máximo de conexiones por minuto y por dispositivo, de mensajes por segundo, de solicitudes por minuto (10) y de salas (500).
- Una sala en la que no hay nadie en línea durante 24 horas se borra (`ROOM_TTL_MS` lo cambia).

Variables de entorno del servidor: `PORT`, `ACCESS_CODE`, `DATA_FILE` (dónde guardar `data.json`), `FLOOR_MS` (espera entre turnos, 500 por defecto), `TRUST_PROXY=1` (detrás de un proxy inverso, para contar los intentos por la dirección real del cliente), `ROOM_TTL_MS`.

**Para usarlo desde un NAS o servidor, fuera del wifi de casa:** el código viaja en la dirección de conexión, y con `http` plano cualquiera que mire el tráfico de red podría leerlo. Poné el servidor detrás de un proxy inverso con **HTTPS** (Nginx Proxy Manager, Caddy o el que traiga tu NAS), activá `TRUST_PROXY=1` y abrí solo el puerto del proxy. La página usa `wss://` sola cuando se abre por `https`. En la app de Android, escribí la dirección `https://…` en el cuadro de servidor.
