package com.melnykroman.wifimapper

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restores auto-tracking state after device reboot.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val prefs = context.getSharedPreferences("wifimapper_prefs", Context.MODE_PRIVATE)
            if (prefs.getBoolean("auto_track_enabled", false)) {
                val serviceIntent = Intent(context, WifiAutoTrackService::class.java)
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
            }
        }
    }
}
