package com.makerocketgonow.pushthat.e2ee

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The tokenizer's cases beyond vector 4, and the push documents built from `E2ee`: what is
 * written, what the list reads back from both shapes, and the migration's update. Every
 * value is made up.
 */
class PushDocumentTest {
    private val keys = PushKeys.of("someone-uid", ByteArray(32) { it.toByte() }, keyVersion = 2, deviceId = "device-a")

    // -------------------------------------------------------------------------------------
    // The tokenizer

    @Test
    fun composedAndDecomposedLettersTokenizeAlike() {
        val composed = "café"
        val decomposed = "café"
        assertEquals(listOf("c", "ca", "caf", "café"), E2ee.searchTokens(composed))
        assertEquals(E2ee.searchTokens(composed), E2ee.searchTokens(decomposed))
        assertEquals(E2ee.searchTokens(composed.uppercase()), E2ee.searchTokens(decomposed))
    }

    @Test
    fun punctuationAndUnderscoreSplitAndDigitsStay() {
        assertEquals(listOf("a", "ab", "c", "1", "12"), E2ee.searchTokens("ab_c, (12)!"))
        assertEquals(listOf("v", "v2"), E2ee.searchTokens("--v2--"))
        assertEquals(emptyList<String>(), E2ee.searchTokens(" .,;- "))
    }

    @Test
    fun otherScriptsAreWordsToo() {
        assertEquals(listOf("п", "пр", "при", "прив", "приве", "привет"), E2ee.searchTokens("Привет"))
        assertEquals(listOf("東", "東京"), E2ee.searchTokens("東京"))
    }

    @Test
    fun prefixesCountCodePointsNotChars() {
        // U+20BB7 is two UTF-16 chars; a prefix never ends between them.
        val word = "𠮷a"
        assertEquals(listOf("𠮷", word), E2ee.searchTokens(word))
    }

    @Test
    fun repeatsAreDroppedInFirstSeenOrder() {
        assertEquals(listOf("g", "go", "a", "ap"), E2ee.searchTokens("go go ap g"))
    }

    @Test
    fun theTokensStopAtTheRulesBound() {
        val long = (1..200).joinToString(" ") { "w$it" + "x".repeat(40) }
        val tokens = E2ee.searchTokens(long)
        assertEquals(E2ee.MAX_SEARCH_TOKENS, tokens.size)
        assertEquals(tokens, tokens.distinct())
    }

    // -------------------------------------------------------------------------------------
    // Writing

    @Test
    fun aUrlPushHasOnlyTheEncryptedFields() {
        val content = PushContent.Url("https://example.com/a/b.pdf", "", "pdf")
        val prepared = PreparedPush.prepare(keys, "push-1", content)
        val fields = prepared.fields()
        assertEquals(setOf("userId", "type", "deviceId", "keyVersion", "enc", "searchTokens"), fields.keys)
        assertEquals(2L, fields["keyVersion"])
        assertEquals("url", fields["type"])
        assertEquals("device-a", fields["deviceId"])
        assertEquals(16, prepared.enc.n.length)
        // An untitled URL is still found by its host.
        assertTrue(E2ee.blindToken(keys.searchKey, "example") in prepared.searchTokens)

        val read = PushDocument.read(keys, "push-1", fields)
        assertEquals(PushDocument.Read.Opened(content), read)
    }

    @Test
    fun aFilePushCarriesItsKeyAndPath() {
        val fk = E2ee.newFileKey()
        val np = E2ee.newFilePrefix()
        val content = PushContent.File("Report (final) v2.pdf", "application/pdf", 1234, "pdf", fk, np)
        val prepared = PreparedPush.prepare(keys, "push-2", content, "uploads/someone-uid/objectid")
        val fields = prepared.fields()
        assertEquals("uploads/someone-uid/objectid", fields["objectPath"])
        assertTrue(E2ee.blindToken(keys.searchKey, "report") in prepared.searchTokens)

        val opened = (PushDocument.read(keys, "push-2", fields) as PushDocument.Read.Opened).content as PushContent.File
        assertEquals("Report (final) v2.pdf", opened.name)
        assertEquals(1234L, opened.size)
        assertArrayEquals(fk, opened.fk)
        assertArrayEquals(np, opened.np)
        assertEquals(false, opened.legacyPlain)
    }

    @Test
    fun aPreparedPushSurvivesTheRetryQueue() {
        val prepared = PreparedPush.prepare(keys, "push-3", PushContent.Url("https://example.com", "Example", ""))
        val back = PreparedPush.fromJson(prepared.toJson())
        assertEquals(prepared.fields(), back.fields())
        assertEquals("push-3", back.id)
        val file = PreparedPush.prepare(keys, "push-4", PushContent.File("a.txt", "text/plain", 1, "txt", ByteArray(32), ByteArray(8)), "uploads/someone-uid/x")
        assertEquals(file.fields(), PreparedPush.fromJson(file.toJson()).fields())
    }

    @Test
    fun anAbsurdPushIsRefusedHereAndALongTitleIsCut() {
        val longTitle = "t".repeat(5000)
        val prepared = PreparedPush.prepare(keys, "push-5", PushContent.Url("https://example.com", longTitle, ""))
        val opened = (PushDocument.read(keys, "push-5", prepared.fields()) as PushDocument.Read.Opened).content as PushContent.Url
        assertEquals(PreparedPush.MAX_TITLE_LENGTH, opened.title.length)

        val absurdUrl = "https://example.com/" + "a".repeat(20_000)
        assertThrows(PushTooLargeException::class.java) {
            PreparedPush.prepare(keys, "push-6", PushContent.Url(absurdUrl, "", ""))
        }
    }

    // -------------------------------------------------------------------------------------
    // Reading

    @Test
    fun anotherKeyVersionOrAMovedEnvelopeIsLocked() {
        val fields = PreparedPush.prepare(keys, "push-7", PushContent.Url("https://example.com", "", "")).fields()
        assertEquals(PushDocument.Read.Locked, PushDocument.read(keys, "push-8", fields))
        assertEquals(PushDocument.Read.Locked, PushDocument.read(keys, "push-7", fields + ("keyVersion" to 1L)))
        assertEquals(PushDocument.Read.Locked, PushDocument.read(keys, "push-7", fields + ("enc" to "nonsense")))
        val otherKeys = PushKeys.of("someone-uid", ByteArray(32), keyVersion = 2, deviceId = "device-a")
        assertEquals(PushDocument.Read.Locked, PushDocument.read(otherKeys, "push-7", fields))
    }

    @Test
    fun aPlaintextPushReadsAsBefore() {
        val data = mapOf("userId" to "someone-uid", "type" to "url", "url" to "https://example.com", "title" to "Example", "ext" to null)
        assertEquals(PushDocument.Read.Plain("url", "https://example.com", "Example", null), PushDocument.read(keys, "p", data))
        assertNull(PushDocument.read(keys, "p", data - "url"))
    }

    // -------------------------------------------------------------------------------------
    // Migration

    @Test
    fun aUrlPushMigratesInPlace() {
        val data = mapOf(
            "userId" to "someone-uid", "type" to "url", "createdAt" to "a timestamp",
            "url" to "https://example.com/page", "title" to "A page", "deviceName" to "Pixel",
            "ext" to null, "searchTokens" to listOf("a"), "somethingOld" to 1,
        )
        val migration = PushDocument.migration(keys, "push-9", data)!!
        assertEquals(setOf("url", "title", "deviceName", "ext", "somethingOld"), migration.delete)
        assertEquals(setOf("deviceId", "keyVersion", "enc", "searchTokens"), migration.set.keys)

        val after = data - migration.delete + migration.set
        val opened = (PushDocument.read(keys, "push-9", after) as PushDocument.Read.Opened).content
        assertEquals(PushContent.Url("https://example.com/page", "A page", ""), opened)
        @Suppress("UNCHECKED_CAST")
        val tokens = migration.set["searchTokens"] as List<String>
        assertEquals(E2ee.blindIndex(keys.searchKey, E2ee.searchTokens("A page https://example.com/page")), tokens)
    }

    @Test
    fun aFilePushMigratesAsLegacyPlain() {
        val data = mapOf(
            "userId" to "someone-uid", "type" to "file", "createdAt" to "a timestamp", "expiresAt" to "later",
            "url" to "https://storage.example.com/token", "title" to "notes.txt", "ext" to "txt", "deviceName" to "Pixel",
        )
        val migration = PushDocument.migration(keys, "push-10", data)!!
        assertEquals("uploads/someone-uid/notes.txt", migration.set["objectPath"])
        assertEquals(setOf("url", "title", "ext", "deviceName"), migration.delete)
        val after = data - migration.delete + migration.set
        val opened = (PushDocument.read(keys, "push-10", after) as PushDocument.Read.Opened).content as PushContent.File
        assertEquals("notes.txt", opened.name)
        assertEquals(true, opened.legacyPlain)
        assertNull(opened.fk)
    }

    @Test
    fun whatCannotMigrateIsLeft() {
        val encrypted = PreparedPush.prepare(keys, "p", PushContent.Url("https://example.com", "", "")).fields()
        assertNull(PushDocument.migration(keys, "p", encrypted))
        assertNull(PushDocument.migration(keys, "p", mapOf("userId" to "someone-uid", "type" to "file")))
        assertNull(PushDocument.migration(keys, "p", mapOf("userId" to "someone-uid", "type" to "file", "title" to "a/b")))
        assertNull(PushDocument.migration(keys, "p", mapOf("userId" to "someone-uid", "type" to "note", "title" to "x")))
    }
}
