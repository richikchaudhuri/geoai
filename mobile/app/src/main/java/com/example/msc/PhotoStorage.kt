package com.example.msc

import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Size
import java.io.File
import java.io.IOException

/** Shared MediaStore paths for both scoped-storage and Android 8/9 devices. */
internal object PhotoStorage {
    private const val RELATIVE_DIRECTORY = "Pictures/msc/"

    @Suppress("DEPRECATION")
    private fun legacyDirectory() = File(
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "msc"
    )

    @Suppress("DEPRECATION")
    fun contentValues(name: String): ContentValues = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, "$name.jpg")
        put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            put(MediaStore.Images.Media.RELATIVE_PATH, RELATIVE_DIRECTORY)
        } else {
            val directory = legacyDirectory()
            if (!directory.isDirectory && !directory.mkdirs()) {
                throw IOException("Could not create the photo directory")
            }
            put(MediaStore.Images.Media.DATA, File(directory, "$name.jpg").absolutePath)
        }
    }

    @Suppress("DEPRECATION")
    fun gallerySelection(): Pair<String, Array<String>> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            "${MediaStore.Images.Media.RELATIVE_PATH} = ?" to arrayOf(RELATIVE_DIRECTORY)
        } else {
            "${MediaStore.Images.Media.DATA} LIKE ?" to arrayOf("${legacyDirectory().absolutePath}/%")
        }

    @Suppress("DEPRECATION")
    fun thumbnail(resolver: ContentResolver, uri: Uri, size: Int): Bitmap? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            resolver.loadThumbnail(uri, Size(size, size), null)
        } else {
            MediaStore.Images.Thumbnails.getThumbnail(
                resolver, ContentUris.parseId(uri), MediaStore.Images.Thumbnails.MINI_KIND, null
            )
        }
}
