package com.example.msc

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.*
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import androidx.core.content.res.ResourcesCompat

class TutorialOverlay @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null
) : View(context, attrs) {

    data class Step(
        val targetView: View,
        val description: String,
        val tooltipBelow: Boolean = false
    )

    private var steps: List<Step> = emptyList()
    private var currentStep = 0
    private var onComplete: (() -> Unit)? = null

    private val overlayPaint = Paint().apply {
        color = Color.parseColor("#CC000000")
        style = Paint.Style.FILL
    }

    private val clearPaint = Paint().apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
        isAntiAlias = true
    }

    private val textPaint = Paint().apply {
        color = Color.WHITE
        textSize = 25f * resources.displayMetrics.scaledDensity
        isAntiAlias = true
        typeface = ResourcesCompat.getFont(context, R.font.sf_display_light)
    }

    private val stepPaint = Paint().apply {
        color = Color.parseColor("#88FFFFFF")
        textSize = 16f * resources.displayMetrics.scaledDensity
        isAntiAlias = true
        typeface = ResourcesCompat.getFont(context, R.font.sf_display_light)
    }

    private val padding = 16f * resources.displayMetrics.density
    private val tooltipMargin = 24f * resources.displayMetrics.density

    // For cutout animation
    private var animatedRadius = 0f
    private var targetRadius = 0f

    fun setSteps(steps: List<Step>, onComplete: () -> Unit) {
        this.steps = steps
        this.onComplete = onComplete
        this.currentStep = 0
        setLayerType(LAYER_TYPE_HARDWARE, null)
        animateToStep(0)
    }

    private fun animateToStep(index: Int) {
        if (index >= steps.size) return
        val step = steps[index]
        val target = step.targetView

        val loc = IntArray(2)
        target.getLocationInWindow(loc)
        val myLoc = IntArray(2)
        getLocationInWindow(myLoc)

        val cx = loc[0] - myLoc[0] + target.width / 2f
        val cy = loc[1] - myLoc[1] + target.height / 2f
        targetRadius = (maxOf(target.width, target.height) / 2f) + padding

        val anim = ValueAnimator.ofFloat(0f, targetRadius)
        anim.duration = 300
        anim.interpolator = AccelerateDecelerateInterpolator()
        anim.addUpdateListener {
            animatedRadius = it.animatedValue as Float
            invalidate()
        }
        anim.start()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (steps.isEmpty() || currentStep >= steps.size) return

        val step = steps[currentStep]
        val target = step.targetView

        val loc = IntArray(2)
        target.getLocationInWindow(loc)
        val myLoc = IntArray(2)
        getLocationInWindow(myLoc)

        val cx = loc[0] - myLoc[0] + target.width / 2f
        val cy = loc[1] - myLoc[1] + target.height / 2f

        // Draw overlay
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), overlayPaint)

        // Cut out circle
        canvas.drawCircle(cx, cy, animatedRadius, clearPaint)

        // Draw tooltip text
        val text = step.description
        val textWidth = textPaint.measureText(text)
        val textX = (width - textWidth) / 2f

        val textY = if (step.tooltipBelow) {
            cy + animatedRadius + tooltipMargin + textPaint.textSize
        } else {
            cy - animatedRadius - tooltipMargin
        }
        canvas.drawText(text, textX, textY, textPaint)

        // Draw step counter
        val stepText = "${currentStep + 1} / ${steps.size}"
        val stepWidth = stepPaint.measureText(stepText)
        canvas.drawText(
            stepText,
            width - stepWidth - 24f * resources.displayMetrics.density,
            40f * resources.displayMetrics.density,
            stepPaint
        )

        // Draw "Tap to continue" hint
        val hintPaint = Paint(stepPaint).apply {
            textSize = 14f * resources.displayMetrics.scaledDensity
        }
        val hint = "Tap anywhere to continue"
        val hintWidth = hintPaint.measureText(hint)
        canvas.drawText(
            hint,
            (width - hintWidth) / 2f,
            height - 40f * resources.displayMetrics.density,
            hintPaint
        )
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_UP) {
            currentStep++
            if (currentStep >= steps.size) {
                // Fade out and remove
                animate()
                    .alpha(0f)
                    .setDuration(250)
                    .withEndAction {
                        (parent as? android.view.ViewGroup)?.removeView(this)
                        onComplete?.invoke()
                    }
                    .start()
            } else {
                animateToStep(currentStep)
            }
        }
        return true
    }
}
