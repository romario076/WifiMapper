package com.melnykroman.wifimapper

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import android.Manifest
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.analytics.FirebaseAnalytics
import java.io.OutputStreamWriter
import java.io.BufferedReader
import java.io.InputStreamReader

class MainActivity : AppCompatActivity() {

    companion object {
        const val RC_SIGN_IN = 9001
    }

    private lateinit var auth: FirebaseAuth
    private lateinit var googleSignInClient: GoogleSignInClient
    private lateinit var webView: WebView
    private lateinit var analytics: FirebaseAnalytics
    private var webAppInterface: WebAppInterface? = null
    var pendingExportData: String? = null

    private val autoTrackReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == "com.melnykroman.wifimapper.AUTO_TRACK_EVENT") {
                val actionType = intent.getStringExtra("action")
                val ssid = intent.getStringExtra("ssid") ?: ""

                // Show an unobtrusive toast
                val msg = if (actionType == "AUTO_TRACK_NEW")
                    "Auto-Track: New network \"$ssid\" mapped!"
                else
                    "Auto-Track: Updated \"$ssid\" connection"
                Toast.makeText(this@MainActivity, msg, Toast.LENGTH_SHORT).show()

                // Delay re-fetch to ensure Firestore write is fully committed before reading
                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                    webAppInterface?.loadPoints()
                }, 2000)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Request core permissions (do NOT include ACCESS_BACKGROUND_LOCATION here –
        // on Android 10+ it must be requested separately after the others are granted)
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        ActivityCompat.requestPermissions(this, permissions.toTypedArray(), 100)

        // Firebase Analytics
        analytics = FirebaseAnalytics.getInstance(this)

        // Firebase Auth
        auth = FirebaseAuth.getInstance()

        // Google Sign-In options – request ID token for Firebase
        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(getString(R.string.default_web_client_id))
            .requestEmail()
            .requestProfile()
            .build()
        googleSignInClient = GoogleSignIn.getClient(this, gso)

        // Setup WebView
        webView = findViewById(R.id.webView)
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.setGeolocationEnabled(true)
        webView.webViewClient = WebViewClient()
        webView.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback
            ) {
                callback.invoke(origin, true, false)
            }
        }

        // Check if user is already signed in
        val currentUser = auth.currentUser
        if (currentUser != null) {
            initWebAppInterface()
            webView.loadUrl("file:///android_asset/index.html")

            // Automatically start background service if enabled from a previous session
            val prefs = getSharedPreferences("wifimapper_prefs", Context.MODE_PRIVATE)
            if (prefs.getBoolean("auto_track_enabled", false)) {
                val intent = Intent(this, WifiAutoTrackService::class.java)
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForegroundService(intent)
                    } else {
                        startService(intent)
                    }
                } catch (e: Exception) {
                    android.util.Log.e("MainActivity", "Failed to start auto-track: \${e.message}")
                }
            }
        } else {
            // Load login page first
            webView.loadUrl("file:///android_asset/index.html")
            initWebAppInterface()
        }
    }

    private fun initWebAppInterface() {
        webAppInterface = WebAppInterface(this, webView, auth, googleSignInClient)
        webView.addJavascriptInterface(webAppInterface!!, "Android")
    }

    // Called from WebAppInterface to start the sign-in intent
    fun startGoogleSignIn() {
        val signInIntent = googleSignInClient.signInIntent
        startActivityForResult(signInIntent, RC_SIGN_IN)
    }

    // Called from WebAppInterface to sign out
    fun performSignOut() {
        auth.signOut()
        googleSignInClient.signOut().addOnCompleteListener {
            webView.loadUrl("javascript:onSignedOut()")
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == RC_SIGN_IN) {
            val task = GoogleSignIn.getSignedInAccountFromIntent(data)
            try {
                val account = task.getResult(ApiException::class.java)
                val idToken = account.idToken ?: return
                firebaseAuthWithGoogle(idToken)
            } catch (e: ApiException) {
                Toast.makeText(this, "Sign-in failed: ${e.statusCode}", Toast.LENGTH_SHORT).show()
                webView.loadUrl("javascript:onSignInError('${e.statusCode}')")
            }
        }

        // Add Export
        if (requestCode == 9002 && resultCode == RESULT_OK) {
            data?.data?.let { uri ->
                try {
                    contentResolver.openOutputStream(uri)?.use { os ->
                        OutputStreamWriter(os).use { writer ->
                            writer.write(pendingExportData ?: "[]")
                        }
                    }
                    Toast.makeText(this, "Data exported successfully", Toast.LENGTH_SHORT).show()
                    pendingExportData = null
                } catch (e: Exception) {
                    Toast.makeText(this, "Export failed", Toast.LENGTH_SHORT).show()
                }
            }
        }

        // Add Import
        if (requestCode == 9003 && resultCode == RESULT_OK) {
            data?.data?.let { uri ->
                try {
                    contentResolver.openInputStream(uri)?.use { inputStream ->
                        BufferedReader(InputStreamReader(inputStream)).use { reader ->
                            val json = reader.readText()
                            val escaped = json.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "").replace("\r", "")
                            webView.post {
                                webView.evaluateJavascript("javascript:onImportReady('$escaped')", null)
                            }
                        }
                    }
                } catch (e: Exception) {
                    Toast.makeText(this, "Import failed", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun firebaseAuthWithGoogle(idToken: String) {
        val credential = GoogleAuthProvider.getCredential(idToken, null)
        auth.signInWithCredential(credential)
            .addOnCompleteListener(this) { task ->
                if (task.isSuccessful) {
                    val user = auth.currentUser!!
                    // Log login event to Analytics
                    analytics.logEvent(FirebaseAnalytics.Event.LOGIN, null)

                    // Start background service if enabled
                    val prefs = getSharedPreferences("wifimapper_prefs", Context.MODE_PRIVATE)
                    if (prefs.getBoolean("auto_track_enabled", false)) {
                        val intent = Intent(this@MainActivity, WifiAutoTrackService::class.java)
                        try {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                                startForegroundService(intent)
                            } else {
                                startService(intent)
                            }
                        } catch (e: Exception) {
                            android.util.Log.e("MainActivity", "Failed to start auto-track: \${e.message}")
                        }
                    }

                    // Notify JS
                    val name = user.displayName?.replace("'", "\\'") ?: ""
                    val email = user.email?.replace("'", "\\'") ?: ""
                    val photo = user.photoUrl?.toString() ?: ""
                    webView.loadUrl("javascript:onSignedIn('${user.uid}','$name','$email','$photo')")
                } else {
                    Toast.makeText(this, "Authentication failed.", Toast.LENGTH_SHORT).show()
                    webView.loadUrl("javascript:onSignInError('auth_failed')")
                }
            }
    }

    override fun onResume() {
        super.onResume()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(autoTrackReceiver, IntentFilter("com.melnykroman.wifimapper.AUTO_TRACK_EVENT"), Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(autoTrackReceiver, IntentFilter("com.melnykroman.wifimapper.AUTO_TRACK_EVENT"))
        }
    }

    override fun onPause() {
        super.onPause()
        unregisterReceiver(autoTrackReceiver)
    }
}