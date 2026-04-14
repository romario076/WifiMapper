package com.melnykroman.wifimapper

import android.content.Context
import android.net.wifi.WifiManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
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
            data["ownerId"] = uid

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

    // ── Friends System ─────────────────────────────────────────────────────

    @JavascriptInterface
    fun sendFriendRequest(rawEmail: String) {
        val myUid = auth.currentUser?.uid ?: return
        val emailToSearch = rawEmail.trim().lowercase()
        
        db.collection("Users").get()
            .addOnSuccessListener { allDocs ->
                
                if (emailToSearch == "debug@admin.com") {
                    val emails = allDocs.documents.mapNotNull { it.getString("email") }.joinToString(",\\n")
                    activity.runOnUiThread { webView.evaluateJavascript("customAlert('Emails in DB:\\n$emails')", null) }
                    return@addOnSuccessListener
                }

                // Manual case-insensitive search
                val targetDoc = allDocs.documents.firstOrNull { 
                    it.getString("email")?.trim()?.lowercase() == emailToSearch 
                }
                
                if (targetDoc == null) {
                    activity.runOnUiThread { webView.evaluateJavascript("onFriendActionError('User with this email not found')", null) }
                    return@addOnSuccessListener
                }
                
                val targetUid = targetDoc.id
                
                if (targetUid == myUid) {
                    activity.runOnUiThread { webView.evaluateJavascript("onFriendActionError('Cannot add yourself')", null) }
                    return@addOnSuccessListener
                }
                
                val friends = (targetDoc.get("friends") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
                val requests = (targetDoc.get("friendRequests") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
                
                if (friends.contains(myUid)) {
                    activity.runOnUiThread { webView.evaluateJavascript("onFriendActionError('You are already friends with this user')", null) }
                    return@addOnSuccessListener
                }
                
                if (requests.contains(myUid)) {
                    activity.runOnUiThread { webView.evaluateJavascript("onFriendActionError('Friend request already sent/pending')", null) }
                    return@addOnSuccessListener
                }
                
                db.collection("Users").document(targetUid)
                    .set(hashMapOf("friendRequests" to FieldValue.arrayUnion(myUid)), SetOptions.merge())
                    .addOnSuccessListener {
                        activity.runOnUiThread { webView.evaluateJavascript("onFriendActionSuccess('request_sent')", null) }
                    }
                    .addOnFailureListener { e ->
                        activity.runOnUiThread { webView.evaluateJavascript("onFriendActionError('DB Error: ${e.message}')", null) }
                    }
            }
            .addOnFailureListener { e ->
                activity.runOnUiThread { webView.evaluateJavascript("onFriendActionError('Failed to query users: ${e.message}')", null) }
            }
    }

    @JavascriptInterface
    fun acceptFriendRequest(friendUid: String) {
        val myUid = auth.currentUser?.uid ?: return
        val myRef = db.collection("Users").document(myUid)
        val friendRef = db.collection("Users").document(friendUid)
        
        db.runTransaction { tx ->
            tx.update(myRef, "friendRequests", FieldValue.arrayRemove(friendUid))
            tx.set(myRef, hashMapOf("friends" to FieldValue.arrayUnion(friendUid)), SetOptions.merge())
            tx.set(friendRef, hashMapOf("friends" to FieldValue.arrayUnion(myUid)), SetOptions.merge())
            null
        }.addOnSuccessListener {
            activity.runOnUiThread { webView.evaluateJavascript("onFriendActionSuccess('request_accepted')", null) }
        }
    }

    @JavascriptInterface
    fun rejectFriendRequest(friendUid: String) {
        val myUid = auth.currentUser?.uid ?: return
        db.collection("Users").document(myUid)
            .update("friendRequests", FieldValue.arrayRemove(friendUid))
            .addOnSuccessListener {
                activity.runOnUiThread { webView.evaluateJavascript("onFriendActionSuccess('request_rejected')", null) }
            }
    }

    @JavascriptInterface
    fun removeFriend(friendUid: String) {
        val myUid = auth.currentUser?.uid ?: return
        val myRef = db.collection("Users").document(myUid)
        val friendRef = db.collection("Users").document(friendUid)
        
        db.runTransaction { tx ->
            tx.update(myRef, "friends", FieldValue.arrayRemove(friendUid))
            tx.update(friendRef, "friends", FieldValue.arrayRemove(myUid))
            null
        }.addOnSuccessListener {
            activity.runOnUiThread { webView.evaluateJavascript("onFriendActionSuccess('friend_removed')", null) }
        }.addOnFailureListener { e ->
            activity.runOnUiThread { webView.evaluateJavascript("onFriendActionError('Failed to remove friend: ${e.message}')", null) }
        }
    }

    @JavascriptInterface
    fun updateActivity() {
        val myUid = auth.currentUser?.uid ?: return
        db.collection("Users").document(myUid)
            .set(hashMapOf("lastActive" to System.currentTimeMillis()), SetOptions.merge())
    }

    @JavascriptInterface
    fun fetchFriendData() {
        val myUid = auth.currentUser?.uid ?: return
        db.collection("Users").document(myUid).get()
            .addOnSuccessListener { doc ->
                // Ensure safe unchecked cast logic
                val requests = (doc.get("friendRequests") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
                val friends = (doc.get("friends") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
                
                val allUids = (requests + friends).distinct().take(10)
                if (allUids.isEmpty()) {
                    pushFriendDataToJS(requests, friends, emptyList())
                    return@addOnSuccessListener
                }
                
                db.collection("Users").whereIn(com.google.firebase.firestore.FieldPath.documentId(), allUids).get()
                    .addOnSuccessListener { snapshot ->
                        pushFriendDataToJS(requests, friends, snapshot.documents)
                    }
            }
    }
    
    private fun pushFriendDataToJS(requests: List<String>, friends: List<String>, userDocs: List<com.google.firebase.firestore.DocumentSnapshot>) {
        val usersJson = JSONObject()
        for (doc in userDocs) {
            val uid = doc.id
            val obj = JSONObject().apply {
                put("email", doc.getString("email") ?: "")
                put("displayName", doc.getString("displayName") ?: "")
                put("photoUrl", doc.getString("photoUrl") ?: "")
                put("lastActive", doc.getLong("lastActive") ?: 0L)
            }
            usersJson.put(uid, obj)
        }
        
        val payload = JSONObject().apply {
            put("requests", JSONArray(requests))
            put("friends", JSONArray(friends))
            put("profiles", usersJson)
        }
        
        val b64 = android.util.Base64.encodeToString(
            payload.toString().toByteArray(Charsets.UTF_8),
            android.util.Base64.NO_WRAP
        )
        activity.runOnUiThread {
            webView.evaluateJavascript("onFriendDataReceived(decodeURIComponent(escape(atob('$b64'))))", null)
        }
    }

    @JavascriptInterface
    fun fetchAllFriendPoints() {
        val myUid = auth.currentUser?.uid ?: return
        db.collection("Users").document(myUid).get()
            .addOnSuccessListener { doc ->
                val friends = (doc.get("friends") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
                if (friends.isEmpty()) {
                    activity.runOnUiThread { webView.evaluateJavascript("onFriendPointsLoaded('[]')", null) }
                    return@addOnSuccessListener
                }
                
                val allPoints = JSONArray()
                var pending = friends.size
                
                for (friendId in friends) {
                    db.collection("users").document(friendId).collection("points")
                        .get()
                        .addOnSuccessListener { snapshot ->
                            for (pDoc in snapshot.documents) {
                                val isPrivate = pDoc.getBoolean("isPrivate") ?: false
                                if (isPrivate) continue
                                
                                val data = pDoc.data ?: continue
                                val pt = org.json.JSONObject(data).apply {
                                    put("id", pDoc.id)
                                    put("isFriendPoint", true)
                                    put("ownerId", friendId)
                                }
                                allPoints.put(pt)
                            }
                            pending--
                            if (pending == 0) sendPointsToJS(allPoints)
                        }
                        .addOnFailureListener {
                            pending--
                            if (pending == 0) sendPointsToJS(allPoints)
                        }
                }
            }
    }
    
    private fun sendPointsToJS(arr: JSONArray) {
        val b64 = android.util.Base64.encodeToString(
             arr.toString().toByteArray(Charsets.UTF_8),
             android.util.Base64.NO_WRAP
        )
        activity.runOnUiThread {
             webView.evaluateJavascript("onFriendPointsLoaded(decodeURIComponent(escape(atob('$b64'))))", null)
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

    @JavascriptInterface
    fun setAutoTrackPrivate(enabled: Boolean) {
        val prefs = activity.getSharedPreferences("wifimapper_prefs", android.content.Context.MODE_PRIVATE)
        prefs.edit().putBoolean("autotrack_private", enabled).apply()
    }

    @JavascriptInterface
    fun isAutoTrackPrivate(): Boolean {
        val prefs = activity.getSharedPreferences("wifimapper_prefs", android.content.Context.MODE_PRIVATE)
        return prefs.getBoolean("autotrack_private", false)
    }
}
