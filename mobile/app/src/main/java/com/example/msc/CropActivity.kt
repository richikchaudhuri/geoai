package com.example.msc

import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Locale

class CropActivity : AppCompatActivity() {

    private lateinit var cropView: CropImageView
    private var sourceUri: Uri? = null
    private var photoLat: Double? = null
    private var photoLng: Double? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_crop)

        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.cropImageView)) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, 0)
            insets
        }

        cropView = findViewById(R.id.cropImageView)
        val cancelBtn = findViewById<android.widget.ImageButton>(R.id.btnCancel)
        val confirmBtn = findViewById<android.widget.ImageButton>(R.id.btnConfirm)
        val cropPill = findViewById<View>(R.id.cropPill)

        sourceUri = intent.getParcelableExtra("photo_uri", Uri::class.java)
        if (intent.hasExtra("lat")) photoLat = intent.getDoubleExtra("lat", 0.0)
        if (intent.hasExtra("lng")) photoLng = intent.getDoubleExtra("lng", 0.0)

        // Hide pill until image is ready
        cropPill.visibility = View.INVISIBLE

        sourceUri?.let { uri ->
            lifecycleScope.launch {
                val bitmap = withContext(Dispatchers.IO) {
                    loadSampledBitmap(uri)
                }
                if (bitmap != null) {
                    cropView.setImageBitmap(bitmap)
                    cropPill.visibility = View.VISIBLE
                } else {
                    finish()
                }
            }
        } ?: finish()

        cancelBtn.setOnClickListener {
            sourceUri?.let { contentResolver.delete(it, null, null) }
            setResult(RESULT_CANCELED)
            finish()
        }

        confirmBtn.setOnClickListener {
            lifecycleScope.launch {
                confirmBtn.isEnabled = false
                saveCroppedPhoto()
                confirmBtn.isEnabled = true
            }
        }
    }

    // Decode at half resolution for display — saves memory & decodes 4x faster
    private fun loadSampledBitmap(uri: Uri): Bitmap? {
        return try {
            // Step 1: decode bounds only (zero memory)
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            contentResolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, options)
            }

            // Step 2: pick the largest power-of-2 sample that keeps longest edge ≤ 1920px
            val maxDim = 1920
            var sampleSize = 1
            var w = options.outWidth
            var h = options.outHeight
            while (w / 2 >= maxDim || h / 2 >= maxDim) {
                w /= 2; h /= 2; sampleSize *= 2
            }

            // Step 3: decode at sample size
            val decodeOptions = BitmapFactory.Options().apply {
                inSampleSize = sampleSize
                inPreferredConfig = Bitmap.Config.RGB_565 // 2 bytes/px vs 4 for ARGB_8888
            }
            val bitmap = contentResolver.openInputStream(uri)?.use {
                BitmapFactory.decodeStream(it, null, decodeOptions)
            } ?: return null

            // Step 4: fix EXIF rotation
            fixRotation(uri, bitmap)
        } catch (e: Exception) {
            Log.e("CropActivity", "Failed to load image", e)
            null
        }
    }

    private fun fixRotation(uri: Uri, bitmap: Bitmap): Bitmap {
        val rotation = try {
            contentResolver.openInputStream(uri)?.use { input ->
                val exif = ExifInterface(input)
                when (exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                    ExifInterface.ORIENTATION_ROTATE_90  -> 90f
                    ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                    ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                    else -> 0f
                }
            } ?: 0f
        } catch (e: Exception) { 0f }

        if (rotation == 0f) return bitmap
        val matrix = Matrix().apply { postRotate(rotation) }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
            .also { if (it !== bitmap) bitmap.recycle() }
    }

    private suspend fun saveCroppedPhoto() {
        val cropped = cropView.getCroppedBitmap() ?: run {
            setResult(RESULT_CANCELED)
            finish()
            return
        }

        val uri = withContext(Dispatchers.IO) {
            val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)
                .format(System.currentTimeMillis())

            val contentValues = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, "IMG_${timestamp}_cropped")
                put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/msc")
            }

            val newUri = contentResolver.insert(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues
            ) ?: return@withContext null

            try {
                contentResolver.openOutputStream(newUri)?.use { out ->
                    cropped.compress(Bitmap.CompressFormat.JPEG, 80, out)
                }
                cropped.recycle()

                // Write GPS EXIF
                if (photoLat != null && photoLng != null) {
                    contentResolver.openFileDescriptor(newUri, "rw")?.use { pfd ->
                        val exif = ExifInterface(pfd.fileDescriptor)
                        exif.setLatLong(photoLat!!, photoLng!!)
                        exif.saveAttributes()
                    }
                }

                // Delete original uncropped photo
                sourceUri?.let { contentResolver.delete(it, null, null) }

                newUri
            } catch (e: Exception) {
                Log.e("CropActivity", "Failed to save cropped image", e)
                null
            }
        }

        if (uri != null) {
            setResult(RESULT_OK, Intent().putExtra("cropped_uri", uri.toString()))
        } else {
            setResult(RESULT_CANCELED)
        }
        finish()
    }
}
