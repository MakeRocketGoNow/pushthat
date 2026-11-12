package com.makerocketgonow.pushthat

import org.jsoup.Jsoup
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Which of a page's icons [Favicons] picks. The fetch around it needs a network and is not
 * tested here; the choice is the part with rules in it.
 */
class FaviconsTest {
    private fun icons(head: String, base: String = "https://example.com/") =
        Favicons.iconsIn(Jsoup.parse("<html><head>$head</head><body></body></html>", base))

    @Test
    fun `a page with no icon names none`() {
        assertEquals(emptyList<String>(), icons("""<link rel="stylesheet" href="/site.css">"""))
    }

    @Test
    fun `a relative address is resolved against the page`() {
        assertEquals(
            listOf("https://example.com/static/icon.png"),
            icons("""<link rel="icon" href="static/icon.png">""")
        )
        assertEquals(
            listOf("https://cdn.example.com/icon.png"),
            icons("""<link rel="shortcut icon" href="//cdn.example.com/icon.png">""")
        )
    }

    @Test
    fun `the largest declared size comes first`() {
        assertEquals(
            listOf("https://example.com/192.png", "https://example.com/apple.png", "https://example.com/32.png"),
            icons(
                """
                <link rel="icon" sizes="32x32" href="/32.png">
                <link rel="apple-touch-icon" href="/apple.png">
                <link rel="icon" sizes="16x16 192x192" href="/192.png">
                """
            )
        )
    }

    @Test
    fun `an icon with no size comes after the sized ones`() {
        assertEquals(
            listOf("https://example.com/48.png", "https://example.com/favicon.ico"),
            icons("""<link rel="icon" href="/favicon.ico"><link rel="icon" sizes="48x48" href="/48.png">""")
        )
    }

    @Test
    fun `what cannot be drawn is left out`() {
        assertEquals(
            listOf("https://example.com/icon.png"),
            icons(
                """
                <link rel="icon" type="image/svg+xml" href="/icon.svg">
                <link rel="icon" href="/other.svg?v=2">
                <link rel="mask-icon" href="/mask.svg" color="#000">
                <link rel="icon" href="data:image/png;base64,AAAA">
                <link rel="icon" href="/icon.png">
                """
            )
        )
    }

    @Test
    fun `no more than three are tried`() {
        val many = (1..6).joinToString("") { """<link rel="icon" sizes="${it * 16}x${it * 16}" href="/$it.png">""" }
        assertEquals(
            listOf("https://example.com/6.png", "https://example.com/5.png", "https://example.com/4.png"),
            icons(many)
        )
    }

    @Test
    fun `rel is matched whatever its case`() {
        assertEquals(listOf("https://example.com/i.png"), icons("""<link rel="ICON" href="/i.png">"""))
    }
}
