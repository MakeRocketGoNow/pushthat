package com.makerocketgonow.pushthat.e2ee

/**
 * `users/{uid}.e2ee` as read (docs/e2ee.md, "The user document"), and the whole map that
 * replaces it. Pure, so the JVM test covers the parsing and the limits.
 *
 * [fields] is every stored field as it came, so that a rewrite keeps what it did not mean
 * to change (`migratedAt`, set by phase 4's migration, or a field a later version adds):
 * the rules take the `e2ee` map whole, and a write built from a fixed list would drop it.
 */
class StoredKeys(
    val fields: Map<String, Any?>,
    val keyVersion: Long,
    val wraps: Map<String, E2ee.Wrap>,
) {
    fun wrapsBy(by: String): Map<String, E2ee.Wrap> = wraps.filterValues { it.by == by }

    fun hasRecoveryWrap(): Boolean = wraps.values.any { it.by == E2ee.BY_RECOVERY }

    /** The whole `e2ee` map with these wraps (and version), every other stored field kept. */
    fun with(wraps: Map<String, E2ee.Wrap>, keyVersion: Long = this.keyVersion): Map<String, Any?> =
        build(fields, keyVersion, wraps)

    companion object {
        /** The rules' limit on `wraps`. */
        const val MAX_WRAPS = 4

        /**
         * The stored map, or null for none: absent, or not the shape the rules allow (then
         * it is as good as none, since nothing in it can be relied on to open).
         */
        fun parse(value: Any?): StoredKeys? {
            val map = value as? Map<*, *> ?: return null
            val keyVersion = (map["keyVersion"] as? Number)?.toLong()?.takeIf { it >= 1 } ?: return null
            val storedWraps = map["wraps"] as? Map<*, *> ?: return null
            val wraps = buildMap {
                for ((id, wrap) in storedWraps) {
                    if (id !is String || wrap !is Map<*, *>) continue
                    val by = wrap["by"] as? String ?: continue
                    val n = wrap["n"] as? String ?: continue
                    val ct = wrap["ct"] as? String ?: continue
                    put(id, E2ee.Wrap(by, n, ct))
                }
            }
            val fields = buildMap { for ((k, v) in map) if (k is String) put(k, v) }
            return StoredKeys(fields, keyVersion, wraps)
        }

        /** The `e2ee` map for an account that had none. */
        fun fresh(wraps: Map<String, E2ee.Wrap>, keyVersion: Long = 1): Map<String, Any?> =
            build(emptyMap(), keyVersion, wraps)

        private fun build(fields: Map<String, Any?>, keyVersion: Long, wraps: Map<String, E2ee.Wrap>): Map<String, Any?> {
            // A refused write fails the same way every time, so this says why first.
            require(wraps.size <= MAX_WRAPS) { "the rules take at most $MAX_WRAPS wraps, not ${wraps.size}" }
            return fields + mapOf(
                "v" to 1L,
                "kdf" to E2ee.KDF,
                "keyVersion" to keyVersion,
                "wraps" to wraps.mapValues { (_, w) -> mapOf("by" to w.by, "n" to w.n, "ct" to w.ct) },
            )
        }
    }
}
