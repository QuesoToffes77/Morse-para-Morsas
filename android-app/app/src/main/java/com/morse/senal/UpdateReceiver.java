package com.morse.senal;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

import org.json.JSONException;
import org.json.JSONObject;

/** Recibe el resultado de la instalación que pidió Updater. */
public class UpdateReceiver extends BroadcastReceiver {
    @Override
    @SuppressWarnings("deprecation")
    public void onReceive(Context c, Intent i) {
        int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        switch (status) {
            case PackageInstaller.STATUS_PENDING_USER_ACTION: {
                // Android pide que la persona confirme; la ventana de confirmación la abrimos nosotros.
                Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                break;
            }
            case PackageInstaller.STATUS_SUCCESS:
                break;   // Android reemplaza la app y la reinicia; BootReceiver vuelve a levantar el servicio
            case PackageInstaller.STATUS_FAILURE_ABORTED:
                send("Cancelaste la instalación.");
                break;
            case PackageInstaller.STATUS_FAILURE_INCOMPATIBLE:
                send("La versión nueva está firmada con otra clave, así que Android no la instala encima. "
                        + "Desinstalá la app e instalá el APK nuevo a mano (se pierden el nombre y las conexiones de este celular).");
                break;
            case PackageInstaller.STATUS_FAILURE_STORAGE:
                send("No hay espacio suficiente en el celular.");
                break;
            default:
                send(Updater.fail(msg));
        }
    }

    private static void send(String text) {
        JSONObject o = new JSONObject();
        try { o.put("state", "error").put("msg", text); } catch (JSONException ignored) { }
        Updater.report(o);
    }
}
