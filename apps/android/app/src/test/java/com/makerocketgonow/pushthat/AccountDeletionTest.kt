package com.makerocketgonow.pushthat

import com.makerocketgonow.pushthat.AccountDeletion.Answer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * How the app reads the `deleteAccount` function's response. The function's own suite
 * (functions/test/emulator) covers what it sends; this is the other side of that contract,
 * where a refusal ("nothing was deleted") is told from no answer ("it may have been").
 */
class AccountDeletionTest {
    private fun refusal(status: String, message: String) =
        """{"error":{"status":"$status","message":"$message"}}"""

    @Test
    fun `a 200 that says deleted is a deletion`() {
        assertSame(Answer.Deleted, AccountDeletion.answerOf(200, """{"result":{"deleted":true}}"""))
    }

    @Test
    fun `a 200 that does not say deleted is not taken for one`() {
        assertSame(Answer.Unknown, AccountDeletion.answerOf(200, """{"result":{}}"""))
        assertSame(Answer.Unknown, AccountDeletion.answerOf(200, """{"result":{"deleted":false}}"""))
        assertSame(Answer.Unknown, AccountDeletion.answerOf(200, ""))
    }

    @Test
    fun `each refusal the function makes before deleting is shown in its own words`() {
        val refusals = mapOf(
            "FAILED_PRECONDITION" to 400,
            "UNAVAILABLE" to 503,
            "UNAUTHENTICATED" to 401,
        )
        for ((status, code) in refusals) {
            val answer = AccountDeletion.answerOf(code, refusal(status, "A sentence for the person."))
            assertTrue("$status should be a refusal", answer is Answer.Refused)
            assertEquals("A sentence for the person.", (answer as Answer.Refused).message)
        }
    }

    @Test
    fun `an internal error says nothing about how far the deletion got`() {
        assertSame(Answer.Unknown, AccountDeletion.answerOf(500, refusal("INTERNAL", "INTERNAL")))
    }

    @Test
    fun `a status the app does not know is not shown as a refusal`() {
        assertSame(Answer.Unknown, AccountDeletion.answerOf(429, refusal("RESOURCE_EXHAUSTED", "Slow down.")))
    }

    @Test
    fun `a refusal with no sentence is not shown as one`() {
        assertSame(Answer.Unknown, AccountDeletion.answerOf(503, """{"error":{"status":"UNAVAILABLE","message":" "}}"""))
        assertSame(Answer.Unknown, AccountDeletion.answerOf(503, """{"error":{"status":"UNAVAILABLE"}}"""))
    }

    @Test
    fun `a gateway's error page is no answer`() {
        assertSame(Answer.Unknown, AccountDeletion.answerOf(504, "<html><body>504 Gateway Timeout</body></html>"))
        assertSame(Answer.Unknown, AccountDeletion.answerOf(502, null))
    }

    @Test
    fun `an error body on a 200 is not a deletion`() {
        assertTrue(AccountDeletion.answerOf(200, refusal("UNAVAILABLE", "Try again shortly.")) is Answer.Refused)
    }
}
