package com.morse.senal;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Reinicia el servicio al prender el celu y después de que la app se actualiza sola (Android la cierra al
 * reemplazarla), salvo que el usuario lo haya detenido a mano.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String a = i.getAction();
        if ((Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a))
                && c.getSharedPreferences("senal", Context.MODE_PRIVATE).getBoolean("enabled", true)) {
            c.startForegroundService(new Intent(c, SignalService.class));
        }
    }
}
