package com.makerocketgonow.pushthat

import android.app.Activity
import android.content.Context
import android.util.Log
import com.google.android.play.agesignals.AgeSignalsAccessRequest
import com.google.android.play.agesignals.AgeSignalsException
import com.google.android.play.agesignals.AgeSignalsManager
import com.google.android.play.agesignals.AgeSignalsManagerFactory
import com.google.android.play.agesignals.AgeSignalsRequest
import com.google.android.play.agesignals.ApplicableAgeFeaturesRequest
import com.google.android.play.agesignals.model.AgeSignalsStatus
import com.google.android.play.agesignals.model.ApplicableAgeFeature
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await

/**
 * PushThat is for people 18 and older. This asks Google Play for the age signal once per
 * launch and keeps one fact from it: whether Play says the person using this phone is
 * under 18. California's Digital Age Assurance Act (AB 1043, Civil Code 1798.500 and on)
 * requires every app from a covered store to request the signal when it is downloaded and
 * launched, from January 2027, and treats what comes back as actual knowledge of the
 * user's age. Knowing a user is under the age the Terms and Privacy Policy set, and carrying
 * on regardless, would make both documents untrue (and under 13, would be collecting a
 * child's email and pushes without the parental consent COPPA wants, which PushThat has no
 * way to get). So such an install is signed out and stops at a screen that says why
 * (LoginActivity). Brazil makes sharing mandatory at the same time; the same check covers it.
 *
 * Only the verdict is stored, never the age range, the install ID or the approval date:
 * Play's terms limit the signal to age-appropriate experiences and legal compliance, and
 * nothing else in the app needs it. Nothing about it leaves the phone.
 *
 * So the gate closes this install, not the account. The account, its email and its pushes
 * stay on the server, usable from the web and the extension: the signal describes whoever
 * uses this phone, which may not be the account's owner (a parent signed in on a child's
 * phone), and sending it to the server would be collecting it. Acting on the account itself
 * would be a separate decision, and one for whoever owns the legal side.
 *
 * Every failure lets the person in. The API is beta, Play is missing on some phones (a
 * sideloaded build, a device without Play services), and outside the regions where Play
 * shares the signal there is usually nothing to read. The law asks for the request, not
 * for refusing service when no answer comes, and a gate that shut on errors would lock out
 * adults for Google's outages.
 */
object AgeGate {
    /**
     * The age the Terms (Registration) require to form the contract, and the Privacy Policy
     * says the app is not intended for anyone under. 13, COPPA's line, was tried first and
     * contradicted both. A change here is a change to those documents too (apps/web).
     */
    const val MINIMUM_AGE = 18

    private const val TAG = "AgeGate"
    private const val PREFS = "age_gate"
    private const val KEY_UNDER_MINIMUM = "under_minimum"

    /**
     * Once per process, which is once per launch. Not once per install: the law says "when
     * the application is downloaded and launched", and a child's age bracket can be set
     * after the app is already on the phone.
     */
    @Volatile
    private var checkedThisProcess = false

    private val checking = Mutex()

    /**
     * Lets the next [checkOnce] ask Play again, when the gate is shut. Only then: for anyone
     * let in, one check per launch is what the law asks for, and each is a call to Play.
     */
    fun askAgainIfBlocked(context: Context) {
        if (isBlocked(context)) checkedThisProcess = false
    }

    /** Whether the last answer from Play said the person using this phone is under [MINIMUM_AGE]. */
    fun isBlocked(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_UNDER_MINIMUM, false)

    /**
     * The signal for this launch, unless one has been asked for already. Returns whether the
     * install is now blocked, so the caller can leave for the gate; a check that learns
     * nothing leaves the stored verdict as it was. The caller's activity is lent to Play,
     * which may show its own prompt over it.
     */
    suspend fun checkOnce(activity: Activity): Boolean = checking.withLock {
        // Locked so that one check runs at a time: a sign-in that finishes before the login
        // screen's check does starts MainActivity's while the first is still waiting, and
        // where sharing is mandatory that would be two access requests, one over an activity
        // that is going. The second caller waits and reads the first answer; if the first was
        // cancelled instead, the second asks for itself.
        if (checkedThisProcess) return isBlocked(activity)
        val manager = AgeSignalsManagerFactory.create(activity.applicationContext)
        val answer = ask(manager, requestAccess = {
            val request = AgeSignalsAccessRequest.builder().setActivity(activity).build()
            manager.requestAgeSignalsAccess(request).await().ageSignalsStatus()
        })
        // Marked only once Play has answered (or failed to): a check cancelled because the
        // activity went (a rotation) runs again from the next one, rather than never this launch.
        checkedThisProcess = true
        val underMinimum = answer ?: return isBlocked(activity)
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_UNDER_MINIMUM, underMinimum)
            .apply()
        return underMinimum
    }

    /**
     * Whether Play says the user is under [MINIMUM_AGE], or null when it gave no age.
     *
     * Where sharing is mandatory (California and Brazil from January 2027) Play is asked for
     * access first, which is how its documentation orders the calls: that step is where Play
     * takes the user to verify an age it needs and does not have. Anywhere else it is
     * skipped, since there it puts up Play's "share your age?" prompt, and nothing in
     * PushThat changes with the answer for anyone of age. The signal is still read, as
     * Play already shares it in some places (Texas, Australia, Canada) without the prompt.
     *
     * [requestAccess] is the access request, passed in because it needs an activity to show
     * Play's prompt over, which a JVM unit test has none of; it returns Play's
     * `AgeSignalsStatus`. [log] is replaceable for the same reason: `android.util.Log` throws
     * in a JVM unit test.
     */
    internal suspend fun ask(
        manager: AgeSignalsManager,
        requestAccess: suspend () -> Int?,
        log: (String) -> Unit = { Log.w(TAG, it) },
    ): Boolean? = try {
        val features = manager.getApplicableAgeFeatures(ApplicableAgeFeaturesRequest.builder().build()).await()
        val shared = if (ApplicableAgeFeature.MANDATORY_SHARING in features.features()) {
            // NOT_SHARED or VERIFICATION_REQUIRED: no age to act on. Verifying happens in
            // the Play Store, not here, so there is nothing for PushThat to show for it.
            requestAccess() == AgeSignalsStatus.SHARED
        } else {
            true
        }
        if (shared) {
            val result = manager.checkAgeSignals(AgeSignalsRequest.builder().build()).await()
            underMinimum(result.ageLower(), result.ageUpper())
        } else {
            null
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: AgeSignalsException) {
        // The code only: it says which of Play's failures this was, and nothing about the user.
        log("Age signals unavailable: ${e.errorCode}")
        null
    } catch (e: Exception) {
        log("Age signals check failed: ${e.javaClass.simpleName}")
        null
    }

    /**
     * Play's brackets are closed ranges ([0, 12], [13, 15], [16, 17]) and an open top one
     * ([18, null]); both ends null means no age was shared. A range whose top is under
     * [MINIMUM_AGE] is turned away. A range that straddles it would be one Play has not
     * documented, and is let in rather than guessed at.
     */
    internal fun underMinimum(ageLower: Int?, ageUpper: Int?): Boolean? = when {
        ageLower == null && ageUpper == null -> null
        ageUpper != null && ageUpper < MINIMUM_AGE -> true
        else -> false
    }
}
