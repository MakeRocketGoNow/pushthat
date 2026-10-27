package com.makerocketgonow.pushthat.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * A push that could not be written when it was made, kept for `RetryPushWorker`.
 *
 * [prepared] is the push as it will be written (`PreparedPush.toJson`: its id and every
 * encrypted field), so each attempt writes the same id and the same ciphertext and one that
 * landed is recognised rather than made twice. Such a row leaves [url] and [title] empty:
 * the plaintext has no reason to sit on disk beside its ciphertext. A row queued by a
 * version from before encryption has no [prepared]; the worker encrypts it with a new id
 * when this install holds the key, and stores the result here before it writes.
 */
@Entity(tableName = "pending_pushes")
data class PendingPush(
    @PrimaryKey(autoGenerate = true)
    @ColumnInfo(name = "id")
    val id: Long = 0,

    @ColumnInfo(name = "url")
    val url: String,

    @ColumnInfo(name = "user_id", defaultValue = "NULL")
    val userId: String? = null,

    @ColumnInfo(name = "created_at")
    val createdAt: Long,

    @ColumnInfo(name = "title", defaultValue = "")
    val title: String = "",

    @ColumnInfo(name = "type", defaultValue = "url")
    val type: String = "url",

    @ColumnInfo(name = "device_name", defaultValue = "")
    val deviceName: String = "",

    // Added in database version 2 (AppDatabase.MIGRATION_1_2).
    @ColumnInfo(name = "prepared", defaultValue = "NULL")
    val prepared: String? = null
)