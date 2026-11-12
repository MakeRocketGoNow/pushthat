package com.makerocketgonow.pushthat

import android.app.Application
import android.util.Log
import androidx.annotation.StringRes
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.FirebaseException
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.makerocketgonow.pushthat.e2ee.AccountKeyStore
import com.makerocketgonow.pushthat.e2ee.AccountKeys
import com.makerocketgonow.pushthat.e2ee.KeysChangedException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.IOException

/**
 * "Change password", "Show a new recovery key" and "Delete account" from the list's menu.
 * Outside the activity for the same reason as `LoginViewModel`: a new recovery key replaces
 * the old one's wrap before it is shown, so a rotation that cancelled the step in between
 * would leave a key that works and that nobody saw. A deletion cancelled between the
 * server's answer and the sign-out would leave an install signed in to no account.
 */
class KeySettingsViewModel(application: Application) : AndroidViewModel(application) {
    private val keys = AccountKeys(application)

    sealed interface State {
        data object Idle : State
        class Working(@param:StringRes val message: Int) : State
        class RecoveryKey(val recoveryKey: String) : State
        class Done(@param:StringRes val message: Int) : State
        /** The account is gone and this install is signed out: only the sign-in screen is left. */
        data object AccountDeleted : State
        class Failed(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    fun changePassword(currentPassword: String, newPassword: String) = run(R.string.changing_password) {
        keys.changePassword(currentPassword, newPassword)
        State.Done(R.string.password_changed)
    }

    fun newRecoveryKey() = run(R.string.making_recovery_key) {
        State.RecoveryKey(keys.replaceRecoveryKey())
    }

    fun deleteAccount(password: String) = run(R.string.deleting_account) {
        AccountDeletion.delete(getApplication(), password)
        State.AccountDeleted
    }

    /** The result has been seen. */
    fun acknowledge() {
        if (_state.value !is State.Working) _state.value = State.Idle
    }

    /** "I saved it": the copy kept in case the process went (AccountKeyStore) goes too. */
    fun recoveryKeySaved() {
        if (_state.value !is State.RecoveryKey) return
        AccountKeyStore.confirmRecoveryKey(getApplication())
        _state.value = State.Idle
    }

    private fun run(@StringRes working: Int, step: suspend () -> State) {
        if (_state.value != State.Idle) return
        _state.value = State.Working(working)
        viewModelScope.launch {
            _state.value = try {
                step()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "A key setting failed", e)
                State.Failed(messageFor(e))
            }
        }
    }

    private fun messageFor(e: Exception): String {
        val app = getApplication<Application>()
        return when (e) {
            // Before FirebaseException, whose own message for this is about a "credential".
            is FirebaseAuthInvalidCredentialsException -> app.getString(R.string.wrong_password)
            // The function's own sentence, written for the person, when it gave one.
            is AccountDeletion.RefusedException -> e.message ?: app.getString(R.string.delete_account_failed)
            is IOException -> app.getString(R.string.delete_account_failed)
            // Retrying cannot help: the key this install holds is not the account's.
            is KeysChangedException, is AccountKeys.NoAccountKeyException -> app.getString(R.string.keys_changed_here)
            // Firebase's own message for its errors: a wrong current password, no network.
            is FirebaseException -> e.message ?: app.getString(R.string.key_settings_failed)
            // Ours are written for the log ("not signed in", a `require`), not for the user.
            else -> app.getString(R.string.key_settings_failed)
        }
    }

    private companion object {
        const val TAG = "KeySettingsViewModel"
    }
}
