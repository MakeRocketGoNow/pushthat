package com.makerocketgonow.pushthat.e2ee

/**
 * `users/{uid}.e2ee` as read (docs/e2ee.md, "The user document"), and the whole map that
 * replaces it, with the decisions `AccountKeys` makes from it: what a sign-in does, and
 * which wraps each rewrite keeps within the rules' four. Pure, so the JVM test covers the
 * parsing, the decisions and the limits; `AccountKeys` adds the crypto and the network.
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

    /**
     * The recovery wraps a recovery keeps beside the new password wrap: the one that opened
     * first, then the others, at most three. The password wraps go: none of them opened.
     */
    fun keptForRecovery(openedId: String): Map<String, E2ee.Wrap> =
        preferring(wrapsBy(E2ee.BY_RECOVERY), openedId, MAX_WRAPS - 1)

    /**
     * The password wraps kept beside a new recovery wrap, which replaces every recovery
     * wrap: [preferredId] (the one that opened, when there is one) first, at most three.
     */
    fun keptForNewRecoveryKey(preferredId: String?): Map<String, E2ee.Wrap> =
        preferring(wrapsBy(E2ee.BY_PASSWORD), preferredId, MAX_WRAPS - 1)

    /**
     * The wraps kept beside the new password's wrap while the Firebase password changes:
     * one password wrap the current password opens ([openedPasswordIds], in stored order),
     * kept until the change is done so the account opens with either password meanwhile,
     * and the recovery wraps, as many as fit beside the two (two). Password wraps nothing
     * opens go: their password is gone.
     */
    fun keptForPasswordChange(openedPasswordIds: Collection<String>): Map<String, E2ee.Wrap> {
        val keep = openedPasswordIds.first()
        val recovery = wrapsBy(E2ee.BY_RECOVERY).entries.take(MAX_WRAPS - 2).associate { it.toPair() }
        return mapOf(keep to wraps.getValue(keep)) + recovery
    }

    /** The whole `e2ee` map with these wraps (and version), every other stored field kept. */
    fun with(wraps: Map<String, E2ee.Wrap>, keyVersion: Long = this.keyVersion): Map<String, Any?> =
        build(fields, keyVersion, wraps)

    /** What a sign-in does with the stored keys and the password it was given. */
    enum class Decision {
        /** The password opens the account key. */
        OPEN,

        /**
         * The password opens it, and the sign-in used the password from before the
         * encryption: a migration that stopped after writing the keys and before changing the
         * Firebase password, so the recovery key may never have been seen. A new one replaces
         * it, then the change finishes.
         */
        OPEN_AND_REPLACE_RECOVERY,

        /** The password opens nothing, and a recovery key could. */
        ASK_FOR_RECOVERY,

        /** Nothing to open: no keys, or none a recovery key could open either. */
        START_NEW_KEYS,
    }

    companion object {
        /** The rules' limit on `wraps`. */
        const val MAX_WRAPS = 4

        /** See [Decision]. [opened] is whether the password opened one of [stored]'s wraps. */
        fun decide(stored: StoredKeys?, opened: Boolean, legacy: Boolean): Decision = when {
            stored != null && opened -> if (legacy) Decision.OPEN_AND_REPLACE_RECOVERY else Decision.OPEN
            stored != null && stored.hasRecoveryWrap() -> Decision.ASK_FOR_RECOVERY
            else -> Decision.START_NEW_KEYS
        }

        /**
         * Whether [stored] are still the keys [decidedFrom] read: the same version and the
         * same wraps. Comparing the wraps too catches a rewrap on another device, which
         * leaves the version as it was. Two absent maps are the same.
         */
        fun same(stored: StoredKeys?, decidedFrom: StoredKeys?): Boolean =
            stored?.keyVersion == decidedFrom?.keyVersion && stored?.wraps == decidedFrom?.wraps

        // [wraps] with [preferredId] first when it is one of them, then the rest in stored
        // order, cut to [limit].
        private fun preferring(wraps: Map<String, E2ee.Wrap>, preferredId: String?, limit: Int): Map<String, E2ee.Wrap> =
            (wraps.filterKeys { it == preferredId } + wraps).entries.take(limit).associate { it.toPair() }

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
