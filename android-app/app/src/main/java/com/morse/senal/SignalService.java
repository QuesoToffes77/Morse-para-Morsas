package com.morse.senal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Mantiene UNA conexión WebSocket con el servidor y vibra mientras otro dispositivo aprieta,
 * aunque la app esté cerrada. Para gastar poca batería: sin wakelock, sin polling (solo el ping
 * de OkHttp cada 30 s), reconexión con espera creciente y reintento inmediato al volver la red.
 */
public class SignalService extends Service {
    static final String DEFAULT_URL = "http://192.168.1.16:3000";
    static final String ACTION_STOP = "com.morse.senal.STOP";
    static final String ACTION_RECONNECT = "com.morse.senal.RECONNECT";

    private static final String CHANNEL = "senal";
    private static final String CHANNEL_REQ = "solicitudes";
    private static final int NOTIF_ID = 1;
    private static final int NOTIF_NEED_CODE = 2;
    private static final int CLOSE_NEED_CODE = 4001;   // el servidor pide (o rechaza) el código de acceso
    private static final int MIN_VIBRATION_MS = 100;
    private static final long BUZZ_MS = 60_000;   // duración de cada vibración continua (se renueva 5 s antes de terminar)
    private static final long REQUEST_NOTIFICATION_MS = 20_000;   // igual que lo que espera el servidor
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable reconnect = this::connect;
    private final Runnable renewBuzz = this::renew;
    private OkHttpClient client;
    private WebSocket socket;
    private Vibrator vibrator;
    private ConnectivityManager cm;
    private ConnectivityManager.NetworkCallback netCallback;
    private SharedPreferences prefs;
    private int attempt = 0;
    private boolean vibrating = false;
    private long vibratingSince;
    private Runnable pendingStop;

    /** Identificador estable del celu; la página lo usa también para que su propio toque no lo haga vibrar. */
    static String deviceId(Context c) {
        SharedPreferences p = c.getSharedPreferences("senal", MODE_PRIVATE);
        String id = p.getString("dev", null);
        if (id == null) {
            // Secreto: el servidor nunca se lo muestra a otros, pero igual se genera largo e impredecible.
            id = UUID.randomUUID().toString().replace("-", "");
            p.edit().putString("dev", id).apply();
        }
        return id;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("senal", MODE_PRIVATE);
        vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        client = new OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build();

        NotificationChannel ch = new NotificationChannel(CHANNEL, "Escuchando señales",
                NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(ch);
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL_REQ, "Solicitudes de conexión", NotificationManager.IMPORTANCE_DEFAULT));

        // Reintenta enseguida cuando vuelve la red, en vez de seguir esperando el backoff.
        cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) {
                main.post(() -> { if (socket == null) { attempt = 0; connect(); } });
            }
        };
        cm.registerDefaultNetworkCallback(netCallback);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            prefs.edit().putBoolean("enabled", false).apply();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        prefs.edit().putBoolean("enabled", true).apply();

        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIF_ID, n);
        }

        if (ACTION_RECONNECT.equals(action) && socket != null) {   // cambió la dirección del servidor
            WebSocket old = socket;
            socket = null;
            old.cancel();
            onSignal(false);
        }
        if (socket == null) {
            attempt = 0;
            connect();
        }
        return START_STICKY;
    }

    private Notification buildNotification() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, SignalService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Señal activa")
                .setContentText("Vibra cuando otro dispositivo aprieta")
                .setColor(0xFF5865F2)
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Detener", stop).build())
                .build();
    }

    private void connect() {
        if (socket != null) return;
        main.removeCallbacks(reconnect);
        String base = prefs.getString("url", DEFAULT_URL).replaceFirst("^http", "ws");
        Request req;
        try {
            // s=1: es el servicio, que no necesita el estado completo de la pantalla de conexión.
            String code = prefs.getString("code", "");
            req = new Request.Builder().url(base + "/?s=1&d=" + deviceId(this)
                    + (code.isEmpty() ? "" : "&k=" + URLEncoder.encode(code, "UTF-8"))).build();
        } catch (IllegalArgumentException | UnsupportedEncodingException e) {      // dirección mal escrita: no reintentar en bucle
            return;
        }
        socket = client.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response r) {
                attempt = 0;
                // Con la app cerrada igual aparece en la lista de conectados con su nombre.
                String name = prefs.getString("name", "");
                try {
                    if (!name.isEmpty()) ws.send(new JSONObject().put("t", "name").put("n", name).toString());
                } catch (JSONException ignored) { }
            }
            @Override public void onMessage(WebSocket ws, String text) {
                if (text.startsWith("{")) { onControl(text); return; }
                main.post(() -> { if (ws == socket) onSignal("1".equals(text)); });
            }
            @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, null); }
            @Override public void onClosed(WebSocket ws, int code, String reason) { lost(ws, code); }
            @Override public void onFailure(WebSocket ws, Throwable t, Response r) { lost(ws, 0); }
        });
    }

    /** Solicitud de conexión recibida con la app cerrada: se muestra como notificación. */
    private void onControl(String text) {
        try {
            JSONObject o = new JSONObject(text);
            if (!"req".equals(o.optString("t"))) return;
            String from = o.optString("from");
            String msg = "join".equals(o.optString("kind"))
                    ? from + " quiere unirse a tu sala " + o.optString("code")
                    : from + " quiere conectarse con vos";
            PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                    PendingIntent.FLAG_IMMUTABLE);
            getSystemService(NotificationManager.class).notify((int) (System.nanoTime() & 0x7fffffff),
                    new Notification.Builder(this, CHANNEL_REQ)
                            .setSmallIcon(R.drawable.ic_stat)
                            .setContentTitle("Solicitud de conexión")
                            .setContentText(msg)
                            .setColor(0xFF5865F2)
                            .setContentIntent(open)
                            .setAutoCancel(true)
                            .setTimeoutAfter(REQUEST_NOTIFICATION_MS)   // la solicitud vence: la notificación también
                            .build());
        } catch (JSONException ignored) { }
    }

    private void lost(WebSocket ws, int closeCode) {
        main.post(() -> {
            if (ws != socket) return;          // conexión vieja, ya reemplazada
            socket = null;
            onSignal(false);
            if (closeCode == CLOSE_NEED_CODE) {   // falta el código (o está mal): reintentar no sirve, hay que pedirlo
                notifyNeedCode();
                return;
            }
            long delay = Math.min(60_000L, 2_000L << Math.min(attempt++, 5));   // 2 s ... 60 s
            main.postDelayed(reconnect, delay);
        });
    }

    private void notifyNeedCode() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE);
        getSystemService(NotificationManager.class).notify(NOTIF_NEED_CODE,
                new Notification.Builder(this, CHANNEL_REQ)
                        .setSmallIcon(R.drawable.ic_stat)
                        .setContentTitle("Falta el código de acceso")
                        .setContentText("Abrí la app e ingresalo para volver a conectarte")
                        .setColor(0xFF5865F2)
                        .setContentIntent(open)
                        .setAutoCancel(true)
                        .build());
    }

    /** Vibra mientras OTRO dispositivo aprieta (nunca por el toque propio); un toque corto se mantiene un mínimo para que se sienta. */
    private void onSignal(boolean on) {
        if (on) {
            if (pendingStop != null) { main.removeCallbacks(pendingStop); pendingStop = null; }
            if (!vibrating) {
                vibrating = true;
                vibratingSince = System.currentTimeMillis();
                // Repite hasta cancelar; USAGE_ALARM para que Android no la bloquee en segundo plano.
                buzz();
                main.postDelayed(renewBuzz, BUZZ_MS - 5_000);
            }
        } else if (vibrating && pendingStop == null) {
            long wait = Math.max(0, MIN_VIBRATION_MS - (System.currentTimeMillis() - vibratingSince));
            pendingStop = () -> { pendingStop = null; stopVibration(); };
            main.postDelayed(pendingStop, wait);
        }
    }

    /**
     * Una sola vibración continua y larga. Un patrón que se repite (p. ej. 1 s, repetir) deja un corte corto
     * en cada vuelta; renovándola antes de que termine no se nota ningún corte mientras se mantiene apretado.
     */
    private void buzz() {
        // USAGE_ALARM para que Android no la bloquee en segundo plano.
        vibrator.vibrate(VibrationEffect.createOneShot(BUZZ_MS, VibrationEffect.DEFAULT_AMPLITUDE),
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
    }

    private void renew() {
        if (!vibrating) return;
        buzz();                                       // reemplaza la anterior sin pausa
        main.postDelayed(renewBuzz, BUZZ_MS - 5_000);
    }

    private void stopVibration() {
        main.removeCallbacks(renewBuzz);
        if (pendingStop != null) { main.removeCallbacks(pendingStop); pendingStop = null; }
        vibrating = false;
        vibrator.cancel();
    }

    @Override
    public void onDestroy() {
        cm.unregisterNetworkCallback(netCallback);
        main.removeCallbacksAndMessages(null);
        stopVibration();
        if (socket != null) { socket.cancel(); socket = null; }
        client.dispatcher().executorService().shutdown();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent i) { return null; }
}
