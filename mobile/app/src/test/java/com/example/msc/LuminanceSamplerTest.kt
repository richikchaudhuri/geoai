package com.example.msc

import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class LuminanceSamplerTest {
    @Test fun rowPaddingDoesNotMakeBrightImagesAppearDark() {
        val bytes = ByteArray(64)
        for (row in 0..1) for (column in 0 until 16) bytes[row * 32 + column] = 240.toByte()
        assertEquals(240f, LuminanceSampler.mean(ByteBuffer.wrap(bytes), 16, 2, 32, 1)!!, 0f)
    }

    @Test fun pixelStrideAndBufferPositionAreRespectedWithoutConsumingBuffer() {
        val buffer = ByteBuffer.allocate(40)
        buffer.position(3)
        buffer.put(3, 100.toByte())
        buffer.put(19, 200.toByte())
        assertEquals(150f, LuminanceSampler.mean(buffer, 9, 1, 20, 2)!!, 0f)
        assertEquals(3, buffer.position())
        assertEquals(40, buffer.limit())
    }

    @Test fun emptyTruncatedAndInvalidPlanesDoNotCrash() {
        assertNull(LuminanceSampler.mean(ByteBuffer.allocate(0), 16, 2, 16, 1))
        assertNull(LuminanceSampler.mean(ByteBuffer.allocate(16), 16, 2, 0, 1))
        assertEquals(255f, LuminanceSampler.mean(ByteBuffer.wrap(byteArrayOf(255.toByte())),
            16, 2, 32, 1)!!, 0f)
    }
}
