package com.example.msc

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.ContentValues
import android.content.Intent
import android.location.Geocoder
import android.location.LocationManager
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.transition.AutoTransition
import androidx.transition.TransitionManager
import com.example.msc.databinding.ActivityMainBinding
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import org.osmdroid.config.Configuration
import org.osmdroid.tileprovider.tilesource.TileSourceFactory
import org.osmdroid.util.GeoPoint
import org.osmdroid.views.overlay.Marker
import android.app.Dialog
import android.content.Context
import android.content.DialogInterface
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.KeyEvent
import android.view.Window
import android.view.WindowManager
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import android.widget.ViewFlipper
import androidx.appcompat.app.AppCompatDelegate
import androidx.cardview.widget.CardView
import androidx.exifinterface.media.ExifInterface
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import org.osmdroid.views.MapView
import java.text.SimpleDateFormat
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var imageCapture: ImageCapture? = null
    private var lastPhotoUri: Uri? = null
    private var lastKnownLat: Double? = null
    private var lastKnownLng: Double? = null
    private var lastKnownAddress: String? = null
    private var locationPanelExpanded = false
    private var breathingAnimator: ObjectAnimator? = null
    private var locationFetched = false
    private val idleHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val idleDismissRunnable = Runnable { hideLocationPanel() }
    private var shutterCooldownEnd = 0L
    private var cooldownTimer: android.os.CountDownTimer? = null
    private var flashPillDismissRunnable: Runnable? = null
    private var settingsDialog: Dialog? = null
    private var galleryDialog: Dialog? = null

    // Periodic location refresh — industry standard for moving-user mapping is
    // 5–15s; we use 10s. Pauses when activity is backgrounded to save battery.
    private val LOCATION_REFRESH_INTERVAL_MS = 10_000L
    private val LOCATION_FASTEST_INTERVAL_MS = 5_000L
    private var fusedLocationClient: FusedLocationProviderClient? = null
    private var locationCallback: LocationCallback? = null
    private var locationUpdatesActive = false
    private var lastGeocodedLat: Double? = null
    private var lastGeocodedLng: Double? = null

    // Flash state — cycles OFF → ON → AUTO → OFF
    private var flashMode: Int = ImageCapture.FLASH_MODE_OFF

    // Live preview luminance (0..255) — used to nudge users to enable flash
    // when the scene gets dim. Captured via CameraX ImageAnalysis.
    private var lastLuminance: Float = 255f
    private var lastLowLightHintAt: Long = 0L
    private val LOW_LIGHT_THRESHOLD_LUX = 80f       // below = dim
    private val LOW_LIGHT_HINT_COOLDOWN_MS = 8_000L // re-show window

    private val cropLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == RESULT_OK) {
                val croppedUriStr = result.data?.getStringExtra("cropped_uri")
                if (croppedUriStr != null) {
                    val croppedUri = Uri.parse(croppedUriStr)
                    lastPhotoUri = croppedUri
                    updateThumbnail(croppedUri)
                    showUploadPill()
                    performUpload(croppedUri)
                }
            }
        }

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                startCamera()
            } else {
                Toast.makeText(this, "Camera permission is required", Toast.LENGTH_LONG).show()
                finish()
            }
        }

    private val locationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                showLocationPanel()
                // Only call fetchLocation() if we don't already have a fix
                if (!locationFetched) fetchLocation()
            } else {
                Toast.makeText(this, "Location permission denied", Toast.LENGTH_SHORT).show()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Apply saved theme before super
        val prefs = getSharedPreferences("msc_prefs", MODE_PRIVATE)
        val savedMode = prefs.getInt("theme_mode", AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
        AppCompatDelegate.setDefaultNightMode(savedMode)

        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // OSMDroid config
        Configuration.getInstance().userAgentValue = packageName

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Init location map tile source
        binding.locationMapView.setTileSource(TileSourceFactory.MAPNIK)
        binding.locationMapView.setMultiTouchControls(false)

        ViewCompat.setOnApplyWindowInsetsListener(binding.main) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }

        setupShutterButton()
        setupLocationPanel()
        binding.thumbnailButton.setOnClickListener { showGalleryDialog() }
        binding.locationButton.setOnClickListener { onLocationButtonTapped() }
        binding.settingsButton.setOnClickListener { showSettingsDialog() }
        setupFlashButton()

        // setBackgroundBlurRadius requires API 31+ (Android 12). Older
        // devices simply skip the blur — non-critical aesthetic.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
            window.setBackgroundBlurRadius(40)
        }

        cameraPermissionLauncher.launch(android.Manifest.permission.CAMERA)

        // Seed from splash if available, then always refresh in background
        val prefs2 = getSharedPreferences("msc_prefs", MODE_PRIVATE)
        if (prefs2.getBoolean("splash_location_available", false)) {
            lastKnownLat = prefs2.getFloat("splash_lat", 0f).toDouble()
            lastKnownLng = prefs2.getFloat("splash_lng", 0f).toDouble()
            lastKnownAddress = prefs2.getString("splash_address", null)
            locationFetched = true
            prefs2.edit().remove("splash_location_available").remove("splash_address").apply()
        }
        // Always kick off a fresh background fetch (geocoding included)
        fetchLocationInBackground()

        // Restore shutter cooldown so closing the app doesn't reset the
        // 6s rate limit. Only honour timestamps that are still in the future.
        val savedCooldown = prefs2.getLong("shutter_cooldown_end", 0L)
        if (savedCooldown > System.currentTimeMillis()) {
            shutterCooldownEnd = savedCooldown
        }
    }

    // ── Location Panel ──

    private fun setupLocationPanel() {
        // Tap collapsed row → expand
        binding.locationCollapsedRow.setOnClickListener {
            if (!locationPanelExpanded) {
                expandLocationPanel()
            } else {
                collapseLocationPanel()
            }
        }

        // Setup map
        binding.locationMapView.setTileSource(TileSourceFactory.MAPNIK)
        binding.locationMapView.setMultiTouchControls(false)
        binding.locationMapView.isHorizontalScrollBarEnabled = false
        binding.locationMapView.isVerticalScrollBarEnabled = false
    }

    private fun isLocationEnabled(): Boolean {
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }

    private fun onLocationButtonTapped() {
        val panel = binding.locationPanel
        if (panel.visibility == View.GONE) {
            if (isLocationEnabled()) {
                locationPermissionLauncher.launch(android.Manifest.permission.ACCESS_FINE_LOCATION)
            } else {
                showLocationPanelOffline()
            }
        } else {
            hideLocationPanel()
        }
    }

    private fun showLocationPanel() {
        dismissCooldownPillInstantly()
        dismissUploadPillInstantly()
        dismissFlashPillInstantly()

        val panel = binding.locationPanel
        panel.visibility = View.VISIBLE
        panel.alpha = 0f
        panel.translationY = -80f
        panel.scaleX = 0.85f
        panel.scaleY = 0.85f
        panel.animate()
            .alpha(1f)
            .translationY(0f)
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(350)
            .setInterpolator(OvershootInterpolator(1.2f))
            .start()
        locationPanelExpanded = false
        binding.locationExpandedDetails.visibility = View.GONE

        // Online state
        binding.greenDot.setBackgroundResource(R.drawable.green_dot)
        binding.locationStatusText.text = "Location Online"
        binding.locationStatusText.setTextColor(0xFF4CAF50.toInt())
        binding.mapOfflineOverlay.visibility = View.GONE

        val lat = lastKnownLat
        val lng = lastKnownLng
        if (lat != null && lng != null) {
            // Already have data — show it immediately
            binding.locationCoordinates.text = String.format(Locale.US, "%.6f, %.6f", lat, lng)
            binding.locationAddress.text = lastKnownAddress ?: "Resolving address…"
            binding.locationTime.text = ""

            val point = GeoPoint(lat, lng)
            binding.locationMapView.controller.setZoom(17.0)
            binding.locationMapView.controller.setCenter(point)
            binding.locationMapView.overlays.clear()
            val marker = Marker(binding.locationMapView)
            marker.position = point
            marker.setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
            binding.locationMapView.overlays.add(marker)
            binding.locationMapView.invalidate()
        } else {
            // Still fetching
            binding.locationCoordinates.text = "Fetching…"
            binding.locationAddress.text = "Locating…"
            binding.locationTime.text = ""
        }

        startBreathingDot()
        resetIdleTimer()
    }

    private fun showLocationPanelOffline() {
        dismissCooldownPillInstantly()
        dismissUploadPillInstantly()
        dismissFlashPillInstantly()

        val panel = binding.locationPanel
        panel.visibility = View.VISIBLE
        panel.alpha = 0f
        panel.translationY = -80f
        panel.scaleX = 0.85f
        panel.scaleY = 0.85f
        panel.animate()
            .alpha(1f)
            .translationY(0f)
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(350)
            .setInterpolator(OvershootInterpolator(1.2f))
            .start()
        locationPanelExpanded = false
        binding.locationExpandedDetails.visibility = View.GONE

        // Offline state
        binding.greenDot.setBackgroundResource(R.drawable.red_dot)
        binding.locationStatusText.text = "Location Unavailable"
        binding.locationStatusText.setTextColor(0xFFF44336.toInt())
        binding.mapOfflineOverlay.visibility = View.VISIBLE
        binding.locationCoordinates.text = "—"
        binding.locationAddress.text = "Turn on Location Services"
        binding.locationTime.text = ""

        startBreathingDot()
        resetIdleTimer()
    }

    private fun expandLocationPanel() {
        val transition = AutoTransition().apply {
            duration = 250
            interpolator = DecelerateInterpolator()
        }
        TransitionManager.beginDelayedTransition(binding.locationPanel, transition)
        binding.locationExpandedDetails.visibility = View.VISIBLE
        locationPanelExpanded = true
        cancelIdleTimer()

        // Rotate chevron

        // Update time
        val timeFormat = SimpleDateFormat("hh:mm a  ·  MMM dd, yyyy", Locale.getDefault())
        binding.locationTime.text = timeFormat.format(System.currentTimeMillis())

        // Refresh map layout
        binding.locationMapView.post { binding.locationMapView.invalidate() }
    }

    private fun collapseLocationPanel() {
        val transition = AutoTransition().apply {
            duration = 200
            interpolator = AccelerateDecelerateInterpolator()
        }
        TransitionManager.beginDelayedTransition(binding.locationPanel, transition)
        binding.locationExpandedDetails.visibility = View.GONE
        locationPanelExpanded = false
        resetIdleTimer()
    }

    private fun hideLocationPanel() {
        val panel = binding.locationPanel
        panel.animate()
            .alpha(0f)
            .translationY(-60f)
            .scaleX(0.9f)
            .scaleY(0.9f)
            .setDuration(250)
            .setInterpolator(AccelerateDecelerateInterpolator())
            .withEndAction {
                panel.visibility = View.GONE
                panel.translationY = 0f
                panel.scaleX = 1f
                panel.scaleY = 1f
                locationPanelExpanded = false
                binding.locationExpandedDetails.visibility = View.GONE
                    }
            .start()
        stopBreathingDot()
        cancelIdleTimer()
    }

    private fun startBreathingDot() {
        breathingAnimator?.cancel()
        breathingAnimator = ObjectAnimator.ofFloat(binding.greenDot, "alpha", 1f, 0.3f).apply {
            duration = 1200
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            interpolator = AccelerateDecelerateInterpolator()
            start()
        }
    }

    private fun stopBreathingDot() {
        breathingAnimator?.cancel()
        breathingAnimator = null
    }

    private fun resetIdleTimer() {
        idleHandler.removeCallbacks(idleDismissRunnable)
        idleHandler.postDelayed(idleDismissRunnable, 5000)
    }

    private fun cancelIdleTimer() {
        idleHandler.removeCallbacks(idleDismissRunnable)
    }

    // ── Shutter Cooldown ──

    private fun onShutterPressed() {
        val now = System.currentTimeMillis()
        val remaining = shutterCooldownEnd - now

        if (remaining > 0) {
            // Still in cooldown — show pill with current countdown + shake
            showCooldownPill(remaining)
            shakeCooldownPill()
            return
        }

        // Take the photo and start cooldown
        takePhoto()
        shutterCooldownEnd = System.currentTimeMillis() + 6000
        // Persist so user can't reset the cooldown by killing the app
        getSharedPreferences("msc_prefs", MODE_PRIVATE).edit()
            .putLong("shutter_cooldown_end", shutterCooldownEnd).apply()
    }

    private fun showCooldownPill(remainingMs: Long) {
        // Dismiss other pills instantly if visible
        dismissLocationPillInstantly()
        dismissUploadPillInstantly()
        dismissFlashPillInstantly()

        val pill = binding.cooldownPill
        val seconds = ((remainingMs + 999) / 1000).toInt()
        pill.text = "Wait ${seconds}s"

        if (pill.visibility == View.GONE) {
            pill.visibility = View.VISIBLE
            pill.alpha = 0f
            pill.translationY = -80f
            pill.scaleX = 0.85f
            pill.scaleY = 0.85f
            pill.animate()
                .alpha(1f)
                .translationY(0f)
                .scaleX(1f)
                .scaleY(1f)
                .setDuration(350)
                .setInterpolator(OvershootInterpolator(1.2f))
                .start()

            // Start countdown to update text and auto-hide
            cooldownTimer?.cancel()
            cooldownTimer = object : android.os.CountDownTimer(remainingMs, 100) {
                override fun onTick(millisUntilFinished: Long) {
                    val s = ((millisUntilFinished + 999) / 1000).toInt()
                    pill.text = "Wait ${s}s"
                }

                override fun onFinish() {
                    hideCooldownPill()
                }
            }.start()
        } else {
            pill.text = "Wait ${seconds}s"
        }
    }

    private fun hideCooldownPill() {
        cooldownTimer?.cancel()
        cooldownTimer = null
        val pill = binding.cooldownPill
        pill.animate()
            .alpha(0f)
            .translationY(-60f)
            .scaleX(0.9f)
            .scaleY(0.9f)
            .setDuration(250)
            .setInterpolator(AccelerateDecelerateInterpolator())
            .withEndAction {
                pill.visibility = View.GONE
                pill.translationY = 0f
                pill.scaleX = 1f
                pill.scaleY = 1f
            }
            .start()
    }

    private fun dismissCooldownPillInstantly() {
        cooldownTimer?.cancel()
        cooldownTimer = null
        binding.cooldownPill.animate().cancel()
        binding.cooldownPill.visibility = View.GONE
        binding.cooldownPill.alpha = 1f
        binding.cooldownPill.translationY = 0f
        binding.cooldownPill.scaleX = 1f
        binding.cooldownPill.scaleY = 1f
    }

    private fun dismissLocationPillInstantly() {
        if (binding.locationPanel.visibility == View.VISIBLE) {
            binding.locationPanel.animate().cancel()
            binding.locationPanel.visibility = View.GONE
            binding.locationPanel.alpha = 1f
            binding.locationPanel.translationY = 0f
            binding.locationPanel.scaleX = 1f
            binding.locationPanel.scaleY = 1f
            locationPanelExpanded = false
            binding.locationExpandedDetails.visibility = View.GONE
            stopBreathingDot()
            cancelIdleTimer()
        }
    }

    private fun shakeCooldownPill() {
        val pill = binding.cooldownPill
        // Red glow pulse
        pill.animate().cancel()
        ObjectAnimator.ofFloat(pill, "translationX", 0f, -12f, 12f, -10f, 10f, -6f, 6f, 0f)
            .apply {
                duration = 400
                interpolator = DecelerateInterpolator()
                start()
            }
        // Brief red glow alpha pulse
        ObjectAnimator.ofFloat(pill, "alpha", 1f, 0.6f, 1f).apply {
            duration = 300
            start()
        }
    }

    @SuppressLint("MissingPermission")
    private fun fetchLocation() {
        val fusedClient = LocationServices.getFusedLocationProviderClient(this)
        val cancellationToken = CancellationTokenSource()

        fusedClient.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cancellationToken.token)
            .addOnSuccessListener { location ->
                if (location != null) {
                    val lat = location.latitude
                    val lng = location.longitude
                    lastKnownLat = lat
                    lastKnownLng = lng
                    locationFetched = true

                    binding.locationCoordinates.text =
                        String.format(Locale.US, "%.6f, %.6f", lat, lng)

                    // Reverse geocode off the main thread — the platform
                    // geocoder can block for several seconds and trigger an
                    // ANR if hit on UI thread.
                    binding.locationAddress.text = "Resolving address…"
                    lifecycleScope.launch(kotlinx.coroutines.Dispatchers.IO) {
                        var resolved: String? = null
                        var unavailable = false
                        try {
                            val addresses = Geocoder(this@MainActivity, Locale.getDefault())
                                .getFromLocation(lat, lng, 1)
                            if (!addresses.isNullOrEmpty()) {
                                resolved = addresses[0].getAddressLine(0)
                                    ?: "${addresses[0].locality}, ${addresses[0].countryName}"
                            }
                        } catch (e: Exception) {
                            unavailable = true
                            Log.w(TAG, "Geocoder failed", e)
                        }
                        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                            if (resolved != null) {
                                binding.locationAddress.text = resolved
                                lastKnownAddress = resolved
                            } else {
                                binding.locationAddress.text =
                                    if (unavailable) "Geocoder unavailable" else "Address not found"
                            }
                        }
                    }

                    // Set map to location
                    val mapController = binding.locationMapView.controller
                    val point = GeoPoint(lat, lng)
                    mapController.setZoom(17.0)
                    mapController.setCenter(point)

                    // Add marker
                    val marker = Marker(binding.locationMapView)
                    marker.position = point
                    marker.setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
                    marker.title = "You are here"
                    binding.locationMapView.overlays.clear()
                    binding.locationMapView.overlays.add(marker)
                    binding.locationMapView.invalidate()

                    // Update time
                    val timeFormat =
                        SimpleDateFormat("hh:mm a  ·  MMM dd, yyyy", Locale.getDefault())
                    binding.locationTime.text = timeFormat.format(System.currentTimeMillis())
                } else {
                    binding.locationCoordinates.text = "Location unavailable"
                    binding.locationAddress.text = ""
                }
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "Location fetch failed", e)
                binding.locationCoordinates.text = "Failed to get location"
                binding.locationAddress.text = ""
            }
    }

    @SuppressLint("MissingPermission")
    private fun fetchLocationInBackground() {
        if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return

        val fusedClient = LocationServices.getFusedLocationProviderClient(this)
        try {
            fusedClient.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, CancellationTokenSource().token)
                .addOnSuccessListener { location ->
                    if (location == null) return@addOnSuccessListener
                    onLocationUpdate(location.latitude, location.longitude)
                }
                .addOnFailureListener { e ->
                    Log.w(TAG, "Background location fetch failed", e)
                }
        } catch (e: SecurityException) {
            // User revoked permission between the check above and the call
            Log.w(TAG, "Location permission revoked mid-call", e)
        }
    }

    // ── Luminance / low-light hint ──

    /**
     * Sub-samples the Y plane of the preview frame (~1 Hz) and reports the
     * mean brightness 0..255. Closes the ImageProxy on every call.
     */
    private class LuminanceAnalyzer(
        private val onResult: (Float) -> Unit
    ) : ImageAnalysis.Analyzer {
        private var lastSampleAt = 0L
        override fun analyze(image: ImageProxy) {
            try {
                val now = System.currentTimeMillis()
                if (now - lastSampleAt < 400) return
                lastSampleAt = now
                val plane = image.planes[0]
                val buf = plane.buffer
                buf.rewind()
                val data = ByteArray(buf.remaining())
                buf.get(data)
                if (data.isEmpty()) return
                // Stride over every 8th pixel for cheap-but-stable mean
                var sum = 0L
                var count = 0
                var i = 0
                while (i < data.size) {
                    sum += (data[i].toInt() and 0xFF)
                    count++
                    i += 8
                }
                if (count > 0) onResult((sum.toFloat() / count.toFloat()))
            } finally {
                image.close()
            }
        }
    }

    private fun onLuminanceUpdate(lum: Float) {
        lastLuminance = lum

        // Only nudge user if scene is dim AND flash is currently OFF (Auto/On
        // doesn't need a nudge — it's already configured to handle low light).
        val isDim = lum < LOW_LIGHT_THRESHOLD_LUX
        val flashOff = flashMode == ImageCapture.FLASH_MODE_OFF
        val now = System.currentTimeMillis()

        if (isDim && flashOff &&
            now - lastLowLightHintAt > LOW_LIGHT_HINT_COOLDOWN_MS &&
            // Don't override active pills
            binding.cooldownPill.visibility != View.VISIBLE &&
            binding.uploadPill.visibility != View.VISIBLE &&
            binding.locationPanel.visibility != View.VISIBLE &&
            binding.flashPill.visibility != View.VISIBLE
        ) {
            lastLowLightHintAt = now
            showFlashPill("Low light · try flash")
        }
    }

    // ── Flash toggle ──

    private fun setupFlashButton() {
        // Restore last-used mode
        val prefs = getSharedPreferences("msc_prefs", MODE_PRIVATE)
        flashMode = prefs.getInt("flash_mode", ImageCapture.FLASH_MODE_OFF)
        applyFlashIcon()

        binding.flashButton.setOnClickListener {
            flashMode = when (flashMode) {
                ImageCapture.FLASH_MODE_OFF -> ImageCapture.FLASH_MODE_ON
                ImageCapture.FLASH_MODE_ON -> ImageCapture.FLASH_MODE_AUTO
                else -> ImageCapture.FLASH_MODE_OFF
            }
            getSharedPreferences("msc_prefs", MODE_PRIVATE).edit()
                .putInt("flash_mode", flashMode).apply()
            applyFlashIcon()
            // Push to the active ImageCapture so the next shot uses it
            imageCapture?.flashMode = flashMode

            // Quick tap feedback
            binding.flashButton.animate()
                .scaleX(0.85f).scaleY(0.85f)
                .setDuration(80)
                .withEndAction {
                    binding.flashButton.animate()
                        .scaleX(1f).scaleY(1f)
                        .setDuration(120).start()
                }.start()

            val label = when (flashMode) {
                ImageCapture.FLASH_MODE_ON -> "Flash on"
                ImageCapture.FLASH_MODE_AUTO -> "Flash auto"
                else -> "Flash off"
            }
            showFlashPill(label)
        }
    }

    private fun applyFlashIcon() {
        val drawable = when (flashMode) {
            ImageCapture.FLASH_MODE_ON -> R.drawable.ic_flash_on
            ImageCapture.FLASH_MODE_AUTO -> R.drawable.ic_flash_auto
            else -> R.drawable.ic_flash_off
        }
        binding.flashButton.setImageResource(drawable)
        binding.flashButton.alpha =
            if (flashMode == ImageCapture.FLASH_MODE_OFF) 0.55f else 1f
    }

    private fun showFlashPill(label: String) {
        // Dismiss conflicting pills instantly so only one is visible at a time
        dismissCooldownPillInstantly()
        dismissUploadPillInstantly()
        dismissLocationPillInstantly()

        val pill = binding.flashPill
        pill.text = label
        // Cancel any pending hide before re-showing
        flashPillDismissRunnable?.let { idleHandler.removeCallbacks(it) }

        if (pill.visibility == View.GONE) {
            pill.visibility = View.VISIBLE
            pill.alpha = 0f
            pill.translationY = -80f
            pill.scaleX = 0.85f
            pill.scaleY = 0.85f
            pill.animate()
                .alpha(1f)
                .translationY(0f)
                .scaleX(1f)
                .scaleY(1f)
                .setDuration(350)
                .setInterpolator(OvershootInterpolator(1.2f))
                .start()
        }

        // Schedule auto-dismiss
        val r = Runnable { hideFlashPill() }
        flashPillDismissRunnable = r
        idleHandler.postDelayed(r, 1500)
    }

    private fun hideFlashPill() {
        val pill = binding.flashPill
        if (pill.visibility != View.VISIBLE) return
        pill.animate()
            .alpha(0f)
            .translationY(-60f)
            .scaleX(0.9f)
            .scaleY(0.9f)
            .setDuration(250)
            .setInterpolator(AccelerateDecelerateInterpolator())
            .withEndAction {
                pill.visibility = View.GONE
                pill.translationY = 0f
                pill.scaleX = 1f
                pill.scaleY = 1f
            }
            .start()
    }

    private fun dismissFlashPillInstantly() {
        flashPillDismissRunnable?.let { idleHandler.removeCallbacks(it) }
        flashPillDismissRunnable = null
        binding.flashPill.animate().cancel()
        binding.flashPill.visibility = View.GONE
        binding.flashPill.alpha = 1f
        binding.flashPill.translationY = 0f
        binding.flashPill.scaleX = 1f
        binding.flashPill.scaleY = 1f
    }

    private fun ensureFusedClient(): FusedLocationProviderClient {
        return fusedLocationClient ?: LocationServices.getFusedLocationProviderClient(this).also {
            fusedLocationClient = it
        }
    }

    @SuppressLint("MissingPermission")
    private fun startLocationUpdates() {
        if (locationUpdatesActive) return
        if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) !=
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return

        val request = LocationRequest.Builder(
            Priority.PRIORITY_HIGH_ACCURACY,
            LOCATION_REFRESH_INTERVAL_MS
        )
            .setMinUpdateIntervalMillis(LOCATION_FASTEST_INTERVAL_MS)
            .setWaitForAccurateLocation(false)
            .build()

        if (locationCallback == null) {
            locationCallback = object : LocationCallback() {
                override fun onLocationResult(result: LocationResult) {
                    val loc = result.lastLocation ?: return
                    onLocationUpdate(loc.latitude, loc.longitude)
                }
            }
        }

        try {
            ensureFusedClient().requestLocationUpdates(request, locationCallback!!, mainLooper)
            locationUpdatesActive = true
            Log.d(TAG, "Location updates started @ ${LOCATION_REFRESH_INTERVAL_MS}ms")
        } catch (e: SecurityException) {
            Log.e(TAG, "Failed to start location updates", e)
        }
    }

    private fun stopLocationUpdates() {
        val cb = locationCallback ?: return
        fusedLocationClient?.removeLocationUpdates(cb)
        locationUpdatesActive = false
        Log.d(TAG, "Location updates stopped")
    }

    private fun onLocationUpdate(lat: Double, lng: Double) {
        lastKnownLat = lat
        lastKnownLng = lng
        locationFetched = true

        // Refresh panel UI immediately if visible
        refreshLocationPanelIfVisible()

        // Reverse-geocode at most once per ~30m of movement (or first time) to
        // keep the platform geocoder happy and avoid duplicate work.
        val needsGeocode = lastKnownAddress == null ||
                lastGeocodedLat == null ||
                lastGeocodedLng == null ||
                distanceMeters(lat, lng, lastGeocodedLat!!, lastGeocodedLng!!) > 30
        if (needsGeocode) {
            lastGeocodedLat = lat
            lastGeocodedLng = lng
            lifecycleScope.launch(kotlinx.coroutines.Dispatchers.IO) {
                try {
                    val addresses = Geocoder(this@MainActivity, Locale.getDefault())
                        .getFromLocation(lat, lng, 1)
                    val addr = if (!addresses.isNullOrEmpty())
                        addresses[0].getAddressLine(0)
                            ?: "${addresses[0].locality}, ${addresses[0].countryName}"
                    else null
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                        if (addr != null) {
                            lastKnownAddress = addr
                            refreshLocationPanelIfVisible()
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Reverse geocode failed; keeping last known address", e)
                }
            }
        }
    }

    private fun refreshLocationPanelIfVisible() {
        if (binding.locationPanel.visibility != View.VISIBLE) return
        val lat = lastKnownLat ?: return
        val lng = lastKnownLng ?: return
        binding.locationCoordinates.text =
            String.format(Locale.US, "%.6f, %.6f", lat, lng)
        binding.locationAddress.text = lastKnownAddress ?: "Resolving address…"
        val point = GeoPoint(lat, lng)
        binding.locationMapView.controller.setCenter(point)
        binding.locationMapView.overlays.clear()
        val marker = Marker(binding.locationMapView)
        marker.position = point
        marker.setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
        binding.locationMapView.overlays.add(marker)
        binding.locationMapView.invalidate()
        val timeFormat = SimpleDateFormat("hh:mm a  ·  MMM dd, yyyy", Locale.getDefault())
        binding.locationTime.text = timeFormat.format(System.currentTimeMillis())
    }

    private fun distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2)
        val c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
        return r * c
    }

    // Dismiss panel on outside tap
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.action == MotionEvent.ACTION_DOWN &&
            binding.locationPanel.visibility == View.VISIBLE
        ) {
            if (!isTouchInsideView(ev, binding.locationPanel) &&
                !isTouchInsideView(ev, binding.locationButton)
            ) {
                hideLocationPanel()
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun isTouchInsideView(ev: MotionEvent, view: View): Boolean {
        val loc = IntArray(2)
        view.getLocationOnScreen(loc)
        return ev.rawX >= loc[0] && ev.rawX <= loc[0] + view.width &&
                ev.rawY >= loc[1] && ev.rawY <= loc[1] + view.height
    }

    // ── Camera ──

    @SuppressLint("ClickableViewAccessibility")
    private fun setupShutterButton() {
        val inner = binding.shutterInner
        binding.shutterButton.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    AnimatorSet().apply {
                        playTogether(
                            ObjectAnimator.ofFloat(inner, "scaleX", 0.85f),
                            ObjectAnimator.ofFloat(inner, "scaleY", 0.85f)
                        )
                        duration = 100
                        interpolator = DecelerateInterpolator()
                        start()
                    }
                }
                MotionEvent.ACTION_UP -> {
                    AnimatorSet().apply {
                        playTogether(
                            ObjectAnimator.ofFloat(inner, "scaleX", 1f),
                            ObjectAnimator.ofFloat(inner, "scaleY", 1f)
                        )
                        duration = 200
                        interpolator = OvershootInterpolator(2f)
                        start()
                    }
                    onShutterPressed()
                }
                MotionEvent.ACTION_CANCEL -> {
                    AnimatorSet().apply {
                        playTogether(
                            ObjectAnimator.ofFloat(inner, "scaleX", 1f),
                            ObjectAnimator.ofFloat(inner, "scaleY", 1f)
                        )
                        duration = 200
                        interpolator = DecelerateInterpolator()
                        start()
                    }
                }
            }
            true
        }
    }

    private fun startCamera() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()

            val preview = Preview.Builder()
                .build()
                .also { it.surfaceProvider = binding.previewView.surfaceProvider }

            imageCapture = ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .setFlashMode(flashMode)
                .build()

            // Lightweight luminance analyzer — reads the Y plane only at low res
            // and at low frequency, throttled in the analyzer itself.
            val luminanceAnalysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setResolutionStrategy(
                            ResolutionStrategy(
                                android.util.Size(320, 240),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER
                            )
                        )
                        .build()
                )
                .build()
                .also {
                    it.setAnalyzer(
                        ContextCompat.getMainExecutor(this),
                        LuminanceAnalyzer { lum -> onLuminanceUpdate(lum) }
                    )
                }

            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    this,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageCapture,
                    luminanceAnalysis
                )
                checkFirstLaunchTutorial()
            } catch (e: Exception) {
                Log.e(TAG, "Camera bind failed", e)
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun takePhoto() {
        val imageCapture = imageCapture ?: return

        val timestamp =
            SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(System.currentTimeMillis())
        val contentValues = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, "IMG_$timestamp")
            put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/msc")
        }

        val outputOptions = ImageCapture.OutputFileOptions.Builder(
            contentResolver,
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            contentValues
        ).build()

        imageCapture.takePicture(
            outputOptions,
            ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    output.savedUri?.let { uri ->
                        val intent = Intent(this@MainActivity, CropActivity::class.java)
                        intent.putExtra("photo_uri", uri)
                        lastKnownLat?.let { intent.putExtra("lat", it) }
                        lastKnownLng?.let { intent.putExtra("lng", it) }
                        intent.putExtra("address", lastKnownAddress ?: "")
                        cropLauncher.launch(intent)
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    Log.e(TAG, "Photo capture failed: ${exception.message}", exception)
                    Toast.makeText(this@MainActivity, "Capture failed", Toast.LENGTH_SHORT).show()
                }
            }
        )
    }

    private fun updateThumbnail(uri: Uri?) {
        uri ?: return
        try {
            val bitmap = contentResolver.loadThumbnail(uri, android.util.Size(256, 256), null)
            binding.thumbnailButton.setImageBitmap(bitmap)
            binding.thumbnailButton.clipToOutline = true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to load thumbnail", e)
        }
    }

    private fun openLastPhoto() {
        val uri = lastPhotoUri ?: return
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "image/jpeg")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(intent)
    }

    override fun onResume() {
        super.onResume()
        binding.locationMapView.onResume()
        startLocationUpdates()
    }

    override fun onPause() {
        super.onPause()
        binding.locationMapView.onPause()
        stopLocationUpdates()
        // Dismiss transient dialogs so we don't leak them across config
        // changes. They'll be re-opened on demand.
        settingsDialog?.dismiss()
        galleryDialog?.dismiss()
    }

    override fun onDestroy() {
        super.onDestroy()
        // Belt-and-braces cleanup of every long-lived async resource so
        // nothing keeps the activity alive after teardown.
        idleHandler.removeCallbacks(idleDismissRunnable)
        flashPillDismissRunnable?.let { idleHandler.removeCallbacks(it) }
        cooldownTimer?.cancel(); cooldownTimer = null
        breathingAnimator?.cancel(); breathingAnimator = null
        stopLocationUpdates()
        locationCallback = null
        fusedLocationClient = null
        settingsDialog?.dismiss(); settingsDialog = null
        galleryDialog?.dismiss(); galleryDialog = null
    }

    // ── Settings Dialog ──

    private fun showSettingsDialog() {
        // Hide the settings icon
        binding.settingsButton.animate()
            .alpha(0f)
            .scaleX(0.5f)
            .scaleY(0.5f)
            .setDuration(150)
            .start()

        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setContentView(R.layout.dialog_settings)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setDimAmount(0.5f)
            setLayout(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT
            )
            val params = attributes
            params.gravity = Gravity.TOP or Gravity.END
            params.x = 16
            params.y = 100
            attributes = params
        }

        // Scale-in animation from top-right
        val dialogView = dialog.findViewById<View>(android.R.id.content)
        val rootView = (dialogView as? android.view.ViewGroup)?.getChildAt(0) ?: dialogView
        rootView.pivotX = rootView.resources.displayMetrics.widthPixels.toFloat()
        rootView.pivotY = 0f
        rootView.scaleX = 0.3f
        rootView.scaleY = 0.3f
        rootView.alpha = 0f
        rootView.post {
            rootView.pivotX = rootView.width.toFloat()
            rootView.pivotY = 0f
            rootView.animate()
                .scaleX(1f)
                .scaleY(1f)
                .alpha(1f)
                .setDuration(300)
                .setInterpolator(OvershootInterpolator(0.8f))
                .start()
        }

        // Get current theme mode
        val prefs = getSharedPreferences("msc_prefs", MODE_PRIVATE)
        val currentMode = prefs.getInt("theme_mode", AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)

        val radioDark = dialog.findViewById<View>(R.id.radioDark)
        val radioLight = dialog.findViewById<View>(R.id.radioLight)
        val radioSystem = dialog.findViewById<View>(R.id.radioSystem)
        val optionDark = dialog.findViewById<View>(R.id.optionDark)
        val optionLight = dialog.findViewById<View>(R.id.optionLight)
        val optionSystem = dialog.findViewById<View>(R.id.optionSystem)

        fun updateSelection(mode: Int) {
            radioDark.setBackgroundResource(
                if (mode == AppCompatDelegate.MODE_NIGHT_YES) R.drawable.radio_selected
                else R.drawable.radio_unselected
            )
            radioLight.setBackgroundResource(
                if (mode == AppCompatDelegate.MODE_NIGHT_NO) R.drawable.radio_selected
                else R.drawable.radio_unselected
            )
            radioSystem.setBackgroundResource(
                if (mode == AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM) R.drawable.radio_selected
                else R.drawable.radio_unselected
            )
            optionDark.isSelected = mode == AppCompatDelegate.MODE_NIGHT_YES
            optionLight.isSelected = mode == AppCompatDelegate.MODE_NIGHT_NO
            optionSystem.isSelected = mode == AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
        }

        updateSelection(currentMode)

        fun applyTheme(mode: Int) {
            prefs.edit().putInt("theme_mode", mode).apply()
            updateSelection(mode)
            AppCompatDelegate.setDefaultNightMode(mode)
        }

        optionDark.setOnClickListener { applyTheme(AppCompatDelegate.MODE_NIGHT_YES) }
        optionLight.setOnClickListener { applyTheme(AppCompatDelegate.MODE_NIGHT_NO) }
        optionSystem.setOnClickListener { applyTheme(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM) }

        // Animate-out helper
        fun dismissWithAnimation() {
            rootView.animate()
                .scaleX(0.3f)
                .scaleY(0.3f)
                .alpha(0f)
                .setDuration(200)
                .setInterpolator(AccelerateDecelerateInterpolator())
                .withEndAction {
                    dialog.dismiss()
                }
                .start()
        }

        // Show Tutorial option
        dialog.findViewById<View>(R.id.optionTutorial)?.setOnClickListener {
            dismissWithAnimation()
            binding.settingsButton.postDelayed({ showTutorial() }, 350)
        }

        dialog.setOnDismissListener {
            // Show settings icon back
            binding.settingsButton.animate()
                .alpha(1f)
                .scaleX(1f)
                .scaleY(1f)
                .setDuration(250)
                .setInterpolator(OvershootInterpolator(1.5f))
                .start()
            settingsDialog = null
        }

        // Handle outside touch — animate out then dismiss
        dialog.setCanceledOnTouchOutside(false)
        dialog.window?.decorView?.setOnTouchListener { _, event ->
            if (event.action == android.view.MotionEvent.ACTION_DOWN) {
                // Check if touch is outside dialog content
                val loc = IntArray(2)
                rootView.getLocationOnScreen(loc)
                val x = event.rawX
                val y = event.rawY
                if (x < loc[0] || x > loc[0] + rootView.width ||
                    y < loc[1] || y > loc[1] + rootView.height
                ) {
                    dismissWithAnimation()
                    true
                } else false
            } else false
        }

        // Handle back press
        dialog.setOnKeyListener { _, keyCode, event ->
            if (keyCode == android.view.KeyEvent.KEYCODE_BACK && event.action == android.view.KeyEvent.ACTION_UP) {
                dismissWithAnimation()
                true
            } else false
        }

        settingsDialog = dialog
        dialog.show()
    }

    // ── Gallery Dialog ──

    data class GalleryPhoto(val uri: Uri, val dateAdded: Long)

    private fun loadGalleryPhotos(): List<GalleryPhoto> {
        val photos = mutableListOf<GalleryPhoto>()
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DATE_ADDED
        )
        val selection = "${MediaStore.Images.Media.RELATIVE_PATH} LIKE ?"
        val selectionArgs = arrayOf("Pictures/msc%")
        val sortOrder = "${MediaStore.Images.Media.DATE_ADDED} DESC"

        contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection, selection, selectionArgs, sortOrder
        )?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val dateCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
            while (cursor.moveToNext()) {
                val id = cursor.getLong(idCol)
                val date = cursor.getLong(dateCol)
                val uri = Uri.withAppendedPath(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id.toString()
                )
                photos.add(GalleryPhoto(uri, date))
            }
        }
        return photos
    }

    private fun showGalleryDialog() {
        // Hide thumbnail button
        binding.thumbnailButton.animate()
            .alpha(0f)
            .scaleX(0.5f)
            .scaleY(0.5f)
            .setDuration(150)
            .start()

        val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setContentView(R.layout.dialog_gallery)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setDimAmount(0.5f)
            setLayout(
                (resources.displayMetrics.widthPixels * 0.92).toInt(),
                WindowManager.LayoutParams.WRAP_CONTENT
            )
            val params = attributes
            params.gravity = Gravity.CENTER
            params.y = -60
            attributes = params
        }

        // Scale-in animation from bottom-left
        val dialogView = dialog.findViewById<View>(android.R.id.content)
        val rootView = (dialogView as? ViewGroup)?.getChildAt(0) ?: dialogView
        rootView.pivotX = 0f
        rootView.pivotY = rootView.resources.displayMetrics.heightPixels.toFloat()
        rootView.scaleX = 0.3f
        rootView.scaleY = 0.3f
        rootView.alpha = 0f
        rootView.post {
            rootView.pivotX = 0f
            rootView.pivotY = rootView.height.toFloat()
            rootView.animate()
                .scaleX(1f)
                .scaleY(1f)
                .alpha(1f)
                .setDuration(300)
                .setInterpolator(OvershootInterpolator(0.8f))
                .start()
        }

        val flipper = dialog.findViewById<ViewFlipper>(R.id.galleryFlipper)
        val grid = dialog.findViewById<RecyclerView>(R.id.galleryGrid)
        val emptyText = dialog.findViewById<TextView>(R.id.galleryEmpty)
        val detailBack = dialog.findViewById<View>(R.id.detailBack)
        val detailPhoto = dialog.findViewById<ImageView>(R.id.detailPhoto)
        val detailAddress = dialog.findViewById<TextView>(R.id.detailAddress)
        val detailCoords = dialog.findViewById<TextView>(R.id.detailCoordinates)
        val detailTime = dialog.findViewById<TextView>(R.id.detailTime)
        val detailMap = dialog.findViewById<MapView>(R.id.detailMapView)
        val noLocOverlay = dialog.findViewById<View>(R.id.detailNoLocationOverlay)

        // Setup map
        detailMap.setTileSource(TileSourceFactory.MAPNIK)
        detailMap.setMultiTouchControls(false)

        // Load photos
        val photos = loadGalleryPhotos()

        if (photos.isEmpty()) {
            emptyText.visibility = View.VISIBLE
            grid.visibility = View.GONE
        } else {
            emptyText.visibility = View.GONE
            grid.visibility = View.VISIBLE
        }

        // Grid adapter
        grid.layoutManager = GridLayoutManager(this, 3)
        grid.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
                val view = LayoutInflater.from(parent.context)
                    .inflate(R.layout.item_gallery_photo, parent, false)
                return object : RecyclerView.ViewHolder(view) {}
            }

            override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
                val photo = photos[position]
                val imageView = holder.itemView.findViewById<ImageView>(R.id.photoThumb)

                try {
                    val thumb = contentResolver.loadThumbnail(photo.uri, android.util.Size(256, 256), null)
                    imageView.setImageBitmap(thumb)
                } catch (e: Exception) {
                    imageView.setImageDrawable(null)
                }

                holder.itemView.setOnClickListener {
                    showPhotoDetail(
                        flipper, photo, detailPhoto, detailAddress,
                        detailCoords, detailTime, detailMap, noLocOverlay
                    )
                }
            }

            override fun getItemCount() = photos.size
        }

        // Detail back button
        detailBack.setOnClickListener {
            flipper.setInAnimation(this, R.anim.pop_in)
            flipper.setOutAnimation(this, R.anim.pop_out)
            flipper.displayedChild = 0
        }

        // Dismiss animation helper
        fun dismissWithAnimation() {
            rootView.animate()
                .scaleX(0.3f)
                .scaleY(0.3f)
                .alpha(0f)
                .setDuration(200)
                .setInterpolator(AccelerateDecelerateInterpolator())
                .withEndAction { dialog.dismiss() }
                .start()
        }

        dialog.setOnDismissListener {
            // Cleanup map
            detailMap.onPause()
            // Show thumbnail back
            binding.thumbnailButton.animate()
                .alpha(1f)
                .scaleX(1f)
                .scaleY(1f)
                .setDuration(250)
                .setInterpolator(OvershootInterpolator(1.5f))
                .start()
            galleryDialog = null
        }

        dialog.setCanceledOnTouchOutside(false)
        dialog.window?.decorView?.setOnTouchListener { _, event ->
            if (event.action == MotionEvent.ACTION_DOWN) {
                val loc = IntArray(2)
                rootView.getLocationOnScreen(loc)
                val x = event.rawX
                val y = event.rawY
                if (x < loc[0] || x > loc[0] + rootView.width ||
                    y < loc[1] || y > loc[1] + rootView.height
                ) {
                    dismissWithAnimation()
                    true
                } else false
            } else false
        }

        dialog.setOnKeyListener { _, keyCode, event ->
            if (keyCode == android.view.KeyEvent.KEYCODE_BACK && event.action == android.view.KeyEvent.ACTION_UP) {
                if (flipper.displayedChild == 1) {
                    flipper.setInAnimation(this, android.R.anim.fade_in)
                    flipper.setOutAnimation(this, android.R.anim.fade_out)
                    flipper.displayedChild = 0
                } else {
                    dismissWithAnimation()
                }
                true
            } else false
        }

        galleryDialog = dialog
        dialog.show()
        detailMap.onResume()
    }

    private fun showPhotoDetail(
        flipper: ViewFlipper,
        photo: GalleryPhoto,
        detailPhoto: ImageView,
        detailAddress: TextView,
        detailCoords: TextView,
        detailTime: TextView,
        detailMap: MapView,
        noLocOverlay: View
    ) {
        // Load full image
        try {
            val thumb = contentResolver.loadThumbnail(photo.uri, android.util.Size(800, 800), null)
            detailPhoto.setImageBitmap(thumb)
        } catch (e: Exception) {
            detailPhoto.setImageDrawable(null)
        }

        // Time
        val timeFormat = SimpleDateFormat("hh:mm a  ·  MMM dd, yyyy", Locale.getDefault())
        detailTime.text = timeFormat.format(photo.dateAdded * 1000)

        // Read EXIF location
        var lat: Double? = null
        var lng: Double? = null
        try {
            contentResolver.openInputStream(photo.uri)?.use { stream ->
                val exif = ExifInterface(stream)
                val latLong = exif.latLong
                if (latLong != null) {
                    lat = latLong[0]
                    lng = latLong[1]
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "EXIF read failed", e)
        }

        if (lat != null && lng != null) {
            detailCoords.text = String.format(Locale.US, "%.6f, %.6f", lat, lng)
            noLocOverlay.visibility = View.GONE

            // Reverse geocode
            try {
                val geocoder = Geocoder(this, Locale.getDefault())
                val addresses = geocoder.getFromLocation(lat!!, lng!!, 1)
                if (!addresses.isNullOrEmpty()) {
                    detailAddress.text = addresses[0].getAddressLine(0)
                        ?: "${addresses[0].locality}, ${addresses[0].countryName}"
                } else {
                    detailAddress.text = "Address not found"
                }
            } catch (e: Exception) {
                detailAddress.text = "Geocoder unavailable"
            }

            // Map
            val point = GeoPoint(lat!!, lng!!)
            detailMap.controller.setZoom(17.0)
            detailMap.controller.setCenter(point)
            detailMap.overlays.clear()
            val marker = Marker(detailMap)
            marker.position = point
            marker.setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM)
            detailMap.overlays.add(marker)
            detailMap.invalidate()
        } else {
            detailAddress.text = "No location data"
            detailCoords.text = ""
            noLocOverlay.visibility = View.VISIBLE
        }

        // Flip to detail
        flipper.setInAnimation(this, android.R.anim.fade_in)
        flipper.setOutAnimation(this, android.R.anim.fade_out)
        flipper.displayedChild = 1
    }

    // ─── Upload Notification Pill ───────────────────────────────────────

    private fun showUploadPill() {
        // Dismiss any other pills
        dismissCooldownPillInstantly()
        dismissLocationPillInstantly()
        dismissFlashPillInstantly()

        val pill = binding.uploadPill
        // Reset to uploading state
        binding.uploadProgress.visibility = View.VISIBLE
        binding.uploadSuccessBg.visibility = View.GONE
        binding.uploadCheckIcon.visibility = View.GONE
        binding.uploadFailBg.visibility = View.GONE
        binding.uploadCrossIcon.visibility = View.GONE
        binding.uploadPillText.text = "Image Uploading"

        pill.visibility = View.VISIBLE
        pill.alpha = 0f
        pill.translationY = -80f
        pill.scaleX = 0.85f
        pill.scaleY = 0.85f
        pill.animate()
            .alpha(1f)
            .translationY(0f)
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(350)
            .setInterpolator(OvershootInterpolator(1.2f))
            .start()
    }

    private fun showUploadSuccess() {
        binding.uploadPillText.text = "Image Uploaded"

        // Coin-flip animation: spinner flips to green check
        val spinner = binding.uploadProgress
        val successBg = binding.uploadSuccessBg
        val checkIcon = binding.uploadCheckIcon

        // First half: flip spinner away (scaleX 1 -> 0)
        spinner.animate()
            .scaleX(0f)
            .setDuration(200)
            .withEndAction {
                spinner.visibility = View.GONE
                spinner.scaleX = 1f

                // Show green circle + check, flip in (scaleX 0 -> 1)
                successBg.visibility = View.VISIBLE
                checkIcon.visibility = View.VISIBLE
                successBg.scaleX = 0f
                checkIcon.scaleX = 0f
                successBg.animate().scaleX(1f).setDuration(200).start()
                checkIcon.animate().scaleX(1f).setDuration(200).start()
            }
            .start()

        // Auto-dismiss after 2.5 seconds
        binding.uploadPill.postDelayed({ hideUploadPill() }, 2500)
    }

    private fun showUploadFail() {
        binding.uploadPillText.text = "Upload Failed"

        val spinner = binding.uploadProgress
        val failBg = binding.uploadFailBg
        val crossIcon = binding.uploadCrossIcon

        // First half: flip spinner away
        spinner.animate()
            .scaleX(0f)
            .setDuration(200)
            .withEndAction {
                spinner.visibility = View.GONE
                spinner.scaleX = 1f

                // Show red circle + cross, flip in
                failBg.visibility = View.VISIBLE
                crossIcon.visibility = View.VISIBLE
                failBg.scaleX = 0f
                crossIcon.scaleX = 0f
                failBg.animate().scaleX(1f).setDuration(200).start()
                crossIcon.animate().scaleX(1f).setDuration(200).start()
            }
            .start()

        // Auto-dismiss after 3 seconds
        binding.uploadPill.postDelayed({ hideUploadPill() }, 3000)
    }

    private fun hideUploadPill() {
        val pill = binding.uploadPill
        pill.animate()
            .alpha(0f)
            .translationY(-60f)
            .scaleX(0.9f)
            .scaleY(0.9f)
            .setDuration(250)
            .setInterpolator(AccelerateDecelerateInterpolator())
            .withEndAction {
                pill.visibility = View.GONE
                pill.translationY = 0f
                pill.scaleX = 1f
                pill.scaleY = 1f
            }
            .start()
    }

    private fun dismissUploadPillInstantly() {
        binding.uploadPill.animate().cancel()
        binding.uploadPill.visibility = View.GONE
        binding.uploadPill.alpha = 1f
        binding.uploadPill.translationY = 0f
        binding.uploadPill.scaleX = 1f
        binding.uploadPill.scaleY = 1f
    }

    private fun performUpload(uri: Uri) {
        lifecycleScope.launch {
            val success = CloudUploader.uploadPhoto(
                this@MainActivity, contentResolver, uri,
                lastKnownLat, lastKnownLng, lastKnownAddress
            )
            if (success) showUploadSuccess() else showUploadFail()
        }
    }

    // ─── Tutorial ──────────────────────────────────────────────────────

    private fun showTutorial() {
        val overlay = TutorialOverlay(this)
        overlay.layoutParams = android.view.ViewGroup.LayoutParams(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            android.view.ViewGroup.LayoutParams.MATCH_PARENT
        )

        val steps = listOf(
            TutorialOverlay.Step(binding.shutterButton, "Tap to capture a photo", tooltipBelow = false),
            TutorialOverlay.Step(binding.thumbnailButton, "View your photo gallery", tooltipBelow = false),
            TutorialOverlay.Step(binding.locationButton, "Check your current location", tooltipBelow = true),
            TutorialOverlay.Step(binding.settingsButton, "Change app theme", tooltipBelow = true)
        )

        val root = binding.root as android.view.ViewGroup
        root.addView(overlay)

        overlay.setSteps(steps) {
            getSharedPreferences("msc_prefs", MODE_PRIVATE)
                .edit().putBoolean("tutorial_seen", true).apply()
        }
    }

    private fun checkFirstLaunchTutorial() {
        val seen = getSharedPreferences("msc_prefs", MODE_PRIVATE)
            .getBoolean("tutorial_seen", false)
        if (!seen) {
            binding.root.postDelayed({ showTutorial() }, 1500)
        }
    }

    companion object {
        private const val TAG = "MscCamera"
    }
}
