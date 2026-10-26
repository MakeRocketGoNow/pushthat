package com.makerocketgonow.pushthat.e2ee

import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.GeneralSecurityException
import java.security.MessageDigest

/**
 * A whole file through `E2ee`'s chunk format (docs/e2ee.md, Files), streamed: at most two
 * plaintext chunks and one sealed chunk in memory, whatever the file's size, so a 100 MB
 * share never sits in memory twice. Pure JVM like `E2ee`, so `E2eeVectorsTest` runs this
 * exact code on vector 5.
 */
object FileCipher {

    /**
     * Writes [source] encrypted under [fk] and [prefix] to [out] and returns the plaintext
     * length. The source says it has ended only when a read comes back empty, so one chunk
     * is held back: the next chunk is read before the current one is sealed, and a file
     * whose size is a multiple of 1 MiB has its last full chunk sealed as final rather than
     * followed by an empty one, which the decryptors refuse (`E2ee.chunkLayout`).
     */
    fun encrypt(fk: ByteArray, prefix: ByteArray, source: InputStream, out: OutputStream): Long {
        out.write(E2ee.fileHeader(prefix))
        var current = ByteArray(E2ee.CHUNK_SIZE)
        var next = ByteArray(E2ee.CHUNK_SIZE)
        var currentLength = readChunk(source, current)
        var index = 0
        var total = currentLength.toLong()
        while (true) {
            // A short chunk means the source is dry, so it is the last without reading on.
            val nextLength = if (currentLength < E2ee.CHUNK_SIZE) 0 else readChunk(source, next)
            val final = nextLength == 0
            out.write(E2ee.sealChunk(fk, prefix, index, current, final, currentLength))
            if (final) return total
            index++
            total += nextLength
            val swap = current
            current = next
            next = swap
            currentLength = nextLength
        }
    }

    /**
     * [source] encrypted into [dest], which is deleted if anything fails, so a half-written
     * file is never uploaded. Returns the plaintext length.
     */
    fun encryptToFile(fk: ByteArray, prefix: ByteArray, source: InputStream, dest: File): Long {
        try {
            return FileOutputStream(dest).buffered().use { out -> encrypt(fk, prefix, source, out) }
        } catch (e: Throwable) {
            dest.delete()
            throw e
        }
    }

    /**
     * Decrypts the encrypted object of [length] bytes read from [source] into [out]. [np] is
     * the envelope's prefix and is not optional: the header must carry the same bytes, which
     * ties the object to its push. Throws `GeneralSecurityException` for anything that is not
     * this push's file, after writing only chunks whose tags checked; the caller throws away
     * what was written (see [decryptToFile]).
     */
    fun decrypt(fk: ByteArray, np: ByteArray, source: InputStream, length: Long, out: OutputStream) {
        if (np.size != E2ee.FILE_PREFIX_LENGTH) throw GeneralSecurityException("the envelope's np is required")
        val layout = E2ee.chunkLayout(length)
        val input = DataInputStream(source)
        val header = ByteArray(E2ee.FILE_HEADER_LENGTH)
        readFully(input, header)
        if (!MessageDigest.isEqual(header.copyOfRange(0, 4), E2ee.utf8(E2ee.FILE_MAGIC))) {
            throw GeneralSecurityException("not an encrypted file")
        }
        val prefix = header.copyOfRange(4, E2ee.FILE_HEADER_LENGTH)
        if (!MessageDigest.isEqual(prefix, np)) throw GeneralSecurityException("file prefix does not match the push")
        val sealed = ByteArray(E2ee.SEALED_CHUNK_SIZE)
        for (span in layout) {
            readFully(input, sealed, span.length)
            out.write(E2ee.openChunk(fk, prefix, span.index, sealed, span.final, span.length))
        }
        // The layout came from the length the caller gave; bytes past it would mean the
        // object is not the one that length described.
        if (input.read() != -1) throw GeneralSecurityException("file longer than its length")
    }

    /**
     * [source] (a downloaded object) decrypted into [dest]. On any failure [dest] is deleted
     * before the exception goes on, so a tampered or truncated file never opens short.
     */
    fun decryptToFile(fk: ByteArray, np: ByteArray, source: File, dest: File) {
        try {
            FileInputStream(source).buffered().use { input ->
                FileOutputStream(dest).buffered().use { out -> decrypt(fk, np, input, source.length(), out) }
            }
        } catch (e: Throwable) {
            dest.delete()
            throw e
        }
    }

    /** Fills [buffer] from [source] unless it ends first; returns how much it read. */
    private fun readChunk(source: InputStream, buffer: ByteArray): Int {
        var filled = 0
        while (filled < buffer.size) {
            val n = source.read(buffer, filled, buffer.size - filled)
            if (n < 0) break
            filled += n
        }
        return filled
    }

    private fun readFully(input: DataInputStream, buffer: ByteArray, length: Int = buffer.size) {
        try {
            input.readFully(buffer, 0, length)
        } catch (e: EOFException) {
            throw GeneralSecurityException("file shorter than its length", e)
        }
    }
}
