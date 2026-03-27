package com.melnykroman.wifimapper

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log

/**
 * Listens for Wi-Fi connectivity changes.
 * When the user connects to a new Wi-Fi network and Auto-Track is enabled,
 * this receiver starts WifiAutoTrackService to register the point.
 */
class WifiConnectionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        // Only act if auto-tracking is enabled by the user
        val prefs = context.getSharedPreferences("wifimapper_prefs", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("auto_track_enabled", false)) return

        val action = intent.action ?: return

        if (action == ConnectivityManager.CONNECTIVITY_ACTION ||
            action == WifiManager.NETWORK_STATE_CHANGED_ACTION ||
            action == WifiManager.SUPPLICANT_STATE_CHANGED_ACTION) {

            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val isConnectedToWifi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val network = cm.activeNetwork ?: return
                val caps = cm.getNetworkCapabilities(network) ?: return
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            } else {
                @Suppress("DEPRECATION")
                val info = cm.activeNetworkInfo
                info != null && info.isConnected && info.type == ConnectivityManager.TYPE_WIFI
            }

            if (isConnectedToWifi) {
                Log.d("WifiReceiver", "Wi-Fi connected — launching auto-track service")
                val serviceIntent = Intent(context, WifiAutoTrackService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
            }
        }
    }
}
