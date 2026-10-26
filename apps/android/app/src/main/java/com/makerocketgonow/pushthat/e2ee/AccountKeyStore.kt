package com.makerocketgonow.pushthat.e2ee

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Where this install keeps the account key (docs/e2ee.md, "Where keys live on each
 * device"): `accountKey` encrypted under an AES-GCM key that lives in the AndroidKeyStore
 * and never leaves it, with the ciphertext, its IV and the install's `deviceId` in a
 * private SharedPreferences file. Any component with a Context reads it, which is what
 * `ShareActivity`, `RetryPushWorker` and `PushThatMessagingService` will do in phase 4.
 *
 * The Keystore key asks for no user authentication: the worker and the messaging service
 * have to decrypt with the screen locked, and a key bound to the lock screen would make
 * every background push fail. The protection is that the key cannot be exported, so a
 * copy of the app's files (a backup, a rooted read of the data directory) holds a blob
 * nothing else can open. For the same reason the file is left out of backups
 * (res/xml/backup_rules.xml, data_extraction_rules.xml): restored onto a new phone it
 * could not be decrypted anyway, and the `deviceId` beside it is one per install.
 *
 * The uid and the account's `keyVersion` are kept beside the key. The uid so that a key
 * left behind by an account that did not sign out cleanly is never used for another, and
 * the version because a push records the version it was encrypted under and the settings
 * check it before rewrapping.
 *
 * Plain SharedPreferences over Jetpack's EncryptedSharedPreferences, which is deprecated
 * and would add a Keystore-backed layer around a value that is already Keystore-encrypted.
 */
object AccountKeyStore {
    private const val TAG = "AccountKeyStore"
    private const val PREFS = "e2ee_keys"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "pushthat_account_key"
    private const val GCM_TAG_BITS = 128

    private const val KEY_WRAPPED = "accountKey"
    private const val KEY_IV = "accountKeyIv"
    private const val KEY_UID = "uid"
    private const val KEY_VERSION = "keyVersion"
    private const val KEY_DEVICE_ID = "deviceId"

    /** The account key this install holds, for the account it belongs to. */
    class Stored(val uid: String, val accountKey: ByteArray, val keyVersion: Long)

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Keeps [accountKey] for [uid]. `commit`, not `apply`: the caller shows the recovery key
     * or the push list next, and both assume the key is on disk.
     */
    @Synchronized
    fun save(context: Context, uid: String, accountKey: ByteArray, keyVersion: Long) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        // The Keystore picks the IV; it refuses one from the caller for an encrypting key.
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
        cipher.updateAAD(aad(uid))
        val wrapped = cipher.doFinal(accountKey)
        val saved = prefs(context).edit()
            .putString(KEY_WRAPPED, E2ee.base64(wrapped))
            .putString(KEY_IV, E2ee.base64(cipher.iv))
            .putString(KEY_UID, uid)
            .putLong(KEY_VERSION, keyVersion)
            .commit()
        if (!saved) throw IllegalStateException("the account key could not be saved")
    }

    /**
     * The account key for [uid], or null when this install has none for it: never set up,
     * signed out, another account's, or one that can no longer be opened (the Keystore entry
     * is gone, or the file is not what [save] wrote). The last is cleared, so the app asks
     * for the password again rather than failing the same way on every push.
     */
    @Synchronized
    fun load(context: Context, uid: String): Stored? {
        val prefs = prefs(context)
        if (prefs.getString(KEY_UID, null) != uid) return null
        val wrapped = prefs.getString(KEY_WRAPPED, null) ?: return null
        val iv = prefs.getString(KEY_IV, null) ?: return null
        return try {
            val key = existingKeystoreKey() ?: throw GeneralSecurityException("no Keystore key")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, E2ee.fromBase64(iv)))
            cipher.updateAAD(aad(uid))
            val accountKey = cipher.doFinal(E2ee.fromBase64(wrapped))
            Stored(uid, accountKey, prefs.getLong(KEY_VERSION, 1L))
        } catch (e: Exception) {
            // GeneralSecurityException for a Keystore that cannot open it, and
            // IllegalArgumentException for a stored value that is not base64.
            Log.w(TAG, "The stored account key could not be opened; it is cleared", e)
            clear(context)
            null
        }
    }

    fun hasKey(context: Context, uid: String): Boolean = load(context, uid) != null

    /** On sign-out: the key goes, the install's `deviceId` stays. */
    @Synchronized
    fun clear(context: Context) {
        prefs(context).edit()
            .remove(KEY_WRAPPED)
            .remove(KEY_IV)
            .remove(KEY_UID)
            .remove(KEY_VERSION)
            .commit()
    }

    /** This install's id, made on first use and kept across sign-outs. */
    @Synchronized
    fun deviceId(context: Context): String {
        val prefs = prefs(context)
        prefs.getString(KEY_DEVICE_ID, null)?.let { return it }
        val id = E2ee.newDeviceId()
        prefs.edit().putString(KEY_DEVICE_ID, id).commit()
        return id
    }

    // Binds the ciphertext to the account, so a blob and a uid swapped in the file fail on
    // the tag instead of handing one account's key to another.
    private fun aad(uid: String) = E2ee.utf8("pushthat/device/v1:$uid")

    private fun existingKeystoreKey(): SecretKey? {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        return keyStore.getKey(ALIAS, null) as? SecretKey
    }

    private fun keystoreKey(): SecretKey = existingKeystoreKey() ?: KeyGenerator
        .getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        .apply {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
        }
        .generateKey()
}
