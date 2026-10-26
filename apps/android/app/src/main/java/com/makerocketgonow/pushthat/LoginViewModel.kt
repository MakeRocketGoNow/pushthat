package com.makerocketgonow.pushthat

import android.app.Application
import android.util.Log
import androidx.annotation.StringRes
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.makerocketgonow.pushthat.e2ee.AccountKeys
import com.makerocketgonow.pushthat.e2ee.KeysChangedException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The steps before the push list, kept outside `LoginActivity` so that turning the phone
 * mid-step neither cancels it nor loses where it got to. That matters more than it looks:
 * a registration cancelled after its keys are written and before the recovery key is on
 * screen leaves an account whose recovery key nobody ever saw.
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

    fun recoveryKeySaved() {
        if (_state.value.screen is Screen.RecoveryKey) _state.value = State(Screen.Done)
    }

    private fun run(@StringRes working: Int, step: suspend () -> AccountKeys.Outcome) {
        if (_state.value.working != null) return
        _state.value = _state.value.copy(working = working, error = null)
        viewModelScope.launch {
            _state.value = try {
                State(screenFor(step()))
            } catch (e: CancellationException) {
                throw e
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
    // as the screen showed before; ours for the two this flow adds.
    private fun messageFor(e: Exception): String {
        val app = getApplication<Application>()
        return when (e) {
            is AccountKeys.WrongRecoveryKeyException -> app.getString(R.string.wrong_recovery_key)
            is KeysChangedException -> app.getString(R.string.keys_changed)
            else -> e.message ?: app.getString(R.string.authentication_failed)
        }
    }

    private companion object {
        const val TAG = "LoginViewModel"
    }
}
