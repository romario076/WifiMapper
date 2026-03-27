package com.melnykroman.wifimapper

import android.content.Context
import android.net.wifi.WifiManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import org.json.JSONArray
import org.json.JSONObject

class WebAppInterface(
    private val activity: MainActivity,
    private val webView: WebView,
    private val auth: FirebaseAuth,
    private val googleSignInClient: GoogleSignInClient
) {

    private val db = FirebaseFirestore.getInstance()
    private val analytics = FirebaseAnalytics.getInstance(activity)

    // ── Auth ──────────────────────────────────────────────────────────────

    @JavascriptInterface
    fun signInWithGoogle() {
        activity.runOnUiThread { activity.startGoogleSignIn() }
    }

    @JavascriptInterface
    fun signOut() {
        activity.runOnUiThread { activity.performSignOut() }
    }

    @JavascriptInterface
    fun getUserInfo(): String {
        val user = auth.currentUser ?: return ""
        return JSONObject().apply {
            put("uid", user.uid)
            put("name", user.displayName ?: "")
            put("email", user.email ?: "")
            put("photo", user.photoUrl?.toString() ?: "")
        }.toString()
    }

    @JavascriptInterface
    fun isSignedIn(): Boolean = auth.currentUser != null

    // ── SSID ──────────────────────────────────────────────────────────────

    @JavascriptInterface
    fun getSSID(): String {
        return try {
            val wm = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val raw = wm.connectionInfo.ssid ?: return ""
            // Remove surrounding quotes that Android adds (e.g. "\"MySSID\"" → MySSID)
            val ssid = raw.trim().removeSurrounding("\"")
            // Reject known placeholders returned when location permission is missing
            if (ssid.isEmpty() || ssid == "<unknown ssid>" || ssid == "0x") "" else ssid
        } catch (e: Exception) {
            ""
        }
    }

    // ── Firestore: Load all points ─────────────────────────────────────────

    @JavascriptInterface
    fun loadPoints() {
        val uid = auth.currentUser?.uid ?: return
        db.collection("users").document(uid).collection("points")
            .get()
            .addOnSuccessListener { snapshot ->
                val arr = JSONArray()
                for (doc in snapshot.documents) {
                    val data = doc.data ?: continue
                    val obj = JSONObject(data).apply {
                        put("id", doc.id)
                    }
                    arr.put(obj)
                }
                // Use Base64 encoding to safely pass any JSON into JS without escaping issues
                val b64 = android.util.Base64.encodeToString(
                    arr.toString().toByteArray(Charsets.UTF_8),
                    android.util.Base64.NO_WRAP
                )
                activity.runOnUiThread {
                    webView.evaluateJavascript("onPointsLoaded(decodeURIComponent(escape(atob('$b64'))))", null)
                }
            }
            .addOnFailureListener {
                activity.runOnUiThread {
                    webView.evaluateJavascript("onPointsLoaded('[]')", null)
                }
            }
    }


    // ── Firestore: Save / update single point ──────────────────────────────

    @JavascriptInterface
    fun savePoint(jsonStr: String) {
        val uid = auth.currentUser?.uid ?: return
        try {
            val obj = JSONObject(jsonStr)
            val id = obj.optString("id").ifEmpty { db.collection("_").document().id }
            val data = jsonToMap(obj).toMutableMap()
            data.remove("id")

            db.collection("users").document(uid)
                .collection("points").document(id)
                .set(data, SetOptions.merge())
                .addOnSuccessListener {
                    analytics.logEvent("point_saved", null)
                    activity.runOnUiThread {
                        webView.evaluateJavascript("onPointSaved('$id')", null)
                    }
                }
        } catch (e: Exception) {
            // ignore
        }
    }

    private fun jsonToMap(obj: JSONObject): Map<String, Any> {
        val map = mutableMapOf<String, Any>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            var value = obj.get(key)
            if (value is JSONArray) {
                value = jsonToList(value)
            } else if (value is JSONObject) {
                value = jsonToMap(value)
            } else if (value == JSONObject.NULL) {
                continue
            }
            map[key] = value
        }
        return map
    }

    private fun jsonToList(arr: JSONArray): List<Any> {
        val list = mutableListOf<Any>()
        for (i in 0 until arr.length()) {
            var value = arr.get(i)
            if (value is JSONArray) {
                value = jsonToList(value)
            } else if (value is JSONObject) {
                value = jsonToMap(value)
            } else if (value == JSONObject.NULL) {
                continue
            }
            list.add(value)
        }
        return list
    }

    // ── Firestore: Delete single point ─────────────────────────────────────

    @JavascriptInterface
    fun deletePoint(pointId: String) {
        val uid = auth.currentUser?.uid ?: return
        db.collection("users").document(uid)
            .collection("points").document(pointId)
            .delete()
            .addOnSuccessListener {
                analytics.logEvent("point_deleted", null)
            }
    }

    // ── Firestore: Delete ALL points ───────────────────────────────────────

    @JavascriptInterface
    fun deleteAllPoints() {
        val uid = auth.currentUser?.uid ?: return
        db.collection("users").document(uid).collection("points")
            .get()
            .addOnSuccessListener { snapshot ->
                val batch = db.batch()
                for (doc in snapshot.documents) batch.delete(doc.reference)
                batch.commit()
            }
    }

    // ── File Export & Import ───────────────────────────────────────────────

    @JavascriptInterface
    fun exportData(jsonString: String) {
        activity.runOnUiThread {
            activity.pendingExportData = jsonString
            val intent = android.content.Intent(android.content.Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(android.content.Intent.CATEGORY_OPENABLE)
                type = "application/json"
                putExtra(android.content.Intent.EXTRA_TITLE, "WiFiMapper_Backup.json")
            }
            activity.startActivityForResult(intent, 9002)
        }
    }

    @JavascriptInterface
    fun importData() {
        activity.runOnUiThread {
            val intent = android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(android.content.Intent.CATEGORY_OPENABLE)
                type = "application/json"
            }
            activity.startActivityForResult(intent, 9003)
        }
    }

    // ── Social / Profiles ──────────────────────────────────────────────────

    @JavascriptInterface
    fun setPublicProfile(isPublic: Boolean) {
        val currentUser = auth.currentUser ?: return
        val userData = mapOf(
            "isPublic" to isPublic,
            "lastUpdated" to com.google.firebase.firestore.FieldValue.serverTimestamp()
        )
        db.collection("users").document(currentUser.uid)
            .set(userData, SetOptions.merge())
            .addOnSuccessListener {
                analytics.logEvent(if (isPublic) "profile_made_public" else "profile_made_private", null)
            }
    }

    // ── Auto WiFi Tracking ─────────────────────────────────────────────────

    @JavascriptInterface
    fun setAutoTrack(enabled: Boolean) {
        val prefs = activity.getSharedPreferences("wifimapper_prefs", android.content.Context.MODE_PRIVATE)
        prefs.edit().putBoolean("auto_track_enabled", enabled).apply()
        analytics.logEvent(if (enabled) "auto_track_on" else "auto_track_off", null)
        // JavascriptInterface callbacks run on a background thread.
        // Service start/stop MUST be on the UI (main) thread.
        activity.runOnUiThread {
            try {
                val intent = android.content.Intent(activity, WifiAutoTrackService::class.java)
                if (enabled) {
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        activity.startForegroundService(intent)
                    } else {
                        activity.startService(intent)
                    }
                } else {
                    activity.stopService(intent)
                }
            } catch (e: Exception) {
                android.util.Log.e("WebAppInterface", "setAutoTrack error: ${e.message}")
            }
        }
    }

    @JavascriptInterface
    fun isAutoTrackEnabled(): Boolean {
        val prefs = activity.getSharedPreferences("wifimapper_prefs", android.content.Context.MODE_PRIVATE)
        return prefs.getBoolean("auto_track_enabled", false)
    }

    @JavascriptInterface
    fun setAutoTrackCooldown(minutes: Int) {
        val prefs = activity.getSharedPreferences("wifimapper_prefs", android.content.Context.MODE_PRIVATE)
        prefs.edit().putInt("autotrack_cooldown", minutes).apply()
    }

    @JavascriptInterface
    fun setSilentTrack(enabled: Boolean) {
        val prefs = activity.getSharedPreferences("wifimapper_prefs", android.content.Context.MODE_PRIVATE)
        prefs.edit().putBoolean("silent_track_enabled", enabled).apply()
    }

    @JavascriptInterface
    fun isSilentTrackEnabled(): Boolean {
        val prefs = activity.getSharedPreferences("wifimapper_prefs", android.content.Context.MODE_PRIVATE)
        return prefs.getBoolean("silent_track_enabled", false)
    }
}
