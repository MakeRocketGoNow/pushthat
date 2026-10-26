package com.makerocketgonow.pushthat.e2ee

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.security.GeneralSecurityException

/**
 * `E2ee` against packages/push-test/vectors.json, vectors 1 (keys) and 2 (account), byte
 * for byte. The file is read where the reference writes it (the path comes from
 * app/build.gradle.kts) rather than copied into test resources, so a change to the
 * vectors fails this test instead of leaving a stale copy that still passes.
 */
class E2eeVectorsTest {
    private val vectors: JSONObject by lazy {
        val path = System.getProperty("pushthat.e2eeVectors")
            ?: error("pushthat.e2eeVectors is not set; run the test through Gradle")
        JSONObject(File(path).readText())
    }
    private val keys get() = vectors.getJSONObject("keys")
    private val account get() = vectors.getJSONObject("account")

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private fun fromHex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun wrapOf(json: JSONObject) = E2ee.Wrap(json.getString("by"), json.getString("n"), json.getString("ct"))

    @Test
    fun vector1_normalizesTheEmailAndThePassword() {
        assertEquals(keys.getString("normalizedEmail"), E2ee.normalizeEmail(keys.getString("email")))
        assertEquals(keys.getString("passwordNfcUtf8"), hex(E2ee.utf8(E2ee.nfc(keys.getString("password")))))
    }

    @Test
    fun vector1_derivesTheKeys() {
        assertEquals(E2ee.PBKDF2_ITERATIONS, keys.getInt("iterations"))
        assertEquals(E2ee.KDF, vectors.getString("kdf"))
        val derived = E2ee.deriveKeys(keys.getString("email"), keys.getString("password"))
        assertEquals(keys.getString("salt"), hex(derived.salt))
        assertEquals(keys.getString("stretched"), hex(derived.stretched))
        assertEquals(keys.getString("authKey"), hex(derived.authKey))
        assertEquals(keys.getString("masterKey"), hex(derived.masterKey))
        assertEquals(keys.getString("firebasePassword"), derived.firebasePassword)
        assertEquals(43, derived.firebasePassword.length)
    }

    @Test
    fun vector2_derivesTheSubkeys() {
        val subkeys = E2ee.accountSubkeys(fromHex(account.getString("accountKey")))
        assertEquals(account.getString("metaKey"), hex(subkeys.metaKey))
        assertEquals(account.getString("searchKey"), hex(subkeys.searchKey))
    }

    @Test
    fun vector2_wrapsUnderThePassword() {
        val uid = account.getString("uid")
        val accountKey = fromHex(account.getString("accountKey"))
        val masterKey = fromHex(keys.getString("masterKey"))
        val expected = account.getJSONObject("passwordWrap")
        assertEquals(account.getString("wrapAad"), hex(E2ee.wrapAad(uid)))

        val wrap = E2ee.wrapAccountKey(masterKey, accountKey, uid, E2ee.BY_PASSWORD, fromHex(expected.getString("nonce")))
        assertEquals(wrapOf(expected), wrap)
        assertArrayEquals(accountKey, E2ee.unwrapAccountKey(masterKey, wrapOf(expected), uid))
    }

    @Test
    fun vector2_encodesAndDecodesTheRecoveryKey() {
        val recovery = account.getJSONObject("recovery")
        val bytes = fromHex(recovery.getString("bytes"))
        val display = recovery.getString("display")
        assertEquals(display, E2ee.encodeRecoveryKey(bytes))
        assertArrayEquals(bytes, E2ee.decodeRecoveryKey(display))

        // Read back leniently: any case, spaces for hyphens, or none, l and o for 1 and 0.
        assertArrayEquals(bytes, E2ee.decodeRecoveryKey(display.lowercase()))
        assertArrayEquals(bytes, E2ee.decodeRecoveryKey(display.replace('-', ' ')))
        assertArrayEquals(bytes, E2ee.decodeRecoveryKey(display.replace("-", "")))
        val misread = display.replace('1', 'l').replace('0', 'o')
        assertNotEquals(display, misread)
        assertArrayEquals(bytes, E2ee.decodeRecoveryKey(misread))
        assertArrayEquals(bytes, E2ee.decodeRecoveryKey(display.replace('1', 'I').replace('0', 'O')))

        assertThrows(IllegalArgumentException::class.java) { E2ee.decodeRecoveryKey(display.dropLast(1)) }
        assertThrows(IllegalArgumentException::class.java) { E2ee.decodeRecoveryKey(display + "0") }
        assertThrows(IllegalArgumentException::class.java) { E2ee.decodeRecoveryKey(display.replace('8', 'U')) }
    }

    @Test
    fun vector2_wrapsUnderTheRecoveryKey() {
        val uid = account.getString("uid")
        val accountKey = fromHex(account.getString("accountKey"))
        val recovery = account.getJSONObject("recovery")
        val expected = recovery.getJSONObject("wrap")

        val wrappingKey = E2ee.recoveryWrappingKey(E2ee.decodeRecoveryKey(recovery.getString("display")))
        assertEquals(recovery.getString("wrappingKey"), hex(wrappingKey))

        val wrap = E2ee.wrapAccountKey(wrappingKey, accountKey, uid, E2ee.BY_RECOVERY, fromHex(expected.getString("nonce")))
        assertEquals(wrapOf(expected), wrap)
        assertArrayEquals(accountKey, E2ee.unwrapAccountKey(wrappingKey, wrapOf(expected), uid))
    }

    @Test
    fun aWrapDoesNotOpenUnderAnotherUid() {
        val masterKey = fromHex(keys.getString("masterKey"))
        val wrap = wrapOf(account.getJSONObject("passwordWrap"))
        assertThrows(GeneralSecurityException::class.java) {
            E2ee.unwrapAccountKey(masterKey, wrap, account.getString("uid") + "x")
        }
    }

    @Test
    fun aWrapDoesNotOpenUnderAnotherKey() {
        val uid = account.getString("uid")
        val recoveryKey = fromHex(account.getJSONObject("recovery").getString("wrappingKey"))
        val wraps = mapOf("pw" to wrapOf(account.getJSONObject("passwordWrap")))
        assertThrows(GeneralSecurityException::class.java) { E2ee.unwrapAccountKey(recoveryKey, wraps.getValue("pw"), uid) }
        assertEquals(null, E2ee.openAny(recoveryKey, wraps, uid, E2ee.BY_PASSWORD))
        val masterKey = fromHex(keys.getString("masterKey"))
        assertEquals("pw", E2ee.openAny(masterKey, wraps, uid, E2ee.BY_PASSWORD)?.first)
        assertEquals(null, E2ee.openAny(masterKey, wraps, uid, E2ee.BY_RECOVERY))
    }

    @Test
    fun aWrapWithAMalformedFieldFailsAsAWrongKey() {
        val masterKey = fromHex(keys.getString("masterKey"))
        val wrap = wrapOf(account.getJSONObject("passwordWrap"))
        assertThrows(GeneralSecurityException::class.java) {
            E2ee.unwrapAccountKey(masterKey, wrap.copy(n = wrap.n.dropLast(1)), account.getString("uid"))
        }
        assertThrows(GeneralSecurityException::class.java) {
            E2ee.unwrapAccountKey(masterKey, wrap.copy(ct = "!" + wrap.ct.drop(1)), account.getString("uid"))
        }
    }

    @Test
    fun theStoredShapesAreTheRulesShapes() {
        // firestore.rules: a wrapId is at most 16 characters, `n` 16 and `ct` 64.
        assertEquals(11, E2ee.newWrapId().length)
        assertEquals(22, E2ee.newDeviceId().length)
        val wrap = E2ee.wrapAccountKey(E2ee.randomBytes(32), E2ee.newAccountKey(), "uid", E2ee.BY_PASSWORD)
        assertEquals(16, wrap.n.length)
        assertEquals(64, wrap.ct.length)
        assertEquals(39, E2ee.encodeRecoveryKey(E2ee.newRecoveryKey()).length)
    }

    @Test
    fun base64urlIsUnpaddedAndBase64IsPadded() {
        val bytes = byteArrayOf(0xfb.toByte(), 0xff.toByte())
        assertEquals("-_8", E2ee.base64url(bytes))
        assertEquals("+/8=", E2ee.base64(bytes))
        assertArrayEquals(bytes, E2ee.fromBase64url("-_8"))
        assertArrayEquals(bytes, E2ee.fromBase64("+/8="))
        assertThrows(IllegalArgumentException::class.java) { E2ee.fromBase64("+/8") }
        assertThrows(IllegalArgumentException::class.java) { E2ee.fromBase64url("+/8") }
    }
}
