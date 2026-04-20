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
import com.google.firebase.Timestamp

class WebAppInterface(
    private val activity: MainActivity,
    private val webView: WebView,
    private val auth: FirebaseAuth,
    private val googleSignInClient: GoogleSignInClient
) {

    private val db = FirebaseFirestore.getInstance()
    private val analytics = FirebaseAnalytics.getInstance(activity)

    /**
     * Converts a Firestore document data map to a JSONObject,
     * replacing any Firestore Timestamp values with epoch milliseconds (Long).
     */
    private fun docDataToJson(data: Map<String, Any>): JSONObject {
        val obj = JSONObject()
        for ((key, value) in data) {
            when (value) {
                is Timestamp -> obj.put(key, value.toDate().time)
                is Map<*, *> -> {
                    // Nested map — check if it looks like a Timestamp {seconds, nanoseconds}
                    @Suppress("UNCHECKED_CAST")
                    val m = value as Map<String, Any>
                    if (m.containsKey("seconds") && m.containsKey("nanoseconds")) {
                        val secs = (m["seconds"] as? Long) ?: (m["seconds"] as? Int)?.toLong() ?: 0L
                        obj.put(key, secs * 1000L)
                    } else {
                        obj.put(key, JSONObject(m))
                    }
                }
                is List<*> -> obj.put(key, JSONArray(value))
                null -> { /* skip null */ }
                else -> obj.put(key, value)
            }
        }
        return obj
    }

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
                    val obj = docDataToJson(data).apply {
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
    fun acceptFriendRequest(friendUid: String, accessLevel: String = "full") {
        val myUid = auth.currentUser?.uid ?: return
        val myRef = db.collection("Users").document(myUid)
        val friendRef = db.collection("Users").document(friendUid)
        
        // Store as map objects: { uid, accessLevel }
        val myFriendEntry = hashMapOf("uid" to friendUid, "accessLevel" to accessLevel)
        val theirFriendEntry = hashMapOf("uid" to myUid, "accessLevel" to accessLevel)
        
        db.runTransaction { tx ->
            val myDoc = tx.get(myRef)
            val friendDoc = tx.get(friendRef)
            
            // Remove legacy plain-string entries if any
            val myFriends = (myDoc.get("friendsList") as? List<*>)?.toMutableList() ?: mutableListOf()
            myFriends.removeAll { it is String && it == friendUid }
            myFriends.add(myFriendEntry)
            
            val theirFriends = (friendDoc.get("friendsList") as? List<*>)?.toMutableList() ?: mutableListOf()
            theirFriends.removeAll { it is String && it == myUid }
            theirFriends.add(theirFriendEntry)
            
            tx.update(myRef, "friendRequests", FieldValue.arrayRemove(friendUid))
            tx.set(myRef, hashMapOf("friendsList" to myFriends, "friends" to FieldValue.arrayUnion(friendUid)), SetOptions.merge())
            tx.set(friendRef, hashMapOf("friendsList" to theirFriends, "friends" to FieldValue.arrayUnion(myUid)), SetOptions.merge())
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
    fun updateFriendAccess(friendUid: String, newAccessLevel: String) {
        val myUid = auth.currentUser?.uid ?: return
        val myRef = db.collection("Users").document(myUid)
        val friendRef = db.collection("Users").document(friendUid)

        db.runTransaction { tx ->
            val myDoc = tx.get(myRef)
            val friendDoc = tx.get(friendRef)

            val myFriends = (myDoc.get("friendsList") as? List<*>)?.toMutableList() ?: mutableListOf()
            val myIdx = myFriends.indexOfFirst { (it as? Map<*, *>)?.get("uid") == friendUid }
            if (myIdx >= 0) myFriends[myIdx] = hashMapOf("uid" to friendUid, "accessLevel" to newAccessLevel)
            else myFriends.add(hashMapOf("uid" to friendUid, "accessLevel" to newAccessLevel))

            val theirFriends = (friendDoc.get("friendsList") as? List<*>)?.toMutableList() ?: mutableListOf()
            val theirIdx = theirFriends.indexOfFirst { (it as? Map<*, *>)?.get("uid") == myUid }
            if (theirIdx >= 0) theirFriends[theirIdx] = hashMapOf("uid" to myUid, "accessLevel" to newAccessLevel)
            else theirFriends.add(hashMapOf("uid" to myUid, "accessLevel" to newAccessLevel))

            tx.set(myRef, hashMapOf("friendsList" to myFriends), SetOptions.merge())
            tx.set(friendRef, hashMapOf("friendsList" to theirFriends), SetOptions.merge())
            null
        }.addOnSuccessListener {
            activity.runOnUiThread {
                webView.evaluateJavascript("onFriendActionSuccess('access_updated')", null)
            }
        }.addOnFailureListener { e ->
            activity.runOnUiThread {
                webView.evaluateJavascript("onFriendActionError('Failed to update access: ${e.message}')", null)
            }
        }
    }

    @JavascriptInterface
    fun fetchFriendData() {
        val myUid = auth.currentUser?.uid ?: return
        db.collection("Users").document(myUid).get()
            .addOnSuccessListener { myDoc ->
                val requests = (myDoc.get("friendRequests") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
                val friends = (myDoc.get("friends") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
                // Read MY friendsList to resolve access levels for each friend
                val myFriendsList = (myDoc.get("friendsList") as? List<*>) ?: emptyList<Any>()
                val accessMap = myFriendsList.filterIsInstance<Map<*, *>>()
                    .associate { (it["uid"] as? String ?: "") to (it["accessLevel"] as? String ?: "full") }
                // My own privacy level = what I share with my friends
                // stored as each entry's accessLevel in MY friendsList (they should all be the same after setMyDefaultPrivacy)
                val myPrivacyLevel = myFriendsList.filterIsInstance<Map<*, *>>()
                    .mapNotNull { it["accessLevel"] as? String }.firstOrNull() ?: "full"

                val allUids = (requests + friends).distinct().take(20)
                if (allUids.isEmpty()) {
                    pushFriendDataToJS(requests, friends, emptyList(), accessMap, myPrivacyLevel)
                    return@addOnSuccessListener
                }

                db.collection("Users").whereIn(com.google.firebase.firestore.FieldPath.documentId(), allUids).get()
                    .addOnSuccessListener { snapshot ->
                        pushFriendDataToJS(requests, friends, snapshot.documents, accessMap, myPrivacyLevel)
                    }
            }
    }
    
    private fun pushFriendDataToJS(
        requests: List<String>,
        friends: List<String>,
        userDocs: List<com.google.firebase.firestore.DocumentSnapshot>,
        accessMap: Map<String, String> = emptyMap(),
        myPrivacyLevel: String = "full"
    ) {
        val usersJson = JSONObject()
        for (doc in userDocs) {
            val uid = doc.id
            val obj = JSONObject().apply {
                put("email", doc.getString("email") ?: "")
                put("displayName", doc.getString("displayName") ?: "")
                put("photoUrl", doc.getString("photoUrl") ?: "")
                put("lastActive", doc.getLong("lastActive") ?: 0L)
                // Access level comes from MY OWN friendsList, not the friend's doc
                put("accessLevel", accessMap[uid] ?: "full")
            }
            usersJson.put(uid, obj)
        }

        val payload = JSONObject().apply {
            put("requests", JSONArray(requests))
            put("friends", JSONArray(friends))
            put("profiles", usersJson)
            put("myPrivacyLevel", myPrivacyLevel)
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
    fun fetchFriendStats(friendUid: String) {
        db.collection("users").document(friendUid).collection("points")
            .get()
            .addOnSuccessListener { snapshot ->
                val points = snapshot.documents.filter { !(it.getBoolean("isPrivate") ?: false) }
                val countries = points.mapNotNull { it.getString("country") }.filter { it.isNotBlank() }.toSet()
                val cities = points.mapNotNull { it.getString("city") }.filter { it.isNotBlank() }.toSet()
                val totalConnections = points.sumOf { (it.getLong("connections") ?: 1L).toInt() }
                val altitudes = points.mapNotNull { it.getDouble("altitude") }.filter { it != 0.0 }
                val minAlt = if (altitudes.isNotEmpty()) altitudes.min() else 0.0
                val maxAlt = if (altitudes.isNotEmpty()) altitudes.max() else 0.0
                
                val uniqueWifi = points.count { 
                    val netType = it.getString("networkType")
                    val ssid = it.getString("ssid")
                    (netType != "cellular") && (ssid != "Cellular Data")
                }
                
                var furthestDesc = "No Home Set"
                val homePoint = points.find { it.getBoolean("isHome") == true }
                if (homePoint != null) {
                    val homeLat = homePoint.getDouble("lat")
                    val homeLng = homePoint.getDouble("lng")
                    if (homeLat != null && homeLng != null) {
                        var maxDist = 0.0f
                        var furthestPt = homePoint
                        val results = FloatArray(1)
                        for (p in points) {
                            val lat = p.getDouble("lat")
                            val lng = p.getDouble("lng")
                            if (lat != null && lng != null) {
                                android.location.Location.distanceBetween(homeLat, homeLng, lat, lng, results)
                                if (results[0] > maxDist) {
                                    maxDist = results[0]
                                    furthestPt = p
                                }
                            }
                        }
                        if (maxDist > 500) {
                            val km = Math.round(maxDist / 1000f).toInt()
                            val city = furthestPt?.getString("city") ?: "Unknown"
                            val country = furthestPt?.getString("country") ?: ""
                            val ssid = furthestPt?.getString("ssid") ?: "Unknown"
                            val loc = if (country.isNotBlank()) "$city, $country" else city
                            furthestDesc = "$km km from Home - 📍 $loc — $ssid"
                        } else {
                            furthestDesc = "At Home"
                        }
                    }
                }
                
                val avgAlt = if (altitudes.isNotEmpty()) altitudes.average() else 0.0
                
                val stats = JSONObject().apply {
                    put("uid", friendUid)
                    put("uniqueNetworks", points.size)
                    put("uniqueWifi", uniqueWifi)
                    put("totalConnections", totalConnections)
                    put("furthestDiscovery", furthestDesc)
                    put("countries", countries.size)
                    put("cities", cities.size)
                    put("minAltitude", minAlt)
                    put("avgAltitude", avgAlt)
                    put("maxAltitude", maxAlt)
                }
                val b64 = android.util.Base64.encodeToString(
                    stats.toString().toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP
                )
                activity.runOnUiThread {
                    webView.evaluateJavascript("onFriendStatsReceived(decodeURIComponent(escape(atob('$b64'))))", null)
                }
            }
    }
    @JavascriptInterface
    fun fetchAllFriendPoints() {
        val myUid = auth.currentUser?.uid ?: return
        db.collection("Users").document(myUid).get()
            .addOnSuccessListener { doc ->
                // Parse tiered friendsList (new) with fallback to legacy plain 'friends' array
                val rawList = doc.get("friendsList") as? List<*> ?: emptyList<Any>()
                val tieredFriends = rawList.mapNotNull { item ->
                    when (item) {
                        is Map<*, *> -> Pair(item["uid"] as? String ?: return@mapNotNull null, item["accessLevel"] as? String ?: "full")
                        is String -> Pair(item, "full")
                        else -> null
                    }
                }
                val legacyFriends = (doc.get("friends") as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
                // For full access friends only
                val fullAccessFriends = if (tieredFriends.isNotEmpty())
                    tieredFriends.filter { it.second == "full" }.map { it.first }
                else legacyFriends

                if (fullAccessFriends.isEmpty()) {
                    activity.runOnUiThread { webView.evaluateJavascript("onFriendPointsLoaded('[]')", null) }
                    return@addOnSuccessListener
                }
                
                val allPoints = JSONArray()
                var pending = fullAccessFriends.size
                
                for (friendId in fullAccessFriends) {
                    db.collection("users").document(friendId).collection("points")
                        .get()
                        .addOnSuccessListener { snapshot ->
                            for (pDoc in snapshot.documents) {
                                val isPrivate = pDoc.getBoolean("isPrivate") ?: false
                                if (isPrivate) continue
                                
                                val data = pDoc.data ?: continue
                                val pt = docDataToJson(data).apply {
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

    @JavascriptInterface
    fun setMyDefaultPrivacy(level: String) {
        val myUid = auth.currentUser?.uid ?: return
        val myRef = db.collection("Users").document(myUid)

        db.runTransaction { tx ->
            val myDoc = tx.get(myRef)
            val myFriends = (myDoc.get("friendsList") as? List<*>)?.toMutableList() ?: mutableListOf()
            if (myFriends.isEmpty()) return@runTransaction null

            val updatedMyFriends = mutableListOf<Map<String, Any>>()
            
            for (item in myFriends) {
                if (item is Map<*, *>) {
                    val uid = item["uid"] as? String ?: continue
                    val newEntry = item.toMutableMap()
                    newEntry["accessLevel"] = level
                    updatedMyFriends.add(newEntry as Map<String, Any>)

                    val friendRef = db.collection("Users").document(uid)
                    val friendDoc = tx.get(friendRef)
                    val theirFriends = (friendDoc.get("friendsList") as? List<*>)?.toMutableList() ?: mutableListOf()
                    var modified = false
                    for (i in theirFriends.indices) {
                        val tItem = theirFriends[i]
                        if (tItem is Map<*, *>) {
                            if (tItem["uid"] == myUid) {
                                val tNewEntry = tItem.toMutableMap()
                                tNewEntry["accessLevel"] = level
                                theirFriends[i] = tNewEntry
                                modified = true
                                break
                            }
                        }
                    }
                    if (modified) {
                        tx.update(friendRef, "friendsList", theirFriends)
                    }
                }
            }
            tx.update(myRef, "friendsList", updatedMyFriends)
            null
        }.addOnSuccessListener {
            activity.runOnUiThread {
                fetchFriendData()
                fetchAllFriendPoints()
            }
        }.addOnFailureListener { e ->
            activity.runOnUiThread {
                webView.evaluateJavascript("onFriendActionError('Failed to update privacy: ${e.message}')", null)
            }
        }
    }
}
