package com.makerocketgonow.pushthat.data

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.lifecycle.LiveData

@Dao
interface PendingPushDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insert(pendingPush: PendingPush): Long

    @Query("SELECT * FROM pending_pushes ORDER BY created_at DESC")
    fun getAllPendingPushes(): LiveData<List<PendingPush>>

    // A one-shot read for the retry worker, which runs off the main thread, where LiveData
    // cannot be observed.
    @Query("SELECT * FROM pending_pushes ORDER BY created_at DESC")
    suspend fun loadAllPendingPushes(): List<PendingPush>

    @Delete
    fun delete(pendingPush: PendingPush): Int
}