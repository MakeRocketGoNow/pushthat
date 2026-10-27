package com.makerocketgonow.pushthat.e2ee

import java.security.GeneralSecurityException
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.io.encoding.Base64

/**
 * The constructions of docs/e2ee.md (keys, the recovery key, the push envelope, the blind
 * index and the file chunks), in the order the specification gives them, checked byte for
 * byte against packages/push-test/vectors.json by `E2eeVectorsTest`. Streaming a whole file
 * through the chunks is `FileCipher`.
 *
 * Pure JVM on purpose: nothing here touches an Android class, so the unit test runs the
 * exact code the phone runs rather than a copy of it. The one thing that differs between
 * the two is the security provider (SunJCE on the test's JVM, Conscrypt on the phone),
 * which is why PBKDF2 is written out below instead of asked for by name.
 */
object E2ee {
    const val KDF = "pbkdf2-sha256-600000"
    const val PBKDF2_ITERATIONS = 600_000
    const val NONCE_LENGTH = 12
    const val TAG_LENGTH = 16
    const val KEY_LENGTH = 32
    const val RECOVERY_KEY_LENGTH = 20

    const val BY_PASSWORD = "password"
    const val BY_RECOVERY = "recovery"

    private val random = SecureRandom()

    /** What a password and an email derive to. `authKey` and `masterKey` are dropped once used. */
    class Keys(
        val salt: ByteArray,
        val stretched: ByteArray,
        val authKey: ByteArray,
        val masterKey: ByteArray,
        /** `base64url(authKey)`: what Firebase Auth is given as the password, never the password. */
        val firebasePassword: String,
    )

    class Subkeys(val metaKey: ByteArray, val searchKey: ByteArray)

    /** One entry of `users/{uid}.e2ee.wraps`, as stored: `n` and `ct` are padded base64. */
    data class Wrap(val by: String, val n: String, val ct: String)

    // -------------------------------------------------------------------------------------
    // Primitives

    fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray = mac(key).doFinal(message)

    /**
     * A keyed HMAC-SHA256. `SecretKeySpec` refuses an empty key, which HMAC itself allows:
     * HMAC pads a short key with zeros to the block size, so an empty key and one zero byte
     * are the same key, and that is what an empty one becomes here.
     */
    private fun mac(key: ByteArray): Mac = Mac.getInstance("HmacSHA256").apply {
        init(SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, "HmacSHA256"))
    }

    private val ZERO_KEY = ByteArray(32)

    /**
     * HKDF-SHA256 with an empty salt and one block of output, written out as the spec does:
     * extract with a key of 32 zero bytes, then expand with `label || 0x01`.
     */
    fun hkdfOneBlock(ikm: ByteArray, label: String): ByteArray {
        val prk = hmacSha256(ZERO_KEY, ikm)
        return hmacSha256(prk, utf8(label) + byteArrayOf(0x01))
    }

    fun aesGcmSeal(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray {
        require(nonce.size == NONCE_LENGTH) { "nonce must be $NONCE_LENGTH bytes" }
        return gcm(Cipher.ENCRYPT_MODE, key, nonce, aad).doFinal(plaintext)
    }

    /** Throws `GeneralSecurityException` on a bad tag, a bad AAD or a truncated ciphertext. */
    fun aesGcmOpen(key: ByteArray, nonce: ByteArray, ciphertext: ByteArray, aad: ByteArray): ByteArray {
        require(nonce.size == NONCE_LENGTH) { "nonce must be $NONCE_LENGTH bytes" }
        if (ciphertext.size < TAG_LENGTH) throw GeneralSecurityException("ciphertext shorter than its tag")
        return gcm(Cipher.DECRYPT_MODE, key, nonce, aad).doFinal(ciphertext)
    }

    private fun gcm(mode: Int, key: ByteArray, nonce: ByteArray, aad: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_LENGTH * 8, nonce))
            updateAAD(aad)
        }

    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }

    fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    fun nfc(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFC)

    // -------------------------------------------------------------------------------------
    // Encodings
    //
    // Kotlin's Base64 rather than java.util.Base64, which needs API 26 where minSdk is 24,
    // and rather than android.util.Base64, which the JVM test cannot run. Standard base64
    // with padding is what `n` and `ct` carry in a document; base64url without padding is
    // what goes into a string a user or a URL might see (the Firebase password, ids). Both
    // decoders refuse what the alphabet or the padding rules out, so a field edited by hand
    // fails here and not on a tag.

    private val base64Padded = Base64.Default.withPadding(Base64.PaddingOption.PRESENT)
    private val base64UrlUnpadded = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT)

    fun base64(bytes: ByteArray): String = base64Padded.encode(bytes)
    fun fromBase64(s: String): ByteArray = base64Padded.decode(s)
    fun base64url(bytes: ByteArray): String = base64UrlUnpadded.encode(bytes)
    fun fromBase64url(s: String): ByteArray = base64UrlUnpadded.decode(s)

    // -------------------------------------------------------------------------------------
    // Keys from the password and the email

    /**
     * ASCII-only after NFC, so that no locale or Unicode table can enter the salt: only
     * space, tab, CR and LF are trimmed (Kotlin's `trim()` would take any Unicode
     * whitespace) and only A-Z are lowered (`lowercase()` would lower every script).
     */
    fun normalizeEmail(email: String): String {
        val trimmed = nfc(email).trim { it == ' ' || it == '\t' || it == '\r' || it == '\n' }
        return buildString(trimmed.length) {
            for (c in trimmed) append(if (c in 'A'..'Z') c + ('a' - 'A') else c)
        }
    }

    fun emailSalt(email: String): ByteArray = sha256(utf8("pushthat/salt/v1:" + normalizeEmail(email)))

    /**
     * PBKDF2-HMAC-SHA256 for one 32-byte block, over the password's NFC UTF-8 bytes (not
     * trimmed: a space a user typed is part of their password).
     *
     * Written out over a keyed `Mac` rather than `SecretKeyFactory("PBKDF2WithHmacSHA256")`,
     * which takes the password as a `char[]` and leaves turning it into bytes to the
     * provider: SunJCE (where the unit test runs) and the phone's Conscrypt or BouncyCastle
     * have not always agreed on that for characters outside ASCII, and the vector's
     * password has one. Here the bytes are ours, so the bytes the test checks are the
     * bytes the phone uses. One `Mac`, initialised once and reused by `doFinal`, keeps the
     * 600,000 rounds about as fast as the provider's own loop.
     */
    fun stretch(password: String, salt: ByteArray, iterations: Int = PBKDF2_ITERATIONS): ByteArray {
        require(iterations >= 1) { "iterations must be at least 1" }
        val prf = mac(utf8(nfc(password)))
        // Block index 1, big-endian: the only block, since the output is one hash long.
        var u = prf.doFinal(salt + byteArrayOf(0, 0, 0, 1))
        val t = u.copyOf()
        for (i in 1 until iterations) {
            u = prf.doFinal(u)
            for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
        }
        return t
    }

    fun firebasePassword(authKey: ByteArray): String = base64url(authKey)

    /** About a second on a phone: never on the main thread. */
    fun deriveKeys(email: String, password: String): Keys {
        val salt = emailSalt(email)
        val stretched = stretch(password, salt)
        val authKey = hkdfOneBlock(stretched, "pushthat/auth/v1")
        val masterKey = hkdfOneBlock(stretched, "pushthat/master/v1")
        return Keys(salt, stretched, authKey, masterKey, firebasePassword(authKey))
    }

    // -------------------------------------------------------------------------------------
    // The account key and what hangs off it

    fun newAccountKey(): ByteArray = randomBytes(KEY_LENGTH)

    fun accountSubkeys(accountKey: ByteArray): Subkeys = Subkeys(
        metaKey = hkdfOneBlock(accountKey, "pushthat/meta/v1"),
        searchKey = hkdfOneBlock(accountKey, "pushthat/search/v1"),
    )

    fun newWrapId(): String = base64url(randomBytes(8))
    fun newDeviceId(): String = base64url(randomBytes(16))

    fun wrapAad(uid: String): ByteArray = utf8("pushthat/wrap/v1:$uid")

    /**
     * `accountKey` under `masterKey` (by "password") or the recovery wrapping key (by
     * "recovery"). The nonce parameter exists for the vectors; callers never pass one.
     */
    fun wrapAccountKey(
        wrappingKey: ByteArray,
        accountKey: ByteArray,
        uid: String,
        by: String,
        nonce: ByteArray = randomBytes(NONCE_LENGTH),
    ): Wrap {
        require(accountKey.size == KEY_LENGTH) { "accountKey must be $KEY_LENGTH bytes" }
        require(by == BY_PASSWORD || by == BY_RECOVERY) { "unknown wrap: $by" }
        val ct = aesGcmSeal(wrappingKey, nonce, accountKey, wrapAad(uid))
        return Wrap(by, base64(nonce), base64(ct))
    }

    /** Throws `GeneralSecurityException` when the key, the uid or the wrap is wrong. */
    fun unwrapAccountKey(wrappingKey: ByteArray, wrap: Wrap, uid: String): ByteArray {
        val nonce: ByteArray
        val ct: ByteArray
        try {
            nonce = fromBase64(wrap.n)
            ct = fromBase64(wrap.ct)
        } catch (e: IllegalArgumentException) {
            throw GeneralSecurityException("not a wrap", e)
        }
        if (nonce.size != NONCE_LENGTH) throw GeneralSecurityException("not a wrap")
        val accountKey = aesGcmOpen(wrappingKey, nonce, ct, wrapAad(uid))
        if (accountKey.size != KEY_LENGTH) throw GeneralSecurityException("unwrapped key is not $KEY_LENGTH bytes")
        return accountKey
    }

    /** The account key from the first wrap of kind [by] that [wrappingKey] opens, with its id. */
    fun openAny(wrappingKey: ByteArray, wraps: Map<String, Wrap>, uid: String, by: String): Pair<String, ByteArray>? {
        for ((id, wrap) in wraps) {
            if (wrap.by != by) continue
            try {
                return id to unwrapAccountKey(wrappingKey, wrap, uid)
            } catch (_: GeneralSecurityException) {
                // Another wrap may be the one this key opens.
            }
        }
        return null
    }

    // -------------------------------------------------------------------------------------
    // The recovery key
    //
    // Crockford's alphabet in RFC 4648 bit order (most significant bit first, five bits a
    // symbol). 20 bytes are 160 bits, exactly 32 symbols: no padding, no check symbol.

    private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    fun newRecoveryKey(): ByteArray = randomBytes(RECOVERY_KEY_LENGTH)

    /** The display form: 32 symbols in eight groups of four, joined by hyphens. */
    fun encodeRecoveryKey(bytes: ByteArray): String {
        require(bytes.size == RECOVERY_KEY_LENGTH) { "recovery key must be $RECOVERY_KEY_LENGTH bytes" }
        var bits = 0
        var acc = 0
        val out = StringBuilder()
        for (b in bytes) {
            acc = ((acc shl 8) or (b.toInt() and 0xff)) and 0xffff
            bits += 8
            while (bits >= 5) {
                out.append(CROCKFORD[(acc ushr (bits - 5)) and 31])
                bits -= 5
            }
        }
        return out.chunked(4).joinToString("-")
    }

    /**
     * Lenient, which is the point of the alphabet: case does not matter, hyphens and spaces
     * are dropped, and I and L read as 1, O as 0. Throws `IllegalArgumentException` for
     * anything that is not 32 symbols.
     */
    fun decodeRecoveryKey(text: String): ByteArray {
        val symbols = text.uppercase()
            .filter { it != '-' && it != ' ' }
            .map { c -> when (c) { 'I', 'L' -> '1'; 'O' -> '0'; else -> c } }
        require(symbols.size == 32) { "a recovery key has 32 symbols" }
        val out = ByteArray(RECOVERY_KEY_LENGTH)
        var bits = 0
        var acc = 0
        var i = 0
        for (c in symbols) {
            val v = CROCKFORD.indexOf(c)
            require(v >= 0) { "not a recovery key symbol: $c" }
            acc = ((acc shl 5) or v) and 0xffff
            bits += 5
            if (bits >= 8) {
                out[i++] = ((acc ushr (bits - 8)) and 0xff).toByte()
                bits -= 8
            }
        }
        return out
    }

    /** Over the 20 raw bytes, never the text. */
    fun recoveryWrappingKey(recoveryBytes: ByteArray): ByteArray {
        require(recoveryBytes.size == RECOVERY_KEY_LENGTH) { "recovery key must be $RECOVERY_KEY_LENGTH bytes" }
        return hkdfOneBlock(recoveryBytes, "pushthat/recovery/v1")
    }

    // -------------------------------------------------------------------------------------
    // The push envelope

    /** `pushes/{id}.enc` as stored: `n` and `ct` are padded base64. */
    data class Envelope(val v: Long, val n: String, val ct: String) {
        fun toMap(): Map<String, Any> = mapOf("v" to v, "n" to n, "ct" to ct)

        companion object {
            /** The stored map, or null when it is not one (a locked row, not a crash). */
            fun parse(value: Any?): Envelope? {
                val map = value as? Map<*, *> ?: return null
                val v = (map["v"] as? Number)?.toLong() ?: return null
                val n = map["n"] as? String ?: return null
                val ct = map["ct"] as? String ?: return null
                return Envelope(v, n, ct)
            }
        }
    }

    const val ENVELOPE_VERSION = 1L

    fun pushAad(userId: String, pushId: String): ByteArray = utf8("pushthat/push/v1:$userId:$pushId")

    /**
     * [plaintext] is the envelope's JSON as bytes (`PushContent.toJson`). The AAD binds it
     * to its document, which is why the id is picked before the push is encrypted. The
     * nonce parameter exists for the vectors; callers never pass one.
     */
    fun sealPush(
        metaKey: ByteArray,
        userId: String,
        pushId: String,
        plaintext: ByteArray,
        nonce: ByteArray = randomBytes(NONCE_LENGTH),
    ): Envelope {
        val ct = aesGcmSeal(metaKey, nonce, plaintext, pushAad(userId, pushId))
        return Envelope(ENVELOPE_VERSION, base64(nonce), base64(ct))
    }

    /** Throws `GeneralSecurityException` for a wrong key, another push's envelope, or a malformed one. */
    fun openPush(metaKey: ByteArray, userId: String, pushId: String, enc: Envelope): ByteArray {
        if (enc.v != ENVELOPE_VERSION) throw GeneralSecurityException("unknown envelope version ${enc.v}")
        val nonce: ByteArray
        val ct: ByteArray
        try {
            nonce = fromBase64(enc.n)
            ct = fromBase64(enc.ct)
        } catch (e: IllegalArgumentException) {
            throw GeneralSecurityException("not an envelope", e)
        }
        if (nonce.size != NONCE_LENGTH) throw GeneralSecurityException("not an envelope")
        return aesGcmOpen(metaKey, nonce, ct, pushAad(userId, pushId))
    }

    // -------------------------------------------------------------------------------------
    // The blind index
    //
    // The one tokenizer every client runs (docs/e2ee.md, Search): NFC, then the
    // locale-independent full lowercase mapping (Kotlin's `lowercase()` is `Locale.ROOT`, so a
    // Turkish phone lowers "I" the way every other device does), split on anything that is
    // not a letter, a combining mark or a number, and every prefix of every word counted in
    // code points. Code points rather than chars so that an emoji or a CJK extension
    // character is never cut in half into a lone surrogate, which would hash as U+FFFD and
    // match nothing another client wrote. This replaced Android's own generator, which
    // dropped every non-ASCII letter through `\w` and kept `_`: once the tokens are blinded,
    // two generators mean two indexes that never find each other's pushes.

    /** The rules' bound on `searchTokens`. */
    const val MAX_SEARCH_TOKENS = 3000

    private val NOT_A_WORD = Regex("[^\\p{L}\\p{M}\\p{N}]+")

    /** The words of [text], normalized as the tokens are: what a search term is split into too. */
    fun searchWords(text: String): List<String> =
        nfc(text).lowercase().split(NOT_A_WORD).filter { it.isNotEmpty() }

    /**
     * Every prefix of every word, first-seen order, no repeats, at most [MAX_SEARCH_TOKENS]
     * (which only a title and URL of thousands of characters reach).
     */
    fun searchTokens(text: String): List<String> {
        val tokens = LinkedHashSet<String>()
        for (word in searchWords(text)) {
            var end = 0
            while (end < word.length) {
                if (tokens.size == MAX_SEARCH_TOKENS) return tokens.toList()
                end += Character.charCount(word.codePointAt(end))
                tokens.add(word.substring(0, end))
            }
        }
        return tokens.toList()
    }

    /** 16 base64url characters are 96 bits exactly, so nothing is cut mid-character. */
    fun blindToken(searchKey: ByteArray, token: String): String =
        base64url(hmacSha256(searchKey, utf8(token))).substring(0, 16)

    /** One `Mac` for the whole list: a title and URL make a few hundred tokens. */
    fun blindIndex(searchKey: ByteArray, tokens: List<String>): List<String> {
        val mac = mac(searchKey)
        return tokens.map { base64url(mac.doFinal(utf8(it))).substring(0, 16) }
    }

    /**
     * The blind token a search for [term] looks up: its first word, whole. A term with no
     * word in it (empty, or only punctuation) is no search at all, so null. "github repo"
     * searches "github": `array-contains` takes one value, and the first word is what the
     * user typed first.
     */
    fun searchTermToken(searchKey: ByteArray, term: String): String? =
        searchWords(term).firstOrNull()?.let { blindToken(searchKey, it) }

    // -------------------------------------------------------------------------------------
    // Files: the chunk format (docs/e2ee.md, Files)

    const val CHUNK_SIZE = 1024 * 1024
    const val FILE_MAGIC = "PTE1"
    const val FILE_PREFIX_LENGTH = 8
    const val FILE_HEADER_LENGTH = 12
    const val SEALED_CHUNK_SIZE = CHUNK_SIZE + TAG_LENGTH

    /**
     * The size of a file of [plaintextBytes] once encrypted: the header and one tag per chunk,
     * the empty file's one included. What the Storage rules measure against the tier's limit.
     */
    fun encryptedFileSize(plaintextBytes: Long): Long {
        val chunks = maxOf(1L, (plaintextBytes + CHUNK_SIZE - 1) / CHUNK_SIZE)
        return FILE_HEADER_LENGTH + plaintextBytes + TAG_LENGTH * chunks
    }

    fun newFileKey(): ByteArray = randomBytes(KEY_LENGTH)
    fun newFilePrefix(): ByteArray = randomBytes(FILE_PREFIX_LENGTH)
    fun newObjectId(): String = base64url(randomBytes(16))

    fun fileHeader(prefix: ByteArray): ByteArray {
        require(prefix.size == FILE_PREFIX_LENGTH) { "prefix must be $FILE_PREFIX_LENGTH bytes" }
        return utf8(FILE_MAGIC) + prefix
    }

    private fun be32(n: Int): ByteArray {
        require(n >= 0) { "not a chunk index: $n" }
        return byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())
    }

    private fun chunkNonce(prefix: ByteArray, index: Int) = prefix + be32(index)

    private fun chunkAad(index: Int, final: Boolean) =
        utf8("pushthat/file/v1") + be32(index) + byteArrayOf(if (final) 1 else 0)

    /**
     * Seals the first [length] bytes of [chunk]. Every chunk but the last is exactly
     * [CHUNK_SIZE]; only the empty file has an empty final chunk (see [chunkLayout] for why
     * the other encoding is refused).
     */
    fun sealChunk(
        fk: ByteArray,
        prefix: ByteArray,
        index: Int,
        chunk: ByteArray,
        final: Boolean,
        length: Int = chunk.size,
    ): ByteArray {
        require(if (final) length <= CHUNK_SIZE else length == CHUNK_SIZE) { "chunk $index is $length bytes" }
        require(!(final && index > 0 && length == 0)) { "only the empty file has an empty final chunk" }
        val cipher = gcm(Cipher.ENCRYPT_MODE, fk, chunkNonce(prefix, index), chunkAad(index, final))
        return cipher.doFinal(chunk, 0, length)
    }

    /** Throws `GeneralSecurityException` for a chunk of the wrong size, place or file. */
    fun openChunk(
        fk: ByteArray,
        prefix: ByteArray,
        index: Int,
        sealed: ByteArray,
        final: Boolean,
        length: Int = sealed.size,
    ): ByteArray {
        val plain = length - TAG_LENGTH
        if (plain < 0 || (if (final) plain > CHUNK_SIZE else plain != CHUNK_SIZE)) {
            throw GeneralSecurityException("chunk $index is $length bytes")
        }
        val cipher = gcm(Cipher.DECRYPT_MODE, fk, chunkNonce(prefix, index), chunkAad(index, final))
        return cipher.doFinal(sealed, 0, length)
    }

    /** Where sealed chunk [index] sits in an encrypted object, `[start, end)`. */
    data class ChunkSpan(val index: Int, val start: Long, val end: Long, val final: Boolean) {
        val length: Int get() = (end - start).toInt()
    }

    /**
     * The chunks of an encrypted object of [length] bytes, from the length alone: every
     * chunk but the last is exactly [SEALED_CHUNK_SIZE], so the count is the body over that,
     * rounded up, and the remainder is the last. The last holds at least its tag, and only
     * the empty file has an empty one: a full chunk followed by a bare tag is what an
     * encryptor that did not hold a chunk back would write, and it is refused so that no
     * client accepts a second encoding of the same bytes that another refuses. Throws
     * `GeneralSecurityException` for a length no file has.
     */
    fun chunkLayout(length: Long): List<ChunkSpan> {
        if (length < FILE_HEADER_LENGTH + TAG_LENGTH) throw GeneralSecurityException("file too short")
        val body = length - FILE_HEADER_LENGTH
        val count = (body + SEALED_CHUNK_SIZE - 1) / SEALED_CHUNK_SIZE
        if (count > Int.MAX_VALUE) throw GeneralSecurityException("file too long")
        val last = body - (count - 1) * SEALED_CHUNK_SIZE
        if (last < TAG_LENGTH || (count > 1 && last == TAG_LENGTH.toLong())) {
            throw GeneralSecurityException("not a file: bad last chunk")
        }
        return List(count.toInt()) { index ->
            val start = FILE_HEADER_LENGTH + index.toLong() * SEALED_CHUNK_SIZE
            val final = index.toLong() == count - 1
            ChunkSpan(index, start, if (final) length else start + SEALED_CHUNK_SIZE, final)
        }
    }
}
