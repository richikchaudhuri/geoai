package com.example.msc

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View

/**
 * 1:1 crop view with pinch-to-zoom + drag-to-pan.
 *
 * The crop window is fixed at the centre of the view. The image is rendered
 * inside [imageRect] which can scale (1×–6×) and translate. The user pans the
 * image under the fixed crop window to position the area of interest, and
 * pinches to zoom in for tighter framing of small features (e.g. potholes).
 */
class CropImageView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    private var bitmap: Bitmap? = null

    /** Image rect at scale 1.0× — fits the view bounds. Used as anchor for zoom. */
    private val baseImageRect = RectF()

    /** Live image rect — scaled and translated. Drawn directly. */
    private val imageRect = RectF()

    /** Fixed 1:1 crop window in view coordinates. */
    private val cropRect = RectF()
    private var cropSize = 0f

    private var scale = 1.0f
    private val minScale = 1.0f
    private val maxScale = 6.0f

    // Pan tracking
    private var lastTouchX = 0f
    private var lastTouchY = 0f
    private var activePointerId = INVALID_POINTER_ID

    private val scaleGestureDetector =
        ScaleGestureDetector(context, ScaleListener())

    private val overlayPaint = Paint().apply {
        color = Color.argb(180, 0, 0, 0)
        style = Paint.Style.FILL
    }

    private val borderPaint = Paint().apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeWidth = 3f
        isAntiAlias = true
    }

    private val gridPaint = Paint().apply {
        color = Color.argb(60, 255, 255, 255)
        style = Paint.Style.STROKE
        strokeWidth = 1f
        isAntiAlias = true
    }

    private val zoomBadgePaint = Paint().apply {
        color = Color.argb(160, 0, 0, 0)
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    private val zoomTextPaint = Paint().apply {
        color = Color.WHITE
        textSize = resources.displayMetrics.density * 12f
        isAntiAlias = true
        isFakeBoldText = true
    }

    fun setImageBitmap(bmp: Bitmap) {
        bitmap = bmp
        scale = 1.0f
        if (width > 0 && height > 0) calculateRects()
        invalidate()
    }

    /** Programmatic reset (e.g. wired to a "1×" reset button if you add one). */
    @Suppress("unused")
    fun resetZoom() {
        scale = 1.0f
        calculateRects()
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        calculateRects()
    }

    private fun calculateRects() {
        val bmp = bitmap ?: return
        val viewW = width.toFloat()
        val viewH = height.toFloat()

        // Base image rect at scale 1.0× — image fits view (BoxFit.contain)
        val fit = minOf(viewW / bmp.width, viewH / bmp.height)
        val baseW = bmp.width * fit
        val baseH = bmp.height * fit
        val baseLeft = (viewW - baseW) / 2f
        val baseTop = (viewH - baseH) / 2f
        baseImageRect.set(baseLeft, baseTop, baseLeft + baseW, baseTop + baseH)

        // 1:1 crop window — anchored to the smaller dimension of the base image,
        // centred in the view. Stays fixed regardless of zoom.
        cropSize = minOf(baseW, baseH)
        val cropLeft = (viewW - cropSize) / 2f
        val cropTop = (viewH - cropSize) / 2f
        cropRect.set(cropLeft, cropTop, cropLeft + cropSize, cropTop + cropSize)

        // Apply current scale around the view centre
        applyScaleAround(viewW / 2f, viewH / 2f, scale, scale)
    }

    /**
     * Recompute [imageRect] for `newScale` so that the point at
     * (focalX, focalY) in view coords stays anchored.
     */
    private fun applyScaleAround(
        focalX: Float,
        focalY: Float,
        oldScale: Float,
        newScale: Float
    ) {
        val baseW = baseImageRect.width()
        val baseH = baseImageRect.height()

        // Anchor point on the original image (0..1) under the focal screen pos
        // before the zoom is applied
        val anchorU: Float
        val anchorV: Float
        if (imageRect.width() <= 0f || imageRect.height() <= 0f) {
            anchorU = 0.5f
            anchorV = 0.5f
        } else {
            anchorU = (focalX - imageRect.left) / imageRect.width()
            anchorV = (focalY - imageRect.top) / imageRect.height()
        }

        val newW = baseW * newScale
        val newH = baseH * newScale
        val newLeft = focalX - anchorU * newW
        val newTop = focalY - anchorV * newH
        imageRect.set(newLeft, newTop, newLeft + newW, newTop + newH)

        clampImageToCrop()
    }

    /**
     * Constrain [imageRect] so the crop window always sits over real image
     * pixels — no transparent borders inside the crop.
     */
    private fun clampImageToCrop() {
        // If the image is smaller than the crop in any dimension (shouldn't
        // happen since min scale = 1.0 and crop = min image dim, but defensive),
        // centre it.
        val dx: Float = when {
            imageRect.width() < cropRect.width() ->
                cropRect.centerX() - imageRect.centerX()
            imageRect.left > cropRect.left -> cropRect.left - imageRect.left
            imageRect.right < cropRect.right -> cropRect.right - imageRect.right
            else -> 0f
        }
        val dy: Float = when {
            imageRect.height() < cropRect.height() ->
                cropRect.centerY() - imageRect.centerY()
            imageRect.top > cropRect.top -> cropRect.top - imageRect.top
            imageRect.bottom < cropRect.bottom -> cropRect.bottom - imageRect.bottom
            else -> 0f
        }
        imageRect.offset(dx, dy)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val bmp = bitmap ?: return

        canvas.drawBitmap(bmp, null, imageRect, null)

        // Dark overlay outside crop
        canvas.drawRect(0f, 0f, width.toFloat(), cropRect.top, overlayPaint)
        canvas.drawRect(0f, cropRect.bottom, width.toFloat(), height.toFloat(), overlayPaint)
        canvas.drawRect(0f, cropRect.top, cropRect.left, cropRect.bottom, overlayPaint)
        canvas.drawRect(cropRect.right, cropRect.top, width.toFloat(), cropRect.bottom, overlayPaint)

        // Crop frame
        canvas.drawRect(cropRect, borderPaint)

        // Rule-of-thirds grid
        val third = cropSize / 3f
        canvas.drawLine(cropRect.left + third, cropRect.top,
            cropRect.left + third, cropRect.bottom, gridPaint)
        canvas.drawLine(cropRect.left + 2 * third, cropRect.top,
            cropRect.left + 2 * third, cropRect.bottom, gridPaint)
        canvas.drawLine(cropRect.left, cropRect.top + third,
            cropRect.right, cropRect.top + third, gridPaint)
        canvas.drawLine(cropRect.left, cropRect.top + 2 * third,
            cropRect.right, cropRect.top + 2 * third, gridPaint)

        // Tiny zoom-level badge (top-right of crop)
        if (scale > 1.001f) {
            val text = String.format("%.1f×", scale)
            val pad = 6f * resources.displayMetrics.density
            val textW = zoomTextPaint.measureText(text)
            val textH = zoomTextPaint.fontMetrics.run { descent - ascent }
            val badgeW = textW + pad * 2
            val badgeH = textH + pad
            val badgeRight = cropRect.right - 8f * resources.displayMetrics.density
            val badgeTop = cropRect.top + 8f * resources.displayMetrics.density
            val badgeLeft = badgeRight - badgeW
            val r = badgeH / 2f
            canvas.drawRoundRect(
                badgeLeft, badgeTop, badgeRight, badgeTop + badgeH, r, r, zoomBadgePaint
            )
            canvas.drawText(
                text,
                badgeLeft + pad,
                badgeTop + pad / 2f - zoomTextPaint.fontMetrics.ascent,
                zoomTextPaint
            )
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        // Pinch-zoom always processed first
        scaleGestureDetector.onTouchEvent(event)

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastTouchX = event.x
                lastTouchY = event.y
                activePointerId = event.getPointerId(0)
            }
            MotionEvent.ACTION_MOVE -> {
                // Don't pan while a pinch gesture is in progress — the scale
                // listener handles the focal-point math.
                if (!scaleGestureDetector.isInProgress &&
                    activePointerId != INVALID_POINTER_ID
                ) {
                    val idx = event.findPointerIndex(activePointerId)
                    if (idx >= 0) {
                        val x = event.getX(idx)
                        val y = event.getY(idx)
                        imageRect.offset(x - lastTouchX, y - lastTouchY)
                        clampImageToCrop()
                        lastTouchX = x
                        lastTouchY = y
                        invalidate()
                    }
                }
            }
            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_CANCEL -> {
                activePointerId = INVALID_POINTER_ID
            }
            MotionEvent.ACTION_POINTER_UP -> {
                val pointerIndex = (event.action and
                    MotionEvent.ACTION_POINTER_INDEX_MASK) shr
                    MotionEvent.ACTION_POINTER_INDEX_SHIFT
                val pointerId = event.getPointerId(pointerIndex)
                if (pointerId == activePointerId) {
                    val newIdx = if (pointerIndex == 0) 1 else 0
                    if (newIdx < event.pointerCount) {
                        lastTouchX = event.getX(newIdx)
                        lastTouchY = event.getY(newIdx)
                        activePointerId = event.getPointerId(newIdx)
                    }
                }
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                // When second finger lands during a drag, anchor the
                // primary pointer for the resumed pan after pinch ends
                lastTouchX = event.getX(0)
                lastTouchY = event.getY(0)
                activePointerId = event.getPointerId(0)
            }
        }
        return true
    }

    private inner class ScaleListener : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val old = scale
            val proposed = (scale * detector.scaleFactor).coerceIn(minScale, maxScale)
            if (proposed == scale) return true
            scale = proposed
            applyScaleAround(detector.focusX, detector.focusY, old, scale)
            invalidate()
            return true
        }
    }

    /**
     * Returns a square bitmap of the current crop window. Pixels are sampled
     * from the source bitmap based on the current pan/zoom transform of
     * [imageRect].
     */
    fun getCroppedBitmap(): Bitmap? {
        val bmp = bitmap ?: return null
        if (imageRect.width() <= 0 || imageRect.height() <= 0) return null

        val scaleX = bmp.width.toFloat() / imageRect.width()
        val scaleY = bmp.height.toFloat() / imageRect.height()

        val srcLeft = ((cropRect.left - imageRect.left) * scaleX).toInt()
            .coerceAtLeast(0)
        val srcTop = ((cropRect.top - imageRect.top) * scaleY).toInt()
            .coerceAtLeast(0)
        val srcSize = (cropSize * scaleX).toInt().coerceAtMost(
            minOf(bmp.width - srcLeft, bmp.height - srcTop)
        )

        if (srcSize <= 0) return null
        return Bitmap.createBitmap(bmp, srcLeft, srcTop, srcSize, srcSize)
    }

    companion object {
        private const val INVALID_POINTER_ID = -1
    }
}
