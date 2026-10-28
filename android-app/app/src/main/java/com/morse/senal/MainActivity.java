package com.morse.senal;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

import org.json.JSONObject;

public class MainActivity extends Activity {
    private WebView web;
    private SharedPreferences prefs;
    private boolean dialogOpen = false;
    private Updater updater;

    @Override
    protected void onDestroy() {
        Updater.setSink(null);
        if (updater != null) updater.shutdown();
        super.onDestroy();
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences("senal", MODE_PRIVATE);

        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) askAddress("No se pudo conectar. Revisá la dirección del servidor:");
            }
        });
        web.setBackgroundColor(0xFF313338);   // sin destello blanco antes de que cargue la página
        setContentView(web);

        // Los avisos del actualizador llegan a la página (window.__upd) como JSON.
        updater = new Updater(this);
        Updater.setSink(o -> web.post(() -> web.evaluateJavascript("window.__upd&&window.__upd(" + o + ")", null)));
        web.loadUrl(prefs.getString("url", SignalService.DEFAULT_URL));

        startService();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        } else {
            askBatteryExemption();
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        askBatteryExemption();
    }

    /** El servicio queda corriendo aunque se cierre la app; ver SignalService. */
    private void startService() {
        startForegroundService(new Intent(this, SignalService.class));
    }

    /** Una sola vez: sin esto, el ahorro de batería de Android puede dormir la conexión con la pantalla apagada. */
    private void askBatteryExemption() {
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm.isIgnoringBatteryOptimizations(getPackageName()) || prefs.getBoolean("askedBattery", false)) return;
        prefs.edit().putBoolean("askedBattery", true).apply();
        startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + getPackageName())));
    }

    private void askAddress(String msg) {
        if (dialogOpen) return;
        dialogOpen = true;
        final EditText input = new EditText(this);
        input.setText(prefs.getString("url", SignalService.DEFAULT_URL));
        new AlertDialog.Builder(this)
            .setTitle("Servidor")
            .setMessage(msg)
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("Conectar", (d, w) -> {
                String u = input.getText().toString().trim();
                if (!u.startsWith("http")) u = "http://" + u;
                prefs.edit().putString("url", u).apply();
                dialogOpen = false;
                web.loadUrl(u);
                startForegroundService(new Intent(this, SignalService.class)
                        .setAction(SignalService.ACTION_RECONNECT));   // el servicio usa la dirección nueva
            })
            .setNegativeButton("Reintentar", (d, w) -> {
                dialogOpen = false;
                web.loadUrl(prefs.getString("url", SignalService.DEFAULT_URL));
            })
            .show();
    }

    class Bridge {
        /** La página lo usa como identificador; el servicio nativo usa el mismo para no vibrar con tu propio toque. */
        @JavascriptInterface
        public String deviceId() {
            return SignalService.deviceId(MainActivity.this);
        }

        /** El nombre lo elige la persona en la página; el servicio lo necesita para presentarse al servidor. */
        @JavascriptInterface
        public void setName(String n) {
            prefs.edit().putString("name", n).apply();
        }

        @JavascriptInterface
        public String getName() {
            return prefs.getString("name", "");
        }

        /** Versión instalada, para mostrarla en el menú de ajustes. */
        @JavascriptInterface
        public String appInfo() {
            return "{\"versionName\":" + JSONObject.quote(updater.currentName()) + ",\"versionCode\":" + updater.currentCode() + "}";
        }

        /** Busca una versión nueva en GitHub; el resultado vuelve por window.__upd. */
        @JavascriptInterface
        public void checkUpdate() { updater.check(); }

        /** Descarga la versión nueva y pide a Android que la instale encima. */
        @JavascriptInterface
        public void installUpdate() { updater.install(); }

        /** Código de acceso del servidor: la página lo pide una vez y el servicio lo necesita para conectarse. */
        @JavascriptInterface
        public String getCode() {
            return prefs.getString("code", "");
        }

        @JavascriptInterface
        public void setCode(String c) {
            prefs.edit().putString("code", c).apply();
            startForegroundService(new Intent(MainActivity.this, SignalService.class)
                    .setAction(SignalService.ACTION_RECONNECT));   // reintenta ya con el código nuevo
        }
    }
}
