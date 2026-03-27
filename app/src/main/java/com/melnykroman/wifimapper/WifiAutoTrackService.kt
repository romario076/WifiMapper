package com.melnykroman.wifimapper

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.location.Location
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import org.json.JSONArray
import org.json.JSONObject

/**
 * Persistent foreground service that listens for Wi-Fi connection changes
 * using NetworkCallback to guarantee execution even when the app is in the background.
 */
class WifiAutoTrackService : Service() {

    companion object {
        const val CHANNEL_ID       = "wifi_autotrack_channel"
        const val ALERT_CHANNEL_ID = "wifi_autotrack_alerts"
        const val NOTIF_ID         = 1001
        private var alertNotifId   = 2000  // increments per alert so each one shows
    }

    private lateinit var fusedClient: FusedLocationProviderClient
    private lateinit var connectivityManager: ConnectivityManager
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val db = FirebaseFirestore.getInstance()
    private val auth = FirebaseAuth.getInstance()

    /**
     * Tracks SSIDs that have already been counted in the current session.
     * Cleared when the network disconnects so the next connect can count again.
     */
    private val sessionTrackedSSIDs = mutableSetOf<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        fusedClient = LocationServices.getFusedLocationProviderClient(this)
        connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Use a minimal, unobtrusive notification to satisfy Android Foreground Service requirements
        startForeground(NOTIF_ID, buildNotification("WiFi Mapper", ""))

        val uid = auth.currentUser?.uid
        if (uid == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        // Register continuous Wi-Fi listener
        if (networkCallback == null) {
            val request = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .build()

            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    super.onAvailable(network)
                    // SSID is often empty precisely when the network connects. Retry up to 5 times.
                    val handler = android.os.Handler(android.os.Looper.getMainLooper())
                    var attempts = 0
                    val maxAttempts = 5

                    val checkSSIDRunnable = object : Runnable {
                        override fun run() {
                            val ssid = getSSID()
                            if (ssid.isNotEmpty()) {
                                Log.d("WifiAutoTrack", "Wi-Fi connected (ssid=$ssid)")
                                if (!sessionTrackedSSIDs.contains(ssid)) {
                                    sessionTrackedSSIDs.add(ssid)
                                    handleWifiConnection(uid, ssid)
                                }
                            } else {
                                attempts++
                                if (attempts < maxAttempts) {
                                    handler.postDelayed(this, 2000)
                                } else {
                                    Log.d("WifiAutoTrack", "Could not resolve SSID after $attempts attempts")
                                }
                            }
                        }
                    }
                    handler.postDelayed(checkSSIDRunnable, 2000)
                }

                override fun onLost(network: Network) {
                    super.onLost(network)
                    // When the network is lost, remove it from tracked set
                    // so the next connect can count as a new session
                    val ssid = getSSID()
                    if (ssid.isNotEmpty()) sessionTrackedSSIDs.remove(ssid)
                    else sessionTrackedSSIDs.clear() // fallback: clear all
                    Log.d("WifiAutoTrack", "Wi-Fi lost, session cleared for ssid=$ssid")
                }
            }
            connectivityManager.registerNetworkCallback(request, networkCallback!!)

            // Trigger once immediately if already connected
            val ssid = getSSID()
            if (ssid.isNotEmpty() && !sessionTrackedSSIDs.contains(ssid)) {
                sessionTrackedSSIDs.add(ssid)
                handleWifiConnection(uid, ssid)
            }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        networkCallback?.let {
            try { connectivityManager.unregisterNetworkCallback(it) } catch (e: Exception) {}
        }
    }

    private fun handleWifiConnection(uid: String, ssid: String) {
        try {
            fusedClient.getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, null)
                .addOnSuccessListener { location: Location? ->
                    if (location != null) {
                        processConnection(uid, ssid, location)
                    } else {
                        Log.d("AutoTrack", "Could not get current location")
                    }
                }
                .addOnFailureListener { e ->
                    Log.e("AutoTrack", "Failed to get location: ${e.message}")
                    // Remove from session so it can retry next connect
                    sessionTrackedSSIDs.remove(ssid)
                }
        } catch (e: SecurityException) {
            Log.e("AutoTrack", "Location permission denied: ${e.message}")
            sessionTrackedSSIDs.remove(ssid)
        }
    }

    private fun getSSID(): String {
        return try {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val raw = wm.connectionInfo.ssid
            if (!raw.isNullOrEmpty() && raw != "<unknown ssid>" && raw != "0x") {
                raw.replace("\"", "").trim()
            } else ""
        } catch (e: Exception) { "" }
    }

    private fun processConnection(uid: String, ssid: String, location: Location) {
        val lat = location.latitude
        val lng = location.longitude
        val alt = if (location.hasAltitude()) Math.round(location.altitude) else 0L

        var cityStr = "Auto-detected"
        var countryStr = ""
        try {
            val geocoder = android.location.Geocoder(this, java.util.Locale.ENGLISH)
            val addresses = geocoder.getFromLocation(lat, lng, 1)
            if (!addresses.isNullOrEmpty()) {
                val addr = addresses[0]
                cityStr = addr.locality ?: addr.subAdminArea ?: addr.adminArea ?: "Unknown"
                countryStr = addr.countryName ?: ""
            }
        } catch (e: Exception) {}

        db.collection("users").document(uid).collection("points").get()
            .addOnSuccessListener { snapshot ->
                val arr = JSONArray()
                for (doc in snapshot.documents) {
                    val data = doc.data ?: continue
                    val obj = JSONObject(data).apply { put("id", doc.id) }
                    arr.put(obj)
                }

                var duplicate: JSONObject? = null
                for (i in 0 until arr.length()) {
                    val pt = arr.getJSONObject(i)
                    if (pt.optString("ssid") == ssid) {
                        val results = FloatArray(1)
                        Location.distanceBetween(lat, lng, pt.optDouble("lat", 0.0), pt.optDouble("lng", 0.0), results)
                        if (results[0] <= 150f) { duplicate = pt; break }
                    }
                }

                if (duplicate != null) {
                    // Anti-Spam Cooldown: Ignore if connected to the exact same network consecutively
                    val prefs = getSharedPreferences("wifimapper_prefs", android.content.Context.MODE_PRIVATE)
                    val cooldownMins = prefs.getInt("autotrack_cooldown", 60)
                    val cooldownMs = cooldownMins * 60 * 1000L

                    var recentConnectionFound = false
                    val now = System.currentTimeMillis()
                    
                    val lastSSID = prefs.getString("last_connected_ssid", null)
                    var applyAntiSpam = false
                    if (ssid == lastSSID) {
                        applyAntiSpam = true
                    }
                    prefs.edit().putString("last_connected_ssid", ssid).apply()

                    if (applyAntiSpam) {
                        val dateAdded = duplicate.optLong("dateAdded", 0L)
                        if (now - dateAdded < cooldownMs) recentConnectionFound = true

                        val historyArr = duplicate.optJSONArray("history")
                        if (!recentConnectionFound && historyArr != null) {
                            for (j in 0 until historyArr.length()) {
                                val hObj = historyArr.optJSONObject(j) ?: continue
                                val hDate = hObj.optLong("date", 0L)
                                if (now - hDate < cooldownMs) {
                                    recentConnectionFound = true
                                    break
                                }
                            }
                        }
                    }

                    if (recentConnectionFound) {
                        Log.d("AutoTrack", "Anti-spam: Ignored reconnection to $ssid within $cooldownMins min")
                        return@addOnSuccessListener
                    }

                    val docId = duplicate.getString("id")

                    val historyEntry = mapOf(
                        "date"     to now,
                        "auto"     to true,
                        "altitude" to alt,
                        "note"     to "autotrack"
                    )

                    db.collection("users").document(uid).collection("points").document(docId)
                        .update(
                            "connections", com.google.firebase.firestore.FieldValue.increment(1),
                            "history",     com.google.firebase.firestore.FieldValue.arrayUnion(historyEntry)
                        )
                        .addOnSuccessListener {
                            // Find the last known connection time to calculate how long it's been
                            var lastConnectedTime = duplicate.optLong("dateAdded", 0L)
                            val historyArray = duplicate.optJSONArray("history")
                            if (historyArray != null) {
                                for (j in 0 until historyArray.length()) {
                                    val hObj = historyArray.optJSONObject(j) ?: continue
                                    val hDate = hObj.optLong("date", 0L)
                                    if (hDate > lastConnectedTime) {
                                        lastConnectedTime = hDate
                                    }
                                }
                            }
                            
                            val timeDiffMs = now - lastConnectedTime
                            val daysSince = java.util.concurrent.TimeUnit.MILLISECONDS.toDays(timeDiffMs)
                            
                            val title: String
                            val bodyText: String
                            
                            if (daysSince > 30) {
                                title = "Welcome back! 🎉"
                                bodyText = "You haven't been at $ssid for $daysSince days. Good to see you again!"
                            } else if (daysSince > 0) {
                                title = "Welcome back! 👋"
                                bodyText = "It's been $daysSince days since your last visit to $ssid."
                            } else {
                                title = "Reconnected to $ssid 🔄"
                                bodyText = "Connection successfully logged in $cityStr."
                            }

                            postAlertNotification(title, bodyText)
                            notifyMainActivity("AUTO_TRACK_UPDATE", ssid)
                        }
                } else {
                    val newId = db.collection("users").document(uid).collection("points").document().id
                    val data = mapOf(
                        "ssid"           to ssid, "lat" to lat, "lng" to lng,
                        "city"           to cityStr, "country" to countryStr, "altitude" to alt,
                        "note"           to "autotrack", "connections" to 1, "markerColor" to "#10b981",
                        "dateAdded"      to System.currentTimeMillis(), "history" to emptyList<Any>(), "autoRegistered" to true
                    )
                    getSharedPreferences("wifimapper_prefs", android.content.Context.MODE_PRIVATE)
                        .edit().putString("last_connected_ssid", ssid).apply()
                        
                    db.collection("users").document(uid).collection("points").document(newId).set(data)
                        .addOnSuccessListener {
                            postAlertNotification("📍 New network \"$ssid\"", "Auto-registered in $cityStr!")
                            notifyMainActivity("AUTO_TRACK_NEW", ssid)
                        }
                }
            }
    }

    private fun notifyMainActivity(action: String, ssid: String) {
        val broadcastIntent = Intent("com.melnykroman.wifimapper.AUTO_TRACK_EVENT").apply {
            putExtra("action", action)
            putExtra("ssid", ssid)
        }
        sendBroadcast(broadcastIntent)
    }

    private fun updateNotification(title: String, text: String) {
        // Always keep the persistent foreground notification in sync
        val notifManager = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
        notifManager.notify(NOTIF_ID, buildNotification(title, text))
    }

    /** Posts a NEW high-importance (heads-up) alert notification if silent mode is off. */
    private fun postAlertNotification(title: String, text: String) {
        val prefs = getSharedPreferences("wifimapper_prefs", android.content.Context.MODE_PRIVATE)
        if (prefs.getBoolean("silent_track_enabled", false)) return

        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification = NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)           // dismisses when tapped
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        val notifManager = getSystemService(NOTIFICATION_SERVICE) as android.app.NotificationManager
        notifManager.notify(++alertNotifId, notification)
    }

    private fun buildNotification(title: String, text: String): android.app.Notification {
        val pendingIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Persistent silent foreground channel
            val foreground = NotificationChannel(
                CHANNEL_ID, "Wi-Fi Auto Tracking", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Persistent notification while Auto-Tracking is enabled" }

            // High-importance alert channel for new/updated connections
            val alerts = NotificationChannel(
                ALERT_CHANNEL_ID, "Wi-Fi Auto-Track Alerts", NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Pops up when a new Wi-Fi is logged or a connection is updated"
                enableVibration(true)
            }

            val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            mgr.createNotificationChannel(foreground)
            mgr.createNotificationChannel(alerts)
        }
    }
}
