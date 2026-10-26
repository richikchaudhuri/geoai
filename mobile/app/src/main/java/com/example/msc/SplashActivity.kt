package com.example.msc

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Intent
import android.location.Geocoder
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import com.google.android.gms.location.LocationServices
import java.util.Locale
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource

class SplashActivity : AppCompatActivity() {

    private var locationReady = false
    private var minTimeReady = false
    private lateinit var loadingBarFill: View
    private var barWidth = 0
    private var isProceeding = false

    private val locationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            if (grants.values.any { it }) {
                updateProgress(40)
                fetchLocation()
            } else {
                updateProgress(80)
                locationReady = true
                checkAndProceed()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        val prefs = getSharedPreferences("msc_prefs", MODE_PRIVATE)
        val savedMode = prefs.getInt("theme_mode", AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
        AppCompatDelegate.setDefaultNightMode(savedMode)

        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_splash)

        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.splashRoot)) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }

        loadingBarFill = findViewById(R.id.loadingBarFill)

        loadingBarFill.post {
            barWidth = findViewById<View>(R.id.loadingBarTrack).width
            updateProgress(10)
            requestPermissions()
        }

        loadingBarFill.postDelayed({
            minTimeReady = true
            checkAndProceed()
        }, 2500)
    }

    private fun updateProgress(percent: Int) {
        if (barWidth == 0) return
        val targetWidth = (barWidth * percent / 100f).toInt()
        val currentWidth = loadingBarFill.layoutParams.width.coerceAtLeast(0)
        val anim = ValueAnimator.ofInt(currentWidth, targetWidth)
        anim.addUpdateListener {
            val lp = loadingBarFill.layoutParams
            lp.width = it.animatedValue as Int
            loadingBarFill.layoutParams = lp
        }
        anim.duration = 400
        anim.interpolator = AccelerateDecelerateInterpolator()
        anim.start()
    }

    private fun requestPermissions() {
        locationPermissionLauncher.launch(arrayOf(
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.ACCESS_COARSE_LOCATION
        ))
    }

    @SuppressLint("MissingPermission")
    private fun fetchLocation() {
        updateProgress(60)
        val fusedClient = LocationServices.getFusedLocationProviderClient(this)
        fusedClient.getCurrentLocation(
            Priority.PRIORITY_HIGH_ACCURACY,
            CancellationTokenSource().token
        ).addOnSuccessListener { location ->
            lifecycleScope.launch {
                updateProgress(100)
                if (location != null) {
                    val prefs = getSharedPreferences("msc_prefs", MODE_PRIVATE).edit()
                    prefs.putFloat("splash_lat", location.latitude.toFloat())
                    prefs.putFloat("splash_lng", location.longitude.toFloat())
                    prefs.putBoolean("splash_location_available", true)

                    // Pre-resolve address so it's ready before any photo
                    try {
                        val addresses = withContext(Dispatchers.IO) {
                            Geocoder(this@SplashActivity, Locale.getDefault())
                                .getFromLocation(location.latitude, location.longitude, 1)
                        }
                        if (!addresses.isNullOrEmpty()) {
                            val addr = addresses[0].getAddressLine(0)
                                ?: "${addresses[0].locality}, ${addresses[0].countryName}"
                            prefs.putString("splash_address", addr)
                        }
                    } catch (e: Exception) {
                        Log.e("SplashActivity", "Geocoder failed during splash", e)
                    }

                    prefs.apply()
                }
                locationReady = true
                checkAndProceed()
            }
        }.addOnFailureListener {
            updateProgress(100)
            locationReady = true
            checkAndProceed()
        }
    }

    private fun checkAndProceed() {
        if (locationReady && minTimeReady && !isProceeding && !isFinishing && !isDestroyed) {
            isProceeding = true
            updateProgress(100)
            loadingBarFill.postDelayed({
                if (isFinishing || isDestroyed) return@postDelayed
                startActivity(Intent(this, MainActivity::class.java))
                finish()
                if (android.os.Build.VERSION.SDK_INT >= 34) {
                    overrideActivityTransition(OVERRIDE_TRANSITION_OPEN,
                        android.R.anim.fade_in, android.R.anim.fade_out)
                } else {
                    @Suppress("DEPRECATION")
                    overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out)
                }
            }, 300)
        }
    }

}
