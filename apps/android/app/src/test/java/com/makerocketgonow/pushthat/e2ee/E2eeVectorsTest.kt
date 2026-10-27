package com.makerocketgonow.pushthat.e2ee

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.security.GeneralSecurityException
import java.security.MessageDigest

/**
 * `E2ee` and `FileCipher` against packages/push-test/vectors.json, vectors 1 (keys), 2
 * (account), 3 (push), 4 (search), 5 (file) and 6 (empty file), byte for byte. The file is read where the reference writes it (the path comes from
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
    private val push get() = vectors.getJSONObject("push")
    private val search get() = vectors.getJSONObject("search")
    private val file get() = vectors.getJSONObject("file")
    private val emptyFile get() = vectors.getJSONObject("emptyFile")

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private fun fromHex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun sha256Hex(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

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

    // -------------------------------------------------------------------------------------
    // Vector 3: the push envelope

    @Test
    fun vector3_sealsThePush() {
        val metaKey = fromHex(account.getString("metaKey"))
        val userId = push.getString("userId")
        val pushId = push.getString("pushId")
        val plaintext = fromHex(push.getString("plaintextUtf8"))
        assertEquals(push.getString("plaintext"), String(plaintext, Charsets.UTF_8))
        assertEquals(push.getString("aad"), hex(E2ee.pushAad(userId, pushId)))

        val enc = E2ee.sealPush(metaKey, userId, pushId, plaintext, fromHex(push.getString("nonce")))
        val expected = push.getJSONObject("enc")
        assertEquals(expected.getLong("v"), enc.v)
        assertEquals(expected.getString("n"), enc.n)
        assertEquals(expected.getString("ct"), enc.ct)
        assertArrayEquals(plaintext, E2ee.openPush(metaKey, userId, pushId, enc))
    }

    @Test
    fun vector3_opensOnlyAsItsOwnPush() {
        val metaKey = fromHex(account.getString("metaKey"))
        val userId = push.getString("userId")
        val pushId = push.getString("pushId")
        val json = push.getJSONObject("enc")
        val enc = E2ee.Envelope(json.getLong("v"), json.getString("n"), json.getString("ct"))
        assertThrows(GeneralSecurityException::class.java) { E2ee.openPush(metaKey, userId, pushId + "x", enc) }
        assertThrows(GeneralSecurityException::class.java) { E2ee.openPush(metaKey, userId + "x", pushId, enc) }
        assertThrows(GeneralSecurityException::class.java) {
            E2ee.openPush(fromHex(account.getString("searchKey")), userId, pushId, enc)
        }
        assertThrows(GeneralSecurityException::class.java) { E2ee.openPush(metaKey, userId, pushId, enc.copy(v = 2)) }
        assertThrows(GeneralSecurityException::class.java) { E2ee.openPush(metaKey, userId, pushId, enc.copy(n = "!")) }

        // And the parsed object is the push the vector describes.
        val content = PushContent.parse("url", E2ee.openPush(metaKey, userId, pushId, enc)) as PushContent.Url
        assertEquals("https://example.com/docs/report?v=2#summary", content.url)
        assertEquals("Example report", content.title)
        assertEquals("html", content.ext)
    }

    // -------------------------------------------------------------------------------------
    // Vector 4: the blind index

    @Test
    fun vector4_tokenizesAndBlinds() {
        val searchKey = fromHex(account.getString("searchKey"))
        val tokens = E2ee.searchTokens(search.getString("text"))
        val expectedTokens = search.getJSONArray("tokens")
        assertEquals(List(expectedTokens.length()) { expectedTokens.getString(it) }, tokens)

        val expectedBlind = search.getJSONArray("blind")
        val blind = List(expectedBlind.length()) { expectedBlind.getString(it) }
        assertEquals(blind, tokens.map { E2ee.blindToken(searchKey, it) })
        assertEquals(blind, E2ee.blindIndex(searchKey, tokens))

        // A search for the term's first word looks up that word's own token.
        assertEquals(blind[5], E2ee.searchTermToken(searchKey, "GitHub repo"))
        assertEquals(blind[5], E2ee.searchTermToken(searchKey, "  github!"))
        assertEquals(null, E2ee.searchTermToken(searchKey, " -- "))
        assertEquals(null, E2ee.searchTermToken(searchKey, ""))
    }

    // -------------------------------------------------------------------------------------
    // Vectors 5 and 6: files

    /** The vector's plaintext, byte i being i mod 251, without holding it. */
    private fun patternStream(length: Long): InputStream = object : InputStream() {
        private var position = 0L
        override fun read(): Int = if (position >= length) -1 else (position++ % 251).toInt()
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (position >= length) return -1
            // Short reads on purpose, as a content provider's stream may give them.
            val n = minOf(len.toLong(), length - position, 70_001L).toInt()
            for (i in 0 until n) b[off + i] = (position++ % 251).toByte()
            return n
        }
    }

    private fun encryptVectorFile(): ByteArray {
        val out = ByteArrayOutputStream()
        val length = FileCipher.encrypt(fromHex(file.getString("fk")), fromHex(file.getString("np")), patternStream(file.getLong("length")), out)
        assertEquals(file.getLong("length"), length)
        return out.toByteArray()
    }

    private fun decrypt(encrypted: ByteArray, np: ByteArray = fromHex(file.getString("np"))): ByteArray {
        val out = ByteArrayOutputStream()
        FileCipher.decrypt(fromHex(file.getString("fk")), np, ByteArrayInputStream(encrypted), encrypted.size.toLong(), out)
        return out.toByteArray()
    }

    @Test
    fun vector5_encryptsTheFileStreaming() {
        val encrypted = encryptVectorFile()
        assertEquals(file.getLong("encryptedLength"), encrypted.size.toLong())
        assertEquals(file.getString("header"), hex(encrypted.copyOfRange(0, E2ee.FILE_HEADER_LENGTH)))
        assertEquals(file.getString("encryptedSha256"), sha256Hex(encrypted))
        assertEquals(file.getString("plaintextSha256"), sha256Hex(decrypt(encrypted)))
        assertEquals(file.getString("fkBase64"), E2ee.base64(fromHex(file.getString("fk"))))
        assertEquals(file.getString("npBase64"), E2ee.base64(fromHex(file.getString("np"))))
    }

    @Test
    fun vector5_refusesATamperedFile() {
        val tampered = encryptVectorFile()
        val offset = file.getInt("tamperOffset")
        tampered[offset] = (tampered[offset].toInt() xor 0x01).toByte()
        assertEquals(file.getString("tamperedSha256"), sha256Hex(tampered))
        assertThrows(GeneralSecurityException::class.java) { decrypt(tampered) }
    }

    @Test
    fun vector5_refusesReorderedChunks() {
        val encrypted = encryptVectorFile()
        val h = E2ee.FILE_HEADER_LENGTH
        val s = E2ee.SEALED_CHUNK_SIZE
        val reordered = encrypted.copyOf()
        System.arraycopy(encrypted, h + s, reordered, h, s)
        System.arraycopy(encrypted, h, reordered, h + s, s)
        assertEquals(file.getString("reorderedSha256"), sha256Hex(reordered))
        assertThrows(GeneralSecurityException::class.java) { decrypt(reordered) }
    }

    @Test
    fun vector5_refusesAnotherPushsPrefixAndATruncatedFile() {
        val encrypted = encryptVectorFile()
        val otherNp = fromHex(file.getString("np")).also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertThrows(GeneralSecurityException::class.java) { decrypt(encrypted, otherNp) }
        assertThrows(GeneralSecurityException::class.java) { decrypt(encrypted, ByteArray(0)) }
        // Cut at a chunk boundary: the new last chunk was not sealed as final.
        val cut = encrypted.copyOf(E2ee.FILE_HEADER_LENGTH + 2 * E2ee.SEALED_CHUNK_SIZE)
        assertThrows(GeneralSecurityException::class.java) { decrypt(cut) }
        // A stream shorter than the length it claims.
        assertThrows(GeneralSecurityException::class.java) {
            FileCipher.decrypt(fromHex(file.getString("fk")), fromHex(file.getString("np")),
                ByteArrayInputStream(encrypted.copyOf(encrypted.size - 1)), encrypted.size.toLong(), ByteArrayOutputStream())
        }
    }

    @Test
    fun vector5_decryptToFileDeletesThePartialOutput() {
        val dir = java.nio.file.Files.createTempDirectory("e2ee").toFile()
        try {
            val tampered = encryptVectorFile()
            val offset = file.getInt("tamperOffset")
            tampered[offset] = (tampered[offset].toInt() xor 0x01).toByte()
            val source = File(dir, "object").apply { writeBytes(tampered) }
            val dest = File(dir, "plain")
            assertThrows(GeneralSecurityException::class.java) {
                FileCipher.decryptToFile(fromHex(file.getString("fk")), fromHex(file.getString("np")), source, dest)
            }
            assertEquals(false, dest.exists())

            source.writeBytes(encryptVectorFile())
            FileCipher.decryptToFile(fromHex(file.getString("fk")), fromHex(file.getString("np")), source, dest)
            assertEquals(file.getString("plaintextSha256"), sha256Hex(dest.readBytes()))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun aFileOfWholeChunksSealsItsLastChunkAsFinal() {
        val fk = fromHex(file.getString("fk"))
        val np = fromHex(file.getString("np"))
        val out = ByteArrayOutputStream()
        FileCipher.encrypt(fk, np, patternStream(2L * E2ee.CHUNK_SIZE), out)
        val encrypted = out.toByteArray()
        assertEquals(E2ee.FILE_HEADER_LENGTH + 2L * E2ee.SEALED_CHUNK_SIZE, encrypted.size.toLong())
        assertEquals(2 * E2ee.CHUNK_SIZE, decrypt(encrypted).size)
    }

    // The size the share sheet checks against the tier's limit is the one the Storage rules
    // will measure: the vectors' encrypted lengths, without encrypting anything.
    @Test
    fun encryptedFileSizeIsTheSizeOfTheObject() {
        assertEquals(file.getLong("encryptedLength"), E2ee.encryptedFileSize(file.getLong("length")))
        assertEquals(emptyFile.getString("encrypted").length / 2L, E2ee.encryptedFileSize(0))
        assertEquals(12L + E2ee.CHUNK_SIZE + 16, E2ee.encryptedFileSize(E2ee.CHUNK_SIZE.toLong()))
    }

    @Test
    fun vector6_encryptsTheEmptyFile() {
        val fk = fromHex(emptyFile.getString("fk"))
        val np = fromHex(emptyFile.getString("np"))
        val out = ByteArrayOutputStream()
        assertEquals(0L, FileCipher.encrypt(fk, np, ByteArrayInputStream(ByteArray(0)), out))
        val encrypted = out.toByteArray()
        assertEquals(emptyFile.getString("encrypted"), hex(encrypted))
        assertEquals(28, encrypted.size)
        assertEquals(emptyFile.getString("encryptedSha256"), sha256Hex(encrypted))
        val plain = ByteArrayOutputStream()
        FileCipher.decrypt(fk, np, ByteArrayInputStream(encrypted), encrypted.size.toLong(), plain)
        assertEquals(0, plain.size())
    }

    @Test
    fun chunkLayoutRefusesWhatNoFileIs() {
        val h = E2ee.FILE_HEADER_LENGTH.toLong()
        val s = E2ee.SEALED_CHUNK_SIZE.toLong()
        val tag = E2ee.TAG_LENGTH.toLong()
        // One full chunk followed by a bare tag: an empty final chunk after a full one.
        assertThrows(GeneralSecurityException::class.java) { E2ee.chunkLayout(h + s + tag) }
        // A last chunk shorter than its tag.
        assertThrows(GeneralSecurityException::class.java) { E2ee.chunkLayout(h + s + tag - 1) }
        assertThrows(GeneralSecurityException::class.java) { E2ee.chunkLayout(h + tag - 1) }
        assertThrows(GeneralSecurityException::class.java) { E2ee.chunkLayout(0) }

        // The empty file, one full chunk, and one full plus one byte.
        assertEquals(listOf(E2ee.ChunkSpan(0, h, h + tag, true)), E2ee.chunkLayout(h + tag))
        assertEquals(listOf(E2ee.ChunkSpan(0, h, h + s, true)), E2ee.chunkLayout(h + s))
        assertEquals(
            listOf(E2ee.ChunkSpan(0, h, h + s, false), E2ee.ChunkSpan(1, h + s, h + s + tag + 1, true)),
            E2ee.chunkLayout(h + s + tag + 1),
        )
        val layout = E2ee.chunkLayout(file.getLong("encryptedLength"))
        assertEquals(4, layout.size)
        assertEquals(listOf(false, false, false, true), layout.map { it.final })
    }

    @Test
    fun sealChunkRefusesTheWrongSizes() {
        val fk = fromHex(file.getString("fk"))
        val np = fromHex(file.getString("np"))
        assertThrows(IllegalArgumentException::class.java) { E2ee.sealChunk(fk, np, 0, ByteArray(10), false) }
        assertThrows(IllegalArgumentException::class.java) { E2ee.sealChunk(fk, np, 1, ByteArray(0), true) }
        assertThrows(IllegalArgumentException::class.java) { E2ee.sealChunk(fk, np, 0, ByteArray(E2ee.CHUNK_SIZE + 1), true) }
    }
}
