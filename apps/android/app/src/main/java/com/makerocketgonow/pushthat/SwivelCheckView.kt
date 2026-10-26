package com.makerocketgonow.pushthat

import android.content.Context
import android.graphics.Camera
import android.net.Uri
import android.util.AttributeSet
import android.util.Log
import android.view.View
import android.view.animation.Animation
import android.view.animation.Transformation
import android.widget.Checkable
import android.widget.ImageView
import android.widget.ViewFlipper
import androidx.interpolator.view.animation.FastOutSlowInInterpolator
import com.bumptech.glide.Glide
import com.bumptech.glide.request.target.Target

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

    fun loadFavicon(url: String, fileExt: String? = null) {
        // Check if there's a file extension and it matches our supported icons
        Log.d("SwivelCheckView", "Loading favicon for $url with extension $fileExt")
        if (!fileExt.isNullOrBlank()) {
            Log.d("SwivelCheckView", "File extension is not null or blank")
            val iconName = SUPPORTED_FILE_ICONS.find { it == "${fileExt.lowercase()}.png" }
            if (iconName != null) {
                Log.d("SwivelCheckView", "File extension is supported")
                // Load file type icon from PushThat CDN
                Glide.with(context)
                    .load("https://pushthat.link/files/${iconName}")
                    .fitCenter()
                    .override(Target.SIZE_ORIGINAL)
                    .error(R.drawable.default_favicon)
                    .into(frontImageView)

                // Load checkmark for back side
                backImageView.setImageResource(R.drawable.ic_check_circle)
                backImageView.setColorFilter(context.getColor(R.color.checkmark_color))
                return
            }
        }

        // If no file extension or unsupported, fall back to favicon
        val uri = Uri.parse(url)
        val faviconUrl = "https://www.google.com/s2/favicons?domain=${Uri.encode(uri.host)}&sz=256"

        Glide.with(context)
            .load(faviconUrl)
            .fitCenter()
            .override(Target.SIZE_ORIGINAL)
            .error(R.drawable.default_favicon)
            .into(frontImageView)

        backImageView.setImageResource(R.drawable.ic_check_circle)
        backImageView.setColorFilter(context.getColor(R.color.checkmark_color))
    }

    fun setOnCheckedChangeListener(listener: (SwivelCheckView, Boolean) -> Unit) {
        onCheckedChangeListener = listener
    }

    companion object {
        private val SUPPORTED_FILE_ICONS = listOf(
            "pproj.png", "zip.png", "indd.png", "csv.png", "css.png", "pdf.png",
            "aac.png", "png.png", "xls.png", "avi.png", "txt.png", "mp3.png",
            "tiff.png", "psd.png", "jpg.png", "jpeg.png", "mov.png", "html.png",
            "ai.png", "js.png", "flac.png", "mp4.png", "gif.png", "doc.png",
            "xml.png", "apk.png"
        )

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