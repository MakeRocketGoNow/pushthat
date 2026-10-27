package com.makerocketgonow.pushthat.e2ee

import org.json.JSONArray
import org.json.JSONObject
import java.security.GeneralSecurityException

/**
 * What a push's envelope holds (docs/e2ee.md, The push envelope): the JSON object that is
 * encrypted, as the app reads and writes it. The spec fixes the field names and types, not
 * the bytes, so this is whatever `org.json` writes (Android's escapes `/`, which every JSON
 * parser reads back the same).
 */
sealed class PushContent {
    abstract val type: String

    /** What the blind index is built from: a URL push is found by its host and path too. */
    abstract val searchText: String

    abstract fun toJson(): ByteArray

    data class Url(val url: String, val title: String, val ext: String) : PushContent() {
        override val type get() = TYPE_URL
        override val searchText get() = "$title $url"
        override fun toJson(): ByteArray =
            E2ee.utf8(JSONObject().put("url", url).put("title", title).put("ext", ext).toString())
    }

    /**
     * A file push. [fk] and [np] are the file's key and nonce prefix; a push migrated from
     * plaintext has neither and [legacyPlain] set, since its object was uploaded unencrypted
     * and is opened as it is.
     */
    class File(
        val name: String,
        val mime: String,
        val size: Long,
        val ext: String,
        val fk: ByteArray?,
        val np: ByteArray?,
        val legacyPlain: Boolean = false,
    ) : PushContent() {
        override val type get() = TYPE_FILE
        override val searchText get() = name
        override fun toJson(): ByteArray {
            val json = JSONObject().put("name", name).put("mime", mime).put("size", size).put("ext", ext)
            if (legacyPlain) {
                json.put("legacyPlain", true)
            } else {
                json.put("fk", E2ee.base64(requireNotNull(fk))).put("np", E2ee.base64(requireNotNull(np)))
            }
            return E2ee.utf8(json.toString())
        }
    }

    companion object {
        const val TYPE_URL = "url"
        const val TYPE_FILE = "file"

        /**
         * The envelope's JSON for a push of [type]. Throws `GeneralSecurityException` for
         * anything this app could not act on (not JSON, a field missing, a key of the wrong
         * length), which the list shows as a locked row rather than a crash.
         */
        fun parse(type: String?, json: ByteArray): PushContent {
            try {
                val obj = JSONObject(String(json, Charsets.UTF_8))
                return when (type) {
                    TYPE_URL -> Url(obj.getString("url"), obj.optString("title", ""), obj.optString("ext", ""))
                    TYPE_FILE -> {
                        val legacyPlain = obj.optBoolean("legacyPlain", false)
                        val fk = if (legacyPlain) null else E2ee.fromBase64(obj.getString("fk"))
                        val np = if (legacyPlain) null else E2ee.fromBase64(obj.getString("np"))
                        if (fk != null && fk.size != E2ee.KEY_LENGTH) throw GeneralSecurityException("fk is not a key")
                        if (np != null && np.size != E2ee.FILE_PREFIX_LENGTH) throw GeneralSecurityException("np is not a prefix")
                        File(
                            name = obj.getString("name"),
                            mime = obj.optString("mime", ""),
                            size = obj.optLong("size", 0),
                            ext = obj.optString("ext", ""),
                            fk = fk,
                            np = np,
                            legacyPlain = legacyPlain,
                        )
                    }
                    else -> throw GeneralSecurityException("unknown push type $type")
                }
            } catch (e: GeneralSecurityException) {
                throw e
            } catch (e: Exception) {
                // JSONException and IllegalArgumentException (base64) alike.
                throw GeneralSecurityException("not a push envelope", e)
            }
        }
    }
}

/**
 * What this install encrypts pushes with: the subkeys of the account key it holds, the
 * version stored beside that key (never one read fresh from the user document: the rules
 * refuse a push under any version but the account's current one, and that refusal is what
 * stops a device whose key a reset replaced from writing pushes nobody can open), and its
 * `deviceId`.
 */
class PushKeys(
    val uid: String,
    val keyVersion: Long,
    val metaKey: ByteArray,
    val searchKey: ByteArray,
    val deviceId: String,
) {
    companion object {
        fun of(uid: String, accountKey: ByteArray, keyVersion: Long, deviceId: String): PushKeys {
            val subkeys = E2ee.accountSubkeys(accountKey)
            return PushKeys(uid, keyVersion, subkeys.metaKey, subkeys.searchKey, deviceId)
        }
    }
}

/** The envelope would not fit the rules' bound on `enc.ct`: refused here rather than there. */
class PushTooLargeException : Exception("the push is too large to encrypt")

/**
 * A push ready to write: its id, picked before it was encrypted since the AAD names it,
 * and every field of the document but `createdAt` (a server timestamp, added by the
 * writer). The retry queue keeps this whole, so every attempt writes the same id and the
 * same ciphertext, and a write that did land the first time is found rather than doubled.
 */
class PreparedPush(
    val id: String,
    val userId: String,
    val type: String,
    val enc: E2ee.Envelope,
    val searchTokens: List<String>,
    val keyVersion: Long,
    val deviceId: String,
    val objectPath: String?,
) {
    /**
     * The document's fields without `createdAt`. Exactly what `isEncryptedPushFields`
     * allows: no `url`, `title`, `deviceName` or `ext`, and `objectPath` only on a file.
     */
    fun fields(): Map<String, Any> = buildMap {
        put("userId", userId)
        put("type", type)
        put("deviceId", deviceId)
        put("keyVersion", keyVersion)
        put("enc", enc.toMap())
        put("searchTokens", searchTokens)
        objectPath?.let { put("objectPath", it) }
    }

    /** For the retry queue (`PendingPush.prepared`). */
    fun toJson(): String = JSONObject()
        .put("id", id)
        .put("userId", userId)
        .put("type", type)
        .put("enc", JSONObject().put("v", enc.v).put("n", enc.n).put("ct", enc.ct))
        .put("searchTokens", JSONArray(searchTokens))
        .put("keyVersion", keyVersion)
        .put("deviceId", deviceId)
        .apply { objectPath?.let { put("objectPath", it) } }
        .toString()

    companion object {
        /** The rules' bound on `enc.ct`, in base64 characters (about 12 KB of JSON). */
        const val MAX_CT_LENGTH = 16384

        /** A title past this is cut before it is encrypted; a page title is never this long. */
        const val MAX_TITLE_LENGTH = 1000

        /**
         * Encrypts [content] as push [pushId] of [keys]'s account. Throws
         * [PushTooLargeException] when even the cut title leaves the envelope past the
         * rules' bound, which only an absurd URL reaches.
         */
        fun prepare(keys: PushKeys, pushId: String, content: PushContent, objectPath: String? = null): PreparedPush {
            require((content.type == PushContent.TYPE_FILE) == (objectPath != null)) { "objectPath is for file pushes" }
            val cut = if (content is PushContent.Url && content.title.length > MAX_TITLE_LENGTH) {
                content.copy(title = cutTitle(content.title))
            } else {
                content
            }
            val enc = E2ee.sealPush(keys.metaKey, keys.uid, pushId, cut.toJson())
            if (enc.ct.length > MAX_CT_LENGTH) throw PushTooLargeException()
            val tokens = E2ee.blindIndex(keys.searchKey, E2ee.searchTokens(cut.searchText))
            return PreparedPush(pushId, keys.uid, cut.type, enc, tokens, keys.keyVersion, keys.deviceId, objectPath)
        }

        /**
         * [title] cut to [MAX_TITLE_LENGTH] UTF-16 units, less a high surrogate the cut left
         * without its pair: UTF-8 has no encoding for a lone one and writes it as "?", so an
         * emoji at the cut came back as a question mark.
         */
        fun cutTitle(title: String): String {
            val cut = title.take(MAX_TITLE_LENGTH)
            return if (cut.isNotEmpty() && cut.last().isHighSurrogate()) cut.dropLast(1) else cut
        }

        fun fromJson(json: String): PreparedPush {
            val obj = JSONObject(json)
            val enc = obj.getJSONObject("enc")
            val tokens = obj.getJSONArray("searchTokens")
            return PreparedPush(
                id = obj.getString("id"),
                userId = obj.getString("userId"),
                type = obj.getString("type"),
                enc = E2ee.Envelope(enc.getLong("v"), enc.getString("n"), enc.getString("ct")),
                searchTokens = List(tokens.length()) { tokens.getString(it) },
                keyVersion = obj.getLong("keyVersion"),
                deviceId = obj.getString("deviceId"),
                objectPath = if (obj.has("objectPath")) obj.getString("objectPath") else null,
            )
        }
    }
}

/**
 * Reading and migrating `pushes/{id}` documents, as maps, so the JVM test covers both
 * shapes without Firestore.
 */
object PushDocument {

    /** A push as the list and the notification see it. */
    sealed class Read {
        /** An encrypted push this install opened. */
        data class Opened(val content: PushContent) : Read()

        /** A push from before the envelope: its fields as they are in the document. */
        data class Plain(val type: String?, val url: String, val title: String, val ext: String?) : Read()

        /**
         * Encrypted under a key this install does not hold (another `keyVersion`, after a
         * reset without the recovery key) or not openable: deleted, never opened.
         */
        data object Locked : Read()
    }

    /**
     * The push [id] whose fields are [data]. A plaintext push without a `url` is null, as
     * the list has always skipped it.
     */
    fun read(keys: PushKeys, id: String, data: Map<String, Any?>): Read? {
        if (!data.containsKey("enc")) {
            val url = data["url"] as? String ?: return null
            return Read.Plain(data["type"] as? String, url, data["title"] as? String ?: "", data["ext"] as? String)
        }
        val version = (data["keyVersion"] as? Number)?.toLong()
        val enc = E2ee.Envelope.parse(data["enc"])
        val userId = data["userId"] as? String
        if (version != keys.keyVersion || enc == null || userId == null) return Read.Locked
        return try {
            // The AAD from the document's own userId and id, so an envelope copied onto
            // another push fails here.
            Read.Opened(PushContent.parse(data["type"] as? String, E2ee.openPush(keys.metaKey, userId, id, enc)))
        } catch (e: GeneralSecurityException) {
            Read.Locked
        }
    }

    /** The fields an encrypted push keeps; a migration deletes every other one. */
    private val ENCRYPTED_FIELDS = setOf(
        "userId", "type", "createdAt", "expiresAt", "deviceId", "keyVersion", "enc", "searchTokens", "objectPath",
    )

    /** One plaintext push's update to the encrypted shape: fields to set and fields to delete. */
    class Migration(val set: Map<String, Any>, val delete: Set<String>)

    /**
     * The update that encrypts plaintext push [id] in place (docs/e2ee.md, Migration;
     * `isMigration` in the rules), or null for one that is left as it is: already
     * encrypted, a type the envelope has no shape for, or a file push with no title the
     * rules would take as an object name.
     *
     * A file push's bytes stay plaintext in Storage until they expire, so its envelope says
     * `legacyPlain` and carries no key; `objectPath` is the title-derived path the rules
     * require, the one `onPushRecordDeleted` has been deleting with it. `userId`, `type`,
     * `createdAt` and `expiresAt` are never touched; every other field not in the encrypted
     * shape goes, including any an old client wrote that no client writes now.
     */
    fun migration(keys: PushKeys, id: String, data: Map<String, Any?>): Migration? {
        if (data.containsKey("enc")) return null
        val title = data["title"] as? String
        val ext = data["ext"] as? String ?: ""
        val (content, objectPath) = when (data["type"]) {
            PushContent.TYPE_URL -> PushContent.Url(data["url"] as? String ?: "", title ?: "", ext) to null
            PushContent.TYPE_FILE -> {
                // The rules hold objectPath to one name under the owner's folder, so a title
                // that is empty or has a slash in it could never migrate; it is left rather
                // than failing every pass.
                if (title.isNullOrEmpty() || '/' in title) return null
                val userId = data["userId"] as? String ?: keys.uid
                PushContent.File(title, "", 0, ext, null, null, legacyPlain = true) to "uploads/$userId/$title"
            }
            else -> return null
        }
        val prepared = PreparedPush.prepare(keys, id, content, objectPath)
        val set = prepared.fields() - "userId" - "type"
        return Migration(set, data.keys - ENCRYPTED_FIELDS)
    }
}
