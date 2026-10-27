package com.morse.senal;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

public class MainActivity extends Activity {
    private static final String DEFAULT_URL = "http://192.168.1.16:3000";
    private WebView web;
    private SharedPreferences prefs;
    private boolean dialogOpen = false;

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
        setContentView(web);
        web.loadUrl(prefs.getString("url", DEFAULT_URL));
    }

    private void askAddress(String msg) {
        if (dialogOpen) return;
        dialogOpen = true;
        final EditText input = new EditText(this);
        input.setText(prefs.getString("url", DEFAULT_URL));
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
            })
            .setNegativeButton("Reintentar", (d, w) -> {
                dialogOpen = false;
                web.loadUrl(prefs.getString("url", DEFAULT_URL));
            })
            .show();
    }

    @Override
    protected void onDestroy() {
        ((Vibrator) getSystemService(Context.VIBRATOR_SERVICE)).cancel();
        super.onDestroy();
    }

    class Bridge {
        @JavascriptInterface
        public void vibrate(long ms) {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
        }
        @JavascriptInterface
        public void cancel() {
            ((Vibrator) getSystemService(Context.VIBRATOR_SERVICE)).cancel();
        }
    }
}
