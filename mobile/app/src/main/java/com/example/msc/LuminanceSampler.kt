package com.example.msc

import java.nio.ByteBuffer

/** Samples image pixels only; Y-plane row padding is not part of the image. */
internal object LuminanceSampler {
    fun mean(buffer: ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int): Float? {
        if (width <= 0 || height <= 0 || rowStride <= 0 || pixelStride <= 0) return null
        val start = buffer.position().toLong()
        val limit = buffer.limit().toLong()
        var sum = 0L
        var count = 0L
        for (y in 0 until height) {
            val row = start + y.toLong() * rowStride
            if (row >= limit) break
            for (x in 0 until width step 8) {
                val index = row + x.toLong() * pixelStride
                if (index >= limit) break
                sum += buffer.get(index.toInt()).toInt() and 0xff
                count++
            }
        }
        return if (count == 0L) null else sum.toFloat() / count
    }
}
