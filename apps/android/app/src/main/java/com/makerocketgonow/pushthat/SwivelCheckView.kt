package com.makerocketgonow.pushthat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Camera
import android.util.AttributeSet
import android.util.LruCache
import android.view.View
import android.view.animation.Animation
import android.view.animation.Transformation
import android.widget.Checkable
import android.widget.ImageView
import android.widget.ViewFlipper
import androidx.interpolator.view.animation.FastOutSlowInInterpolator
import com.makerocketgonow.pushthat.e2ee.E2ee

class SwivelCheckView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : ViewFlipper(context, attrs), Checkable {

    private val calculateCenterX = { width * 0.5f }
    private val updateDisplayedSide: (DisplaySide) -> Unit = { setDisplaySide(it) }
    private val toCheckedAnimation = toChecked(calculateCenterX, updateDisplayedSide)
    private val toNotCheckedAnimation = toNotChecked(calculateCenterX, updateDisplayedSide)
    private var isChecked: Boolean = false

    private val frontImageView: ImageView
    private val backImageView: ImageView

    private var onCheckedChangeListener: ((SwivelCheckView, Boolean) -> Unit)? = null

    init {
        View.inflate(context, R.layout.merge_swivel_check, this)
        frontImageView = getChildAt(0) as ImageView
        backImageView = getChildAt(1) as ImageView
        backImageView.setImageResource(R.drawable.ic_check_circle)
        backImageView.setColorFilter(context.getColor(R.color.checkmark_color))
    }

    fun setChecked(targetState: Boolean, shouldAnimate: Boolean = true) {
        if (shouldAnimate) {
            setChecked(targetState)
        } else {
            setDisplaySide(if (targetState) DisplaySide.BACK else DisplaySide.FRONT)
            isChecked = targetState
        }
    }

    private fun setDisplaySide(displaySide: DisplaySide) {
        if (displayedChild != displaySide.viewFlipperChildIndex) {
            displayedChild = displaySide.viewFlipperChildIndex
        }
    }

    override fun setChecked(targetState: Boolean) {
        if (targetState == isChecked) {
            return
        }
        if (targetState) {
            isChecked = true
            startAnimation(toCheckedAnimation)
        } else {
            isChecked = false
            startAnimation(toNotCheckedAnimation)
        }
        onCheckedChangeListener?.invoke(this, targetState)
    }

    override fun isChecked() = isChecked

    override fun toggle() = setChecked(!isChecked)

    /**
     * The row's icon, from what the push carries and nothing else: nothing is fetched to
     * draw a row (docs/e2ee.md, Icons). [pageIcon] is a URL push's `icon`, drawn when it
     * decodes; else the app's own icon for [fileExt], when it has one (a file push, or a
     * link to a file, which has no page to take an icon from); else the placeholder, which
     * is also what a locked push draws.
     *
     * The page's icon wins over the type: a link whose path ends in `.html` is a page, and
     * its own icon says more than the type's.
     */
    fun showIcon(pageIcon: String?, fileExt: String? = null) {
        val bitmap = pageIcon?.takeIf { it.isNotEmpty() }?.let { decodedIcon(it) }
        if (bitmap != null) {
            frontImageView.setImageBitmap(bitmap)
        } else {
            frontImageView.setImageResource(FileIcons.forExt(fileExt) ?: R.drawable.default_favicon)
        }
    }

    fun setOnCheckedChangeListener(listener: (SwivelCheckView, Boolean) -> Unit) {
        onCheckedChangeListener = listener
    }

    companion object {
        /**
         * Page icons already decoded, by their base64. Decoding one is cheap (at most 64 by
         * 64 and 4 KB), but a bind happens on every scroll, so each is decoded once on the
         * main thread rather than per bind or through a loader thread. Keyed by the string
         * rather than the push, so a push whose icon changes is never drawn with the old one.
         * 256 icons of at most 16 KB each is about 4 MB.
         */
        private val decodedIcons = LruCache<String, Bitmap>(256)

        private fun decodedIcon(icon: String): Bitmap? {
            decodedIcons.get(icon)?.let { return it }
            val bitmap = try {
                // Sampled like a scraped icon: the envelope says 64 by 64, but a PNG of a few
                // KB can claim to be far larger, and decoded whole it would not fit in memory.
                PageIcons.decode(E2ee.fromBase64(icon))
            } catch (e: IllegalArgumentException) {
                null
            } ?: return null
            decodedIcons.put(icon, bitmap)
            return bitmap
        }

        private fun toChecked(calculateCenterX: () -> Float, updateDisplayedSide: (DisplaySide) -> Unit) =
            createAnimation(0f..180f, calculateCenterX, updateDisplayedSide)

        private fun toNotChecked(calculateCenterX: () -> Float, updateDisplayedSide: (DisplaySide) -> Unit) =
            createAnimation(180f..0f, calculateCenterX, updateDisplayedSide)

        private fun createAnimation(
            rotation: ClosedFloatingPointRange<Float>,
            calculateCenterX: () -> Float,
            updateDisplayedSide: (DisplaySide) -> Unit
        ): Animation {
            return SwivelAnimation(rotation, calculateCenterX, updateDisplayedSide).apply {
                duration = 320L
                interpolator = FastOutSlowInInterpolator()
            }
        }
    }
}

private class SwivelAnimation(
    private val rotation: ClosedFloatingPointRange<Float>,
    private val calculateCenterX: () -> Float,
    private val updateDisplayedSide: (DisplaySide) -> Unit
) : Animation() {

    private val camera = Camera()

    override fun applyTransformation(interpolatedTime: Float, transformation: Transformation) {
        val degrees = rotation.start + (rotation.endInclusive - rotation.start) * interpolatedTime
        val matrix = transformation.matrix
        val centerX = calculateCenterX()

        camera.save()
        camera.rotateY(degrees)
        camera.getMatrix(matrix)
        camera.restore()

        matrix.preTranslate(-centerX, 0f)
        matrix.postTranslate(centerX, 0f)

        val displaySide = if (degrees >= 90) DisplaySide.BACK else DisplaySide.FRONT
        updateDisplayedSide(displaySide)

        if (displaySide == DisplaySide.BACK) {
            matrix.preScale(-1f, 1f, centerX, 0f)
        }
    }
}

private enum class DisplaySide(val viewFlipperChildIndex: Int) {
    FRONT(0),
    BACK(1)
}