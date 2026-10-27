package com.morse.senal;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Reinicia el servicio al prender el celu, salvo que el usuario lo haya detenido a mano. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(i.getAction())
                && c.getSharedPreferences("senal", Context.MODE_PRIVATE).getBoolean("enabled", true)) {
            c.startForegroundService(new Intent(c, SignalService.class));
        }
    }
}
