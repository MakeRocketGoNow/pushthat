package com.makerocketgonow.pushthat

import com.google.android.play.agesignals.AgeSignalsException
import com.google.android.play.agesignals.AgeSignalsResult
import com.google.android.play.agesignals.ApplicableAgeFeaturesResult
import com.google.android.play.agesignals.model.AgeSignalsErrorCode
import com.google.android.play.agesignals.model.AgeSignalsStatus
import com.google.android.play.agesignals.model.ApplicableAgeFeature
import com.google.android.play.agesignals.testing.FakeAgeSignalsManager
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Which of Play's answers stop an install at the gate, and that every failure lets it in. */
class AgeGateTest {

    @Test
    fun everyBracketUnderEighteenIsUnderTheMinimum() {
        assertEquals(true, AgeGate.underMinimum(0, 12))
        assertEquals(true, AgeGate.underMinimum(13, 15))
        assertEquals(true, AgeGate.underMinimum(16, 17))
        assertEquals(false, AgeGate.underMinimum(18, null))
    }

    @Test
    fun noAgeSharedIsNoAnswer() {
        assertNull(AgeGate.underMinimum(null, null))
    }

    @Test
    fun aRangeAcrossEighteenIsLetIn() {
        // Not a bracket Play documents; a guess would lock out whoever it is wrong about.
        assertEquals(false, AgeGate.underMinimum(16, 20))
    }

    private val noAccessRequest: suspend () -> Int? = { error("access requested without mandatory sharing") }

    private fun mandatory(result: AgeSignalsResult): FakeAgeSignalsManager = FakeAgeSignalsManager().apply {
        setNextApplicableAgeFeaturesResult(
            ApplicableAgeFeaturesResult.builder().setFeatures(setOf(ApplicableAgeFeature.MANDATORY_SHARING)).build(),
        )
        setNextAgeSignalsResult(result)
    }

    private val teen = AgeSignalsResult.builder().setAgeLower(16).setAgeUpper(17).build()

    @Test
    fun whereSharingIsMandatoryASharedAgeIsRead() = runBlocking {
        assertEquals(true, AgeGate.ask(mandatory(teen), { AgeSignalsStatus.SHARED }) {})
    }

    @Test
    fun whereSharingIsMandatoryNoAccessIsNoAnswer() = runBlocking {
        assertNull(AgeGate.ask(mandatory(teen), { AgeSignalsStatus.NOT_SHARED }) {})
        assertNull(AgeGate.ask(mandatory(teen), { AgeSignalsStatus.VERIFICATION_REQUIRED }) {})
    }

    @Test
    fun aFailedAccessRequestIsNoAnswer() = runBlocking {
        val failing: suspend () -> Int? = { throw AgeSignalsException(AgeSignalsErrorCode.NETWORK_ERROR) }
        assertNull(AgeGate.ask(mandatory(teen), failing) {})
    }

    private fun manager(result: AgeSignalsResult): FakeAgeSignalsManager = FakeAgeSignalsManager().apply {
        // No mandatory sharing: Play is not asked for access.
        setNextApplicableAgeFeaturesResult(ApplicableAgeFeaturesResult.builder().setFeatures(emptySet()).build())
        setNextAgeSignalsResult(result)
    }

    @Test
    fun aTeenSignalBlocks() = runBlocking {
        val result = AgeSignalsResult.builder().setAgeLower(16).setAgeUpper(17).build()
        assertEquals(true, AgeGate.ask(manager(result), noAccessRequest) {})
    }

    @Test
    fun anAdultSignalDoesNotBlock() = runBlocking {
        val result = AgeSignalsResult.builder().setAgeLower(18).build()
        assertEquals(false, AgeGate.ask(manager(result), noAccessRequest) {})
    }

    @Test
    fun aFailureIsNoAnswer() = runBlocking {
        val manager = FakeAgeSignalsManager().apply {
            setNextApplicableAgeFeaturesException(AgeSignalsException(AgeSignalsErrorCode.PLAY_STORE_NOT_FOUND))
        }
        assertNull(AgeGate.ask(manager, noAccessRequest) {})
    }
}
