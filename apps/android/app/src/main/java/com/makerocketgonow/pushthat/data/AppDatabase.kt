package com.makerocketgonow.pushthat.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [PendingPush::class],
    version = 2,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun pendingPushDao(): PendingPushDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        /**
         * Version 2 keeps the encrypted push a row will write (`PendingPush.prepared`). A
         * column added, not a table rebuilt: rows already queued are plaintext pushes that
         * did not make it, and they must survive the update to be sent (encrypted) later.
         */
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE pending_pushes ADD COLUMN prepared TEXT DEFAULT NULL")
            }
        }

        fun getDatabase(context: Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "app_database"
                ).addMigrations(MIGRATION_1_2).build()
                INSTANCE = instance
                instance
            }
        }
    }
}