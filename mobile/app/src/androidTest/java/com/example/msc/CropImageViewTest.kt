package com.example.msc

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import androidx.core.content.IntentCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CropImageViewTest {
    @Test
    fun recyclingFullFrameCropDoesNotDestroyPreviewOrPreventRetry() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val source = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888)
            source.eraseColor(Color.RED)
            val view = CropImageView(instrumentation.targetContext)
            view.layout(0, 0, 256, 256)
            view.setImageBitmap(source)

            val firstCrop = requireNotNull(view.getCroppedBitmap())
            assertNotSame(source, firstCrop)
            firstCrop.recycle() // A completed or failed save always releases its copy.
            assertFalse(source.isRecycled)

            val preview = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(preview)) // Used to throw after a full-frame save.
            val retry = requireNotNull(view.getCroppedBitmap())
            assertEquals(256, retry.width)
            assertEquals(Color.RED, retry.getPixel(128, 128))
            retry.recycle()
            preview.recycle()
            source.recycle()
        }
    }

    @Test
    fun rectangularPhotoProducesIndependentSquareCrop() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val source = Bitmap.createBitmap(512, 256, Bitmap.Config.ARGB_8888)
            val view = CropImageView(instrumentation.targetContext)
            view.layout(0, 0, 512, 512)
            view.setImageBitmap(source)
            val crop = requireNotNull(view.getCroppedBitmap())
            assertEquals(256, crop.width)
            assertEquals(256, crop.height)
            crop.recycle()
            assertFalse(source.isRecycled)
            source.recycle()
        }
    }

    @Test
    fun photoUriSurvivesCompatibleIntentExtraction() {
        val uri = Uri.parse("content://media/external/images/media/42")
        val intent = Intent().putExtra("photo_uri", uri)
        assertEquals(uri, IntentCompat.getParcelableExtra(intent, "photo_uri", Uri::class.java))
    }
}
