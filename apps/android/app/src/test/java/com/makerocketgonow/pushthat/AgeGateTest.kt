package com.makerocketgonow.pushthat

import com.google.android.play.agesignals.AgeSignalsException
import com.google.android.play.agesignals.AgeSignalsResult
import com.google.android.play.agesignals.ApplicableAgeFeaturesResult
import com.google.android.play.agesignals.model.AgeSignalsErrorCode
import com.google.android.play.agesignals.testing.FakeAgeSignalsManager
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Which of Play's answers stop an install at the gate, and that every failure lets it in. */
class AgeGateTest {

    @Test
    fun onlyABracketEndingUnderThirteenIsUnderTheMinimum() {
        assertEquals(true, AgeGate.underMinimum(0, 12))
        assertEquals(false, AgeGate.underMinimum(13, 15))
        assertEquals(false, AgeGate.underMinimum(16, 17))
        assertEquals(false, AgeGate.underMinimum(18, null))
    }

    @Test
    fun noAgeSharedIsNoAnswer() {
        assertNull(AgeGate.underMinimum(null, null))
    }

    @Test
    fun aRangeAcrossThirteenIsLetIn() {
        // Not a bracket Play documents; a guess would lock out whoever it is wrong about.
        assertEquals(false, AgeGate.underMinimum(10, 14))
    }

    private fun manager(result: AgeSignalsResult): FakeAgeSignalsManager = FakeAgeSignalsManager().apply {
        // No mandatory sharing, so ask() never needs an activity for Play's prompt.
        setNextApplicableAgeFeaturesResult(ApplicableAgeFeaturesResult.builder().setFeatures(emptySet()).build())
        setNextAgeSignalsResult(result)
    }

    @Test
    fun aChildSignalBlocks() = runBlocking {
        val result = AgeSignalsResult.builder().setAgeLower(0).setAgeUpper(12).build()
        assertEquals(true, AgeGate.ask(manager(result), null) {})
    }

    @Test
    fun anAdultSignalDoesNotBlock() = runBlocking {
        val result = AgeSignalsResult.builder().setAgeLower(18).build()
        assertEquals(false, AgeGate.ask(manager(result), null) {})
    }

    @Test
    fun aFailureIsNoAnswer() = runBlocking {
        val manager = FakeAgeSignalsManager().apply {
            setNextApplicableAgeFeaturesException(AgeSignalsException(AgeSignalsErrorCode.PLAY_STORE_NOT_FOUND))
        }
        assertNull(AgeGate.ask(manager, null) {})
    }
}
