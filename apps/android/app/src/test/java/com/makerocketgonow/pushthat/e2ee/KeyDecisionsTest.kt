package com.makerocketgonow.pushthat.e2ee

import com.makerocketgonow.pushthat.e2ee.StoredKeys.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What `AccountKeys` decides from the stored keys, and which wraps each rewrite keeps. The
 * rules refuse a map with more than four wraps, and a refused write fails the same way on
 * every retry, so each rewrite is checked against the limit from the fullest map it can
 * meet.
 */
class KeyDecisionsTest {
    private fun password(tag: String) = E2ee.Wrap(E2ee.BY_PASSWORD, "n-$tag", "ct-$tag")
    private fun recovery(tag: String) = E2ee.Wrap(E2ee.BY_RECOVERY, "n-$tag", "ct-$tag")

    private fun keys(vararg wraps: Pair<String, E2ee.Wrap>, keyVersion: Long = 1) =
        StoredKeys(mapOf("migratedAt" to "kept"), keyVersion, linkedMapOf(*wraps))

    // -------------------------------------------------------------------------------------
    // The sign-in decision

    @Test
    fun aLegacySignInWhosePasswordOpensReplacesTheRecoveryKey() {
        val stored = keys("p" to password("p"), "r" to recovery("r"))
        assertEquals(Decision.OPEN_AND_REPLACE_RECOVERY, StoredKeys.decide(stored, opened = true, legacy = true))
        assertEquals(Decision.OPEN, StoredKeys.decide(stored, opened = true, legacy = false))
    }

    @Test
    fun aPasswordThatOpensNothingAsksForTheRecoveryKeyWhenThereIsAWrapForIt() {
        val stored = keys("p" to password("p"), "r" to recovery("r"))
        assertEquals(Decision.ASK_FOR_RECOVERY, StoredKeys.decide(stored, opened = false, legacy = false))
        assertEquals(Decision.ASK_FOR_RECOVERY, StoredKeys.decide(stored, opened = false, legacy = true))
    }

    @Test
    fun aPasswordThatOpensNothingWithNoRecoveryWrapStartsNewKeys() {
        val stored = keys("p" to password("p"))
        assertEquals(Decision.START_NEW_KEYS, StoredKeys.decide(stored, opened = false, legacy = true))
        assertEquals(Decision.START_NEW_KEYS, StoredKeys.decide(keys(), opened = false, legacy = false))
    }

    @Test
    fun anAccountWithNoKeysStartsNewKeys() {
        assertEquals(Decision.START_NEW_KEYS, StoredKeys.decide(null, opened = false, legacy = false))
        assertEquals(Decision.START_NEW_KEYS, StoredKeys.decide(null, opened = false, legacy = true))
    }

    // -------------------------------------------------------------------------------------
    // Whether the keys changed since a decision

    @Test
    fun theSameKeysAreTheSameVersionAndWraps() {
        val read = keys("p" to password("p"), "r" to recovery("r"))
        assertTrue(StoredKeys.same(keys("p" to password("p"), "r" to recovery("r")), read))
        assertTrue(StoredKeys.same(null, null))
    }

    @Test
    fun aRewrapOrANewVersionIsAChange() {
        val read = keys("p" to password("p"), "r" to recovery("r"))
        // Another device rewrapped: same version, another wrap id.
        assertFalse(StoredKeys.same(keys("p" to password("p"), "s" to recovery("s")), read))
        // Another device started over: a new version.
        assertFalse(StoredKeys.same(keys("p" to password("p"), "r" to recovery("r"), keyVersion = 2), read))
        // Keys written where there were none, or gone.
        assertFalse(StoredKeys.same(read, null))
        assertFalse(StoredKeys.same(null, read))
    }

    // -------------------------------------------------------------------------------------
    // What each rewrite keeps

    @Test
    fun aRecoveryKeepsTheOpenedRecoveryWrapFirstAndFitsTheNewPasswordWrap() {
        // Four recovery wraps (the most the rules allow), and the opened one stored last.
        val stored = keys("r1" to recovery("1"), "r2" to recovery("2"), "r3" to recovery("3"), "r4" to recovery("4"))
        val kept = stored.keptForRecovery("r4")
        assertEquals(listOf("r4", "r1", "r2"), kept.keys.toList())
        val written = stored.with(mapOf("new" to password("new")) + kept)
        assertEquals(StoredKeys.MAX_WRAPS, (written["wraps"] as Map<*, *>).size)
    }

    @Test
    fun aRecoveryDropsThePasswordWrapsThatOpenedNothing() {
        val stored = keys("p1" to password("1"), "p2" to password("2"), "r" to recovery("r"))
        assertEquals(setOf("r"), stored.keptForRecovery("r").keys)
    }

    @Test
    fun aPasswordChangeFromOnePasswordAndThreeRecoveryWrapsStaysWithinFour() {
        val stored = keys("p" to password("p"), "r1" to recovery("1"), "r2" to recovery("2"), "r3" to recovery("3"))
        val kept = stored.keptForPasswordChange(listOf("p"))
        assertEquals(listOf("p", "r1", "r2"), kept.keys.toList())
        val written = stored.with(kept + ("new" to password("new")))
        val wraps = written["wraps"] as Map<*, *>
        assertEquals(StoredKeys.MAX_WRAPS, wraps.size)
        assertEquals("kept", written["migratedAt"])

        // Once the Firebase password has changed, the old wrap goes, leaving room.
        val after = StoredKeys.parse(written)!!
        val remaining = after.wraps.filterKeys { it != "p" }
        assertEquals(setOf("r1", "r2", "new"), remaining.keys)
        assertTrue(after.with(remaining).isNotEmpty())
    }

    @Test
    fun aPasswordChangeKeepsOneOpenedPasswordWrapAndDropsTheOnesNothingOpens() {
        val stored = keys("old" to password("old"), "a" to password("a"), "b" to password("b"), "r" to recovery("r"))
        assertEquals(listOf("a", "r"), stored.keptForPasswordChange(listOf("a", "b")).keys.toList())
    }

    @Test
    fun aNewRecoveryKeyKeepsThePreferredPasswordWrapAndReplacesEveryRecoveryWrap() {
        val stored = keys("p1" to password("1"), "p2" to password("2"), "p3" to password("3"), "r" to recovery("r"))
        assertEquals(listOf("p3", "p1", "p2"), stored.keptForNewRecoveryKey("p3").keys.toList())
        assertEquals(listOf("p1", "p2", "p3"), stored.keptForNewRecoveryKey(null).keys.toList())

        val full = keys("p1" to password("1"), "p2" to password("2"), "p3" to password("3"), "p4" to password("4"))
        val written = full.with(full.keptForNewRecoveryKey("p4") + ("new" to recovery("new")))
        assertEquals(listOf("p4", "p1", "p2", "new"), (written["wraps"] as Map<*, *>).keys.toList())
    }

    @Test
    fun aMapOverTheRulesLimitIsRefusedBeforeItIsWritten() {
        val stored = keys("p" to password("p"))
        val five = (1..5).associate { "w$it" to password("$it") }
        assertThrows(IllegalArgumentException::class.java) { stored.with(five) }
    }
}
