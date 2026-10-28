package com.morse.senal;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Se actualiza sola desde GitHub: mira latest.json, y si hay una versión más nueva descarga Senal.apk, comprueba
 * que sea el archivo esperado (SHA-256) y se lo entrega a Android para que lo instale encima.
 *
 * Seguridad: las direcciones están fijas en el código (no salen del JSON) y Android solo instala la actualización
 * si está firmada con la MISMA clave que la app instalada; un APK ajeno no puede reemplazarla.
 */
class Updater {
    static final String BASE = "https://raw.githubusercontent.com/QuesoToffes77/Morse-para-Morsas/main/";
    static final String INFO_URL = BASE + "latest.json";
    static final String APK_URL = BASE + "Senal.apk";
    static final String ACTION_STATUS = "com.morse.senal.INSTALL_STATUS";
    private static final long MAX_APK_BYTES = 60L * 1024 * 1024;

    /** Quién recibe los avisos (la página, vía puente). Los estados llegan como JSON. */
    interface Sink { void send(JSONObject o); }
    private static volatile Sink sink;
    static void setSink(Sink s) { sink = s; }
    static void report(JSONObject o) { Sink s = sink; if (s != null) s.send(o); }

    private final Activity act;
    private final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private volatile JSONObject latest;
    private volatile boolean busy;

    Updater(Activity act) { this.act = act; }

    void shutdown() { io.shutdownNow(); }

    private static void emit(String state, Object... kv) {
        JSONObject o = new JSONObject();
        try {
            o.put("state", state);
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
        } catch (JSONException ignored) { }
        report(o);
    }

    static String fail(String text) {
        return text == null || text.isEmpty() ? "No se pudo actualizar." : text;
    }

    String currentName() {
        try { return act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName; }
        catch (Exception e) { return "?"; }
    }

    @SuppressWarnings("deprecation")
    long currentCode() {
        try {
            android.content.pm.PackageInfo p = act.getPackageManager().getPackageInfo(act.getPackageName(), 0);
            // getLongVersionCode existe desde Android 9 (API 28); la app soporta Android 8.
            return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
        } catch (Exception e) { return 0; }
    }

    /** Mira si hay una versión más nueva. */
    void check() {
        io.execute(() -> {
            try {
                latest = fetchInfo();
                if (latest.getLong("versionCode") > currentCode()) {
                    emit("available", "cur", currentName(), "latest", latest.optString("versionName", "?"),
                            "size", latest.optLong("size", 0), "notes", latest.optString("notes", ""));
                } else {
                    emit("none", "cur", currentName());
                }
            } catch (Exception e) {
                emit("error", "msg", "No pude buscar actualizaciones: " + describe(e));
            }
        });
    }

    /** Descarga la versión nueva, la verifica y le pide a Android que la instale. */
    void install() {
        io.execute(() -> {
            if (busy) return;
            busy = true;
            PackageInstaller.Session session = null;
            boolean committed = false;
            try {
                if (latest == null) latest = fetchInfo();
                if (latest.getLong("versionCode") <= currentCode()) { emit("none", "cur", currentName()); return; }
                if (!act.getPackageManager().canRequestPackageInstalls()) {
                    // Hay que dar permiso una vez ("instalar apps desconocidas") a esta app.
                    emit("perm");
                    act.runOnUiThread(() -> act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + act.getPackageName()))));
                    return;
                }
                String want = latest.getString("sha256").toLowerCase(Locale.ROOT);
                String name = latest.optString("versionName", "?");

                PackageInstaller installer = act.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params =
                        new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(act.getPackageName());
                if (Build.VERSION.SDK_INT >= 31) {
                    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                }
                int id = installer.createSession(params);
                session = installer.openSession(id);

                emit("progress", "pct", 0, "latest", name);
                Request req = new Request.Builder().url(APK_URL + "?t=" + System.currentTimeMillis())
                        .header("Cache-Control", "no-cache").build();
                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                try (Response r = http.newCall(req).execute()) {
                    ResponseBody body = r.body();
                    if (!r.isSuccessful() || body == null) throw new IOException("GitHub respondió " + r.code());
                    long total = body.contentLength();
                    if (total > MAX_APK_BYTES) throw new IOException("El archivo es demasiado grande");
                    try (InputStream in = body.byteStream();
                         OutputStream out = session.openWrite("senal.apk", 0, total > 0 ? total : -1)) {
                        byte[] buf = new byte[32 * 1024];
                        long done = 0;
                        int lastPct = -1, n;
                        while ((n = in.read(buf)) > 0) {
                            sha.update(buf, 0, n);
                            out.write(buf, 0, n);
                            done += n;
                            if (done > MAX_APK_BYTES) throw new IOException("El archivo es demasiado grande");
                            int pct = total > 0 ? (int) (done * 100 / total) : -1;
                            if (pct >= 0 && pct / 5 != lastPct / 5) { lastPct = pct; emit("progress", "pct", pct, "latest", name); }
                        }
                        session.fsync(out);
                    }
                }
                StringBuilder got = new StringBuilder();
                for (byte b : sha.digest()) got.append(String.format("%02x", b));
                if (!got.toString().equals(want)) {
                    throw new IOException("El archivo descargado no coincide con el publicado (se descartó)");
                }

                // Android avisa el resultado a UpdateReceiver (confirmación del usuario, éxito o error).
                Intent status = new Intent(act, UpdateReceiver.class).setAction(ACTION_STATUS).setPackage(act.getPackageName());
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent pending = PendingIntent.getBroadcast(act, id, status, flags);
                emit("confirm");
                session.commit(pending.getIntentSender());
                committed = true;
            } catch (Exception e) {
                emit("error", "msg", "No pude actualizar: " + describe(e));
            } finally {
                if (session != null) {
                    if (!committed) session.abandon();
                    session.close();
                }
                busy = false;
            }
        });
    }

    private JSONObject fetchInfo() throws IOException, JSONException {
        Request req = new Request.Builder().url(INFO_URL + "?t=" + System.currentTimeMillis())
                .header("Cache-Control", "no-cache").build();
        try (Response r = http.newCall(req).execute()) {
            ResponseBody body = r.body();
            if (!r.isSuccessful() || body == null) throw new IOException("GitHub respondió " + r.code());
            if (body.contentLength() > 16 * 1024) throw new IOException("Respuesta demasiado grande");
            JSONObject o = new JSONObject(body.string());
            o.getLong("versionCode");
            if (!o.getString("sha256").matches("(?i)[0-9a-f]{64}")) throw new JSONException("sha256 inválido");
            return o;
        }
    }

    private static String describe(Exception e) {
        String m = e.getMessage();
        if (e instanceof java.net.UnknownHostException || e instanceof java.net.SocketTimeoutException
                || e instanceof java.net.ConnectException) return "sin conexión a internet";
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }
}
