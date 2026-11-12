package com.makerocketgonow.pushthat.data

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
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

    @Update
    fun update(pendingPush: PendingPush): Int

    @Delete
    fun delete(pendingPush: PendingPush): Int

    // For an account that has been deleted (AccountDeletion): its queued pushes have no
    // account left to be written to. A row from before rows named their account has no
    // user_id, and stays for whoever signs in next, as it always has.
    @Query("DELETE FROM pending_pushes WHERE user_id = :userId")
    fun deleteAllFor(userId: String): Int
}