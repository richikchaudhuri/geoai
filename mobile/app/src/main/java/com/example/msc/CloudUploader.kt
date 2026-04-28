package com.example.msc

import android.content.ContentResolver
import android.content.Context
import android.location.Geocoder
import android.net.Uri
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source
import org.json.JSONObject
import java.io.IOException
import java.util.Locale
import java.util.concurrent.TimeUnit

object CloudUploader {

    private const val TAG = "CloudUploader"
    private const val CLOUDINARY_CLOUD = "dnxpt5gea"
    private const val CLOUDINARY_PRESET = "photos"
    private const val SUPABASE_URL = "https://vtlkitpoffudiefuoijb.supabase.co"
    private const val SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bGtpdHBvZmZ1ZGllZnVvaWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDAzMjIsImV4cCI6MjA4OTc3NjMyMn0.wLrwTky4k8iAELOvFbNeo063Z1rjQKOzzq3QYFqR6CU"

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    // Suspend function — call from a coroutine, runs on IO dispatcher internally
    suspend fun uploadPhoto(
        context: Context,
        contentResolver: ContentResolver,
        photoUri: Uri,
        lat: Double?,
        lng: Double?,
        address: String?
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            // Resolve address if missing
            val resolvedAddress = resolveAddress(context, address, lat, lng)

            // 1. Stream directly to Cloudinary — no readBytes(), no heap copy
            val streamingBody = object : RequestBody() {
                override fun contentType() = "image/jpeg".toMediaType()
                override fun writeTo(sink: BufferedSink) {
                    contentResolver.openInputStream(photoUri)?.source()?.use { source ->
                        sink.writeAll(source)
                    }
                }
            }

            val requestBody = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", "photo.jpg", streamingBody)
                .addFormDataPart("upload_preset", CLOUDINARY_PRESET)
                .build()

            val cloudinaryResponse = client.newCall(
                Request.Builder()
                    .url("https://api.cloudinary.com/v1_1/$CLOUDINARY_CLOUD/image/upload")
                    .post(requestBody)
                    .build()
            ).execute()

            if (!cloudinaryResponse.isSuccessful) {
                Log.e(TAG, "Cloudinary upload failed: ${cloudinaryResponse.code}")
                return@withContext false
            }

            val imageUrl = JSONObject(cloudinaryResponse.body?.string() ?: "")
                .getString("secure_url")
            Log.d(TAG, "Cloudinary URL: $imageUrl")

            // 2. Insert into Supabase
            val payload = JSONObject().apply {
                put("image_url", imageUrl)
                put("address", resolvedAddress)
                if (lat != null) put("latitude", lat)
                if (lng != null) put("longitude", lng)
            }

            val supabaseResponse = client.newCall(
                Request.Builder()
                    .url("$SUPABASE_URL/rest/v1/photos")
                    .addHeader("apikey", SUPABASE_KEY)
                    .addHeader("Authorization", "Bearer $SUPABASE_KEY")
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Prefer", "return=minimal")
                    .post(payload.toString().toRequestBody("application/json".toMediaType()))
                    .build()
            ).execute()

            if (supabaseResponse.isSuccessful) {
                Log.d(TAG, "Supabase insert success")
                true
            } else {
                Log.e(TAG, "Supabase insert failed: ${supabaseResponse.code} ${supabaseResponse.body?.string()}")
                false
            }
        } catch (e: IOException) {
            Log.e(TAG, "Upload failed", e)
            false
        } catch (e: Exception) {
            Log.e(TAG, "Upload error", e)
            false
        }
    }

    private fun resolveAddress(context: Context, address: String?, lat: Double?, lng: Double?): String {
        if (!address.isNullOrEmpty()
            && address != "Fetching address..."
            && address != "Geocoder unavailable") {
            return address
        }
        if (lat == null || lng == null) return ""
        return try {
            val addresses = Geocoder(context, Locale.getDefault()).getFromLocation(lat, lng, 1)
            if (!addresses.isNullOrEmpty()) {
                addresses[0].getAddressLine(0)
                    ?: "${addresses[0].locality}, ${addresses[0].countryName}"
            } else ""
        } catch (e: Exception) {
            Log.e(TAG, "Geocoder failed", e)
            ""
        }
    }
}

// Extension to keep call sites clean
private fun String.toRequestBody(type: okhttp3.MediaType) =
    okhttp3.RequestBody.Companion.create(type, this)
