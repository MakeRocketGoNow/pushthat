package com.makerocketgonow.pushthat

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.jsoup.Jsoup
import org.junit.Assert.assertEquals
import org.junit.Test

/** Which icons a page offers, in what order, and the sizes they are cut to. Every page is made up. */
class PageIconsTest {

    private fun candidates(head: String, pageUrl: String = "https://www.example.com/blog/post/"): List<String> =
        PageIcons.candidates(Jsoup.parse("<html><head>$head</head><body></body></html>"), pageUrl.toHttpUrl())
            .map { it.toString() }

    @Test
    fun touchIconsComeFirstThenIconsThenTheFavicon() {
        val found = candidates(
            """
            <link rel="icon" href="/i.png">
            <link rel="apple-touch-icon" href="touch.png">
            <link rel="shortcut icon" href="//cdn.example.net/s.ico">
            <link rel="apple-touch-icon-precomposed" href="https://example.org/p.png">
            <link rel="stylesheet" href="/style.css">
            """,
        )
        assertEquals(
            listOf(
                "https://www.example.com/blog/post/touch.png",
                "https://example.org/p.png",
                "https://www.example.com/i.png",
                "https://cdn.example.net/s.ico",
                "https://www.example.com/favicon.ico",
            ),
            found,
        )
    }

    @Test
    fun relIsAListOfTokensInAnyCase() {
        val found = candidates("""<link rel="Shortcut  ICON" href="a.png"><link rel="mask-icon" href="m.png">""")
        assertEquals(listOf("https://www.example.com/blog/post/a.png", "https://www.example.com/favicon.ico"), found)
    }

    @Test
    fun svgIconsAreLeftOutByTypeOrPath() {
        val found = candidates(
            """
            <link rel="icon" type="image/svg+xml" href="/by-type">
            <link rel="icon" href="/logo.SVG?v=2">
            <link rel="icon" type="image/png" href="/ok.png">
            <link rel="apple-touch-icon" href="/touch.svg">
            """,
        )
        assertEquals(
            listOf(
                "https://www.example.com/touch.svg",
                "https://www.example.com/ok.png",
                "https://www.example.com/favicon.ico",
            ),
            found,
        )
    }

    @Test
    fun hrefsResolveAgainstTheFinalUrlNotABaseElement() {
        val found = candidates(
            """<base href="https://elsewhere.example/"><link rel="icon" href="../img/a.png">""",
            pageUrl = "http://example.com:8080/blog/post/page.html?q=1",
        )
        assertEquals(listOf("http://example.com:8080/blog/img/a.png", "http://example.com:8080/favicon.ico"), found)
    }

    @Test
    fun onlyHttpAndHttpsAreFetchedAndEachOnce() {
        val found = candidates(
            """
            <link rel="icon" href="data:image/png;base64,AAAA">
            <link rel="icon" href="javascript:void(0)">
            <link rel="icon" href="ftp://example.com/i.png">
            <link rel="icon" href="">
            <link rel="icon" href="/favicon.ico">
            <link rel="apple-touch-icon" href="/t.png">
            <link rel="icon" href="https://www.example.com/t.png">
            """,
        )
        assertEquals(listOf("https://www.example.com/t.png", "https://www.example.com/favicon.ico"), found)
    }

    @Test
    fun aPageWithoutLinksStillHasItsFavicon() {
        assertEquals(listOf("https://example.com/favicon.ico"), candidates("", pageUrl = "https://example.com"))
    }

    @Test
    fun manyLinksAreCutButTheFaviconStays() {
        val head = (1..20).joinToString("") { """<link rel="icon" href="/i$it.png">""" }
        val found = candidates(head)
        assertEquals(PageIcons.MAX_LINK_CANDIDATES + 1, found.size)
        assertEquals("https://www.example.com/i1.png", found.first())
        assertEquals("https://www.example.com/favicon.ico", found.last())
    }

    @Test
    fun anIconIsScaledDownToFitKeepingItsAspectAndNeverUp() {
        assertEquals(64 to 64, PageIcons.fit(180, 180, 64))
        assertEquals(64 to 32, PageIcons.fit(200, 100, 64))
        assertEquals(11 to 32, PageIcons.fit(100, 300, 32))
        assertEquals(16 to 16, PageIcons.fit(16, 16, 64))
        assertEquals(64 to 64, PageIcons.fit(64, 64, 64))
        assertEquals(64 to 1, PageIcons.fit(1000, 1, 64))
    }

    @Test
    fun aLargeImageIsSampledButNeverBelowTheIconsSize() {
        assertEquals(1, PageIcons.sampleSize(64, 64, 64))
        assertEquals(1, PageIcons.sampleSize(127, 20, 64))
        assertEquals(2, PageIcons.sampleSize(128, 128, 64))
        assertEquals(2, PageIcons.sampleSize(200, 200, 64))
        assertEquals(256, PageIcons.sampleSize(20_000, 10, 64))
    }
}
