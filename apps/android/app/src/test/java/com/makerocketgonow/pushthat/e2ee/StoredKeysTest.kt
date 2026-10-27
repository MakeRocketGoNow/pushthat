package com.makerocketgonow.pushthat.e2ee

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class StoredKeysTest {
    private val password = mapOf("by" to "password", "n" to "oKGio6Slpqeoqaqr", "ct" to "c".repeat(64))
    private val recovery = mapOf("by" to "recovery", "n" to "sLGys7S1tre4ubq7", "ct" to "d".repeat(64))
    private val migratedAt = Any()

    private fun stored(vararg extra: Pair<String, Any?>) = mapOf(
        "v" to 1L,
        "kdf" to E2ee.KDF,
        "keyVersion" to 2L,
        "wraps" to mapOf("a" to password, "b" to recovery),
    ) + extra

    @Test
    fun readsTheStoredMap() {
        val keys = StoredKeys.parse(stored())!!
        assertEquals(2L, keys.keyVersion)
        assertEquals(setOf("a", "b"), keys.wraps.keys)
        assertEquals(setOf("a"), keys.wrapsBy(E2ee.BY_PASSWORD).keys)
        assertTrue(keys.hasRecoveryWrap())
    }

    @Test
    fun aMissingOrMalformedMapIsNone() {
        assertNull(StoredKeys.parse(null))
        assertNull(StoredKeys.parse("e2ee"))
        assertNull(StoredKeys.parse(stored() - "keyVersion"))
        assertNull(StoredKeys.parse(stored("keyVersion" to 0L)))
        assertNull(StoredKeys.parse(stored("wraps" to listOf(password))))
        // A malformed wrap is left out rather than failing the rest.
        val keys = StoredKeys.parse(stored("wraps" to mapOf("a" to password, "b" to mapOf("by" to "recovery"))))!!
        assertEquals(setOf("a"), keys.wraps.keys)
        assertFalse(keys.hasRecoveryWrap())
    }

    @Test
    fun aRewriteKeepsTheFieldsItDidNotChange() {
        val keys = StoredKeys.parse(stored("migratedAt" to migratedAt))!!
        val written = keys.with(mapOf("c" to E2ee.Wrap("password", "n", "ct")))
        assertEquals(migratedAt, written["migratedAt"])
        assertEquals(2L, written["keyVersion"])
        assertEquals(mapOf("c" to mapOf("by" to "password", "n" to "n", "ct" to "ct")), written["wraps"])
        assertEquals(3L, keys.with(emptyMap(), keyVersion = 3)["keyVersion"])
    }

    @Test
    fun aFreshMapHasEveryFieldTheRulesRequire() {
        val written = StoredKeys.fresh(emptyMap())
        assertEquals(setOf("v", "kdf", "keyVersion", "wraps"), written.keys)
        assertEquals(1L, written["v"])
        assertEquals(1L, written["keyVersion"])
    }

    @Test
    fun moreWrapsThanTheRulesTakeAreRefusedBeforeTheWrite() {
        val five = (1..5).associate { "w$it" to E2ee.Wrap("password", "n", "ct") }
        assertThrows(IllegalArgumentException::class.java) { StoredKeys.fresh(five) }
    }
}
