package com.makerocketgonow.pushthat.e2ee

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Log
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Where this install keeps the account key (docs/e2ee.md, "Where keys live on each
 * device"): `accountKey` encrypted under an AES-GCM key that lives in the AndroidKeyStore
 * and never leaves it, with the ciphertext, its IV and the install's `deviceId` in a
 * private SharedPreferences file. Any component with a Context reads it: `ShareActivity`,
 * `RetryPushWorker`, `TitleScrapingWorker` and `PushThatMessagingService` all do.
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
 * A recovery key that has been shown and not yet confirmed with "I saved it" is kept here
 * too, under the same Keystore key, from the moment the account key is stored. The screen
 * that shows it does not survive the process, and the account key does: without this, a
 * process that died before "I saved it" would come back to a stored key, go straight to the
 * list, and leave the account with a recovery wrap nobody ever saw. The app shows it again
 * on the next launch while it is here, and "I saved it" removes it.
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
    private const val KEY_RECOVERY = "unconfirmedRecoveryKey"
    private const val KEY_RECOVERY_IV = "unconfirmedRecoveryKeyIv"

    /** The account key this install holds, for the account it belongs to. */
    class Stored(val uid: String, val accountKey: ByteArray, val keyVersion: Long)

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Keeps [accountKey] for [uid], with [recoveryKey] (its display form) when one was just
     * made and is about to be shown, in one write: a key on disk whose recovery key is not
     * would be the case the class comment describes. A save without one drops any left from
     * before, since it belonged to the account key this replaces. `commit`, not `apply`: the
     * caller shows the recovery key or the push list next, and both assume the key is on disk.
     */
    @Synchronized
    fun save(context: Context, uid: String, accountKey: ByteArray, keyVersion: Long, recoveryKey: String? = null) {
        val (wrapped, iv) = seal(accountKey, aad(uid))
        val edit = prefs(context).edit()
            .putString(KEY_WRAPPED, wrapped)
            .putString(KEY_IV, iv)
            .putString(KEY_UID, uid)
            .putLong(KEY_VERSION, keyVersion)
        if (recoveryKey == null) {
            edit.remove(KEY_RECOVERY).remove(KEY_RECOVERY_IV)
        } else {
            val (sealedRecovery, recoveryIv) = seal(E2ee.utf8(recoveryKey), recoveryAad(uid))
            edit.putString(KEY_RECOVERY, sealedRecovery).putString(KEY_RECOVERY_IV, recoveryIv)
        }
        if (!edit.commit()) throw IllegalStateException("the account key could not be saved")
    }

    /**
     * Keeps a recovery key made for the account key already stored here (Settings, "Show a
     * new recovery key") until it is confirmed, as [save] does for one made with the key.
     */
    @Synchronized
    fun saveUnconfirmedRecoveryKey(context: Context, uid: String, recoveryKey: String) {
        val prefs = prefs(context)
        check(prefs.getString(KEY_UID, null) == uid) { "this install holds no key for the account" }
        val (sealedRecovery, recoveryIv) = seal(E2ee.utf8(recoveryKey), recoveryAad(uid))
        val saved = prefs.edit()
            .putString(KEY_RECOVERY, sealedRecovery)
            .putString(KEY_RECOVERY_IV, recoveryIv)
            .commit()
        if (!saved) throw IllegalStateException("the recovery key could not be saved")
    }

    /**
     * Whether a recovery key for [uid] is waiting for "I saved it". From the file alone, as
     * [hasKey], since the activities route on it in `onCreate`.
     */
    @Synchronized
    fun hasUnconfirmedRecoveryKey(context: Context, uid: String): Boolean {
        val prefs = prefs(context)
        return prefs.getString(KEY_UID, null) == uid &&
            prefs.contains(KEY_RECOVERY) &&
            prefs.contains(KEY_RECOVERY_IV)
    }

    /** The recovery key waiting for "I saved it", in its display form, or null. Off the main thread. */
    @Synchronized
    fun unconfirmedRecoveryKey(context: Context, uid: String): String? {
        val prefs = prefs(context)
        if (prefs.getString(KEY_UID, null) != uid) return null
        val sealedRecovery = prefs.getString(KEY_RECOVERY, null) ?: return null
        val recoveryIv = prefs.getString(KEY_RECOVERY_IV, null) ?: return null
        val bytes = open(sealedRecovery, recoveryIv, recoveryAad(uid)) { confirmRecoveryKey(context) } ?: return null
        return String(bytes, Charsets.UTF_8)
    }

    /** "I saved it": the recovery key is the user's to keep now, not this install's. */
    @Synchronized
    fun confirmRecoveryKey(context: Context) {
        prefs(context).edit().remove(KEY_RECOVERY).remove(KEY_RECOVERY_IV).commit()
    }

    /**
     * The account key for [uid], or null when this install has none for it: never set up,
     * signed out, another account's, or one that can no longer be opened (the Keystore entry
     * is gone, or the file is not what [save] wrote). The last is cleared, so the app asks
     * for the password again rather than failing the same way on every push.
     *
     * Null without clearing for any other failure: the Keystore runs in a system service,
     * which can be busy or restarting, and a key cleared for that would send the user back
     * to the password for nothing. The next call tries again.
     */
    @Synchronized
    fun load(context: Context, uid: String): Stored? {
        val prefs = prefs(context)
        if (prefs.getString(KEY_UID, null) != uid) return null
        val wrapped = prefs.getString(KEY_WRAPPED, null) ?: return null
        val iv = prefs.getString(KEY_IV, null) ?: return null
        val accountKey = open(wrapped, iv, aad(uid)) { clear(context) } ?: return null
        return Stored(uid, accountKey, prefs.getLong(KEY_VERSION, 1L))
    }

    /**
     * Whether this install holds a key for [uid], from the file alone: for the activities,
     * which decide on it in `onCreate` on the main thread, where a Keystore call (a binder
     * call to a system service) does not belong. It does not open the key; whoever uses it
     * calls [load], off the main thread, and a key that turns out not to open is cleared
     * there, so the next launch asks for the password.
     */
    @Synchronized
    fun hasKey(context: Context, uid: String): Boolean {
        val prefs = prefs(context)
        return prefs.getString(KEY_UID, null) == uid &&
            prefs.contains(KEY_WRAPPED) &&
            prefs.contains(KEY_IV)
    }

    /**
     * What pushes are encrypted with on this install for [uid], or null without a key: the
     * subkeys of the stored key, the version stored beside it, and this install's id. Opens
     * the key, so off the main thread, as [load].
     */
    fun pushKeys(context: Context, uid: String): PushKeys? {
        val stored = load(context, uid) ?: return null
        return PushKeys.of(uid, stored.accountKey, stored.keyVersion, deviceId(context))
    }

    /** On sign-out: the key (and any recovery key not yet confirmed) goes, the install's `deviceId` stays. */
    @Synchronized
    fun clear(context: Context) {
        prefs(context).edit()
            .remove(KEY_WRAPPED)
            .remove(KEY_IV)
            .remove(KEY_UID)
            .remove(KEY_VERSION)
            .remove(KEY_RECOVERY)
            .remove(KEY_RECOVERY_IV)
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

    /** [plain] encrypted under the Keystore key, and its IV, both base64. */
    private fun seal(plain: ByteArray, aad: ByteArray): Pair<String, String> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        // The Keystore picks the IV; it refuses one from the caller for an encrypting key.
        cipher.init(Cipher.ENCRYPT_MODE, keystoreKey())
        cipher.updateAAD(aad)
        val sealed = cipher.doFinal(plain)
        return E2ee.base64(sealed) to E2ee.base64(cipher.iv)
    }

    /**
     * Decrypts what [save] wrote, or null. [forget] runs only when it can never be opened:
     * no Keystore key (a restore, or the app's keys wiped), a tag that does not verify (the
     * key or the file changed), a key the system invalidated, or a stored value that is not
     * base64. Anything else is taken for a passing Keystore failure and only logged.
     */
    private fun open(wrapped: String, iv: String, aad: ByteArray, forget: () -> Unit): ByteArray? {
        fun permanent(e: Exception): ByteArray? {
            Log.w(TAG, "A stored value can no longer be opened; it is cleared", e)
            forget()
            return null
        }
        return try {
            val key = existingKeystoreKey() ?: return permanent(GeneralSecurityException("no Keystore key"))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, E2ee.fromBase64(iv)))
            cipher.updateAAD(aad)
            cipher.doFinal(E2ee.fromBase64(wrapped))
        } catch (e: AEADBadTagException) {
            permanent(e)
        } catch (e: KeyPermanentlyInvalidatedException) {
            permanent(e)
        } catch (e: IllegalArgumentException) {
            permanent(e)
        } catch (e: Exception) {
            Log.w(TAG, "The Keystore could not open a stored value this time; it is kept", e)
            null
        }
    }

    // Binds the ciphertext to the account, so a blob and a uid swapped in the file fail on
    // the tag instead of handing one account's key to another.
    private fun aad(uid: String) = E2ee.utf8("pushthat/device/v1:$uid")

    // Its own label, so the two blobs cannot be swapped in the file either.
    private fun recoveryAad(uid: String) = E2ee.utf8("pushthat/device/v1/unconfirmed-recovery-key:$uid")

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
