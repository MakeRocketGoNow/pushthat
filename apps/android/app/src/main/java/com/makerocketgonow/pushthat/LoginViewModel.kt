package com.makerocketgonow.pushthat

import android.app.Application
import android.util.Log
import androidx.annotation.StringRes
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.Firebase
import com.google.firebase.FirebaseException
import com.google.firebase.auth.FirebaseAuthRecentLoginRequiredException
import com.google.firebase.auth.auth
import com.makerocketgonow.pushthat.e2ee.AccountKeyStore
import com.makerocketgonow.pushthat.e2ee.AccountKeys
import com.makerocketgonow.pushthat.e2ee.KeysChangedException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The steps before the push list, kept outside `LoginActivity` so that turning the phone
 * mid-step neither cancels it nor loses where it got to. That matters more than it looks:
 * a registration cancelled after its keys are written and before the recovery key is on
 * screen leaves an account whose recovery key nobody ever saw. A process that dies is the
 * same case, which this cannot survive: AccountKeyStore keeps the recovery key until "I
 * saved it" for that, and [showUnconfirmedRecoveryKey] puts it back on screen.
 */
class LoginViewModel(application: Application) : AndroidViewModel(application) {
    private val keys = AccountKeys(application)

    sealed interface Screen {
        /** Email and password, to sign in or register. */
        data object Form : Screen

        /** The password opened nothing; the recovery key can. */
        class Recovery(val pending: AccountKeys.Pending) : Screen

        /** A recovery key was made; the user goes in once they say they saved it. */
        class RecoveryKey(val recoveryKey: String) : Screen

        /** Into the app. */
        data object Done : Screen
    }

    data class State(
        val screen: Screen = Screen.Form,
        /** While a step runs, what the screen says it is doing. */
        @param:StringRes val working: Int? = null,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun signIn(email: String, password: String) = run(R.string.signing_in) { keys.signIn(email, password) }

    fun register(email: String, password: String) = run(R.string.creating_account) { keys.register(email, password) }

    fun recover(recoveryText: String) {
        val pending = (_state.value.screen as? Screen.Recovery)?.pending ?: return
        run(R.string.signing_in) { keys.recover(pending, recoveryText) }
    }

    fun startOver() {
        val pending = (_state.value.screen as? Screen.Recovery)?.pending ?: return
        run(R.string.signing_in) { keys.startOver(pending) }
    }

    /** Back from the recovery prompt. The session stays; without a key it asks for the password again. */
    fun backToForm() {
        if (_state.value.working == null) _state.value = State(Screen.Form)
    }

    /**
     * The recovery key kept from before the process went (AccountKeyStore), on screen again.
     * Read off the main thread, as every Keystore call; meanwhile the form is busy, so it
     * cannot start a sign-in on top. Without one that opens, on as if there were none.
     */
    fun showUnconfirmedRecoveryKey(uid: String) {
        if (_state.value.working != null || _state.value.screen != Screen.Form) return
        _state.value = State(working = R.string.signing_in)
        viewModelScope.launch {
            val app = getApplication<Application>()
            val recoveryKey = withContext(Dispatchers.IO) { AccountKeyStore.unconfirmedRecoveryKey(app, uid) }
            _state.value = State(
                when {
                    recoveryKey != null -> Screen.RecoveryKey(recoveryKey).also { recoveryKeyUnavailable = false }
                    AccountKeyStore.hasKey(app, uid) -> Screen.Done.also {
                        recoveryKeyUnavailable = AccountKeyStore.hasUnconfirmedRecoveryKey(app, uid)
                    }
                    else -> Screen.Form
                }
            )
        }
    }

    /**
     * "I saved it": the kept copy goes, and the list opens if the key is stored. It may not
     * be: a recovery key is shown even when storing the account key failed (AccountKeys.keep),
     * and then the form asks for the password, as for any session without a key.
     */
    fun recoveryKeySaved() {
        if (_state.value.screen !is Screen.RecoveryKey) return
        val app = getApplication<Application>()
        AccountKeyStore.confirmRecoveryKey(app)
        val uid = Firebase.auth.currentUser?.uid
        _state.value = State(if (uid != null && AccountKeyStore.hasKey(app, uid)) Screen.Done else Screen.Form)
    }

    private fun run(@StringRes working: Int, step: suspend () -> AccountKeys.Outcome) {
        if (_state.value.working != null) return
        val app = getApplication<Application>()
        _state.value = _state.value.copy(working = working, error = null)
        viewModelScope.launch {
            _state.value = try {
                val outcome = step()
                val keysChanged = outcome is AccountKeys.Outcome.NeedsRecovery && outcome.keysChanged
                State(screenFor(outcome), error = if (keysChanged) app.getString(R.string.keys_changed) else null)
            } catch (e: CancellationException) {
                throw e
            } catch (e: FirebaseAuthRecentLoginRequiredException) {
                // An account from before the encryption finishes by changing its Firebase
                // password, which Firebase allows only for a few minutes after a sign-in. A
                // recovery or start-over that took longer fails there, and would fail the
                // same way on every retry from the recovery prompt. So the pending state
                // goes and the unlock prompt asks for the password, which signs in afresh;
                // the keys written before the failure open with it, so it finishes from there.
                Log.w(TAG, "A sign-in step needs a fresh sign-in", e)
                State(Screen.Form, error = app.getString(R.string.password_again_to_finish))
            } catch (e: KeysChangedException) {
                // Even after reading them again: back to the password prompt, which starts
                // from the keys as they are now. From the recovery prompt this drops the
                // pending state, which was read from the keys that changed.
                Log.w(TAG, "The keys changed during a sign-in step", e)
                State(Screen.Form, error = app.getString(R.string.keys_changed))
            } catch (e: Exception) {
                Log.w(TAG, "A sign-in step failed", e)
                _state.value.copy(working = null, error = messageFor(e))
            }
        }
    }

    private fun screenFor(outcome: AccountKeys.Outcome): Screen = when (outcome) {
        is AccountKeys.Outcome.Ready -> outcome.recoveryKey?.let { Screen.RecoveryKey(it) } ?: Screen.Done
        is AccountKeys.Outcome.NeedsRecovery -> Screen.Recovery(outcome.pending)
    }

    // Firebase's own message for its errors (a wrong password, no network, too many tries),
    // as the screen showed before; ours for a wrong recovery key. Anything else is a
    // generic failure: its message is written for the log ("not signed in", a `require`),
    // not for the person holding the phone.
    private fun messageFor(e: Exception): String {
        val app = getApplication<Application>()
        return when (e) {
            is AccountKeys.WrongRecoveryKeyException -> app.getString(R.string.wrong_recovery_key)
            is FirebaseException -> e.message ?: app.getString(R.string.authentication_failed)
            else -> app.getString(R.string.authentication_failed)
        }
    }

    companion object {
        private const val TAG = "LoginViewModel"

        /**
         * Set when a recovery key is waiting but the Keystore could not open it this time (the
         * key store keeps it for a passing failure). The list opens anyway and does not send
         * the user straight back here: that check finds the key still waiting, and the two
         * activities would hand the user back and forth for as long as the Keystore kept
         * failing, with neither on screen long enough to sign out.
         *
         * In memory for the process, not on the intent: Android restores an activity with its
         * original intent after the process is killed, and a flag carried there would hide
         * the waiting key (the user's only copy) for as long as the task lived. A new process
         * tries the Keystore again, and a key that opens clears it.
         */
        @Volatile
        var recoveryKeyUnavailable = false
            private set
    }
}
