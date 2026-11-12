package com.makerocketgonow.pushthat

import android.content.Context
import android.graphics.Camera
import android.graphics.drawable.Drawable
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
import com.bumptech.glide.RequestBuilder
import com.bumptech.glide.request.target.Target
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

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

    // The lookup of the linked site's icon this view is waiting on, and the site it is for.
    // Views are recycled, so both are reset on every bind (loadFavicon).
    private var iconLookup: Job? = null
    private var iconOrigin: String? = null

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

    /**
     * The icon for [fileExt] when there is one, else the icon of the site [url] is on, asked
     * of that site and nobody else (see [Favicons]). A push with neither (an encrypted file
     * of an unknown type, a locked push) gets the placeholder: there is no site to ask, and
     * a locked push's URL is not known at all.
     */
    fun loadFavicon(url: String?, fileExt: String? = null) {
        // Whatever this view was waiting on belongs to the row it showed before.
        iconLookup?.cancel()
        iconLookup = null
        iconOrigin = null
        // Check if there's a file extension and it matches our supported icons
        if (!fileExt.isNullOrBlank()) {
            Log.d("SwivelCheckView", "File extension is not null or blank")
            val iconName = SUPPORTED_FILE_ICONS.find { it == "${fileExt.lowercase()}.png" }
            if (iconName != null) {
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

        // No icon for the file type: the linked site's own icon (Favicons), or the
        // placeholder when there is no site to ask.
        backImageView.setImageResource(R.drawable.ic_check_circle)
        backImageView.setColorFilter(context.getColor(R.color.checkmark_color))
        val origin = Favicons.originOf(url)
        if (origin == null) {
            Glide.with(context).clear(frontImageView)
            frontImageView.setImageResource(R.drawable.default_favicon)
            return
        }
        // Looked up before: drawn at once, so a row scrolled back into view does not blink
        // through the placeholder.
        Favicons.known(origin)?.let { return showSiteIcon(it) }
        Glide.with(context).clear(frontImageView)
        frontImageView.setImageResource(R.drawable.default_favicon)
        iconOrigin = origin
        startLookup(origin)
    }

    private fun startLookup(origin: String) {
        iconLookup = iconScope.launch {
            val candidates = Favicons.candidates(origin)
            // Still this row's site: a recycled view's lookup was cancelled in loadFavicon,
            // and this guards the moment between the answer and the cancel.
            if (iconOrigin == origin) showSiteIcon(candidates)
        }
    }

    /**
     * A lookup must not outlive the window. It can take seconds, and one that came back
     * after its activity was destroyed (a rotation while icons load) drew into it:
     * `Glide.with` throws for a destroyed activity, and nothing in `iconScope` catches.
     */
    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        iconLookup?.cancel()
    }

    /**
     * The other half: RecyclerView puts a row back from its cache without binding it again,
     * so a row whose lookup was cancelled on the way out takes it up again here, or it
     * would come back showing the placeholder for good.
     */
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        val origin = iconOrigin ?: return
        if (iconLookup?.isCancelled != true) return
        Favicons.known(origin)?.let { showSiteIcon(it) } ?: startLookup(origin)
    }

    /**
     * Draws the first of [candidates] that loads, and the placeholder when none does: each
     * is the `error` request of the one before, which is how Glide chains fallbacks.
     */
    private fun showSiteIcon(candidates: List<String>) {
        val requests = Glide.with(context)
        var chain: RequestBuilder<Drawable>? = null
        for (candidate in candidates.asReversed()) {
            // Sized to this view by Glide, not `SIZE_ORIGINAL` as the file icons above are:
            // the largest icon a site declares is tried first, and a 512 pixel one held
            // whole is a megabyte of bitmap for a 36 dp square.
            val request = requests.load(candidate).fitCenter()
            chain = if (chain == null) request.error(R.drawable.default_favicon) else request.error(chain)
        }
        chain?.into(frontImageView) ?: frontImageView.setImageResource(R.drawable.default_favicon)
    }

    fun setOnCheckedChangeListener(listener: (SwivelCheckView, Boolean) -> Unit) {
        onCheckedChangeListener = listener
    }

    companion object {
        // One scope for every row's lookup: each view cancels its own job, and the work
        // itself runs in Favicons' scope, so nothing here outlives a row by more than a hop.
        private val iconScope = MainScope()

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