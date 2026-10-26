package com.makerocketgonow.pushthat

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.view.updatePadding
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.firebase.Firebase
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.auth
import com.makerocketgonow.pushthat.LoginViewModel.Screen
import kotlinx.coroutines.launch

/**
 * Everything before the push list: signing in or registering, the recovery key prompt for
 * an account whose password could not rewrap its keys, and the recovery key itself, shown
 * once. The steps run in [LoginViewModel]; this shows the views the current one needs.
 */
class LoginActivity : AppCompatActivity() {
    private lateinit var auth: FirebaseAuth
    private lateinit var viewModel: LoginViewModel

    private lateinit var titleText: TextView
    private lateinit var bodyText: TextView
    private lateinit var emailInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var forgotPasswordText: TextView
    private lateinit var recoveryInput: EditText
    private lateinit var recoveryKeyView: View
    private lateinit var errorText: TextView
    private lateinit var progress: View
    private lateinit var primaryButton: Button
    private lateinit var secondaryButton: Button

    /** The recovery key the view was last bound to, so a re-render keeps "Copied" as it was. */
    private var boundRecoveryKey: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        applyWindowInsets()

        auth = Firebase.auth
        viewModel = ViewModelProvider(this)[LoginViewModel::class.java]

        if (auth.currentUser != null && viewModel.state.value.screen == Screen.Form) {
            startMainActivity()
            return
        }

        titleText = findViewById(R.id.titleText)
        bodyText = findViewById(R.id.bodyText)
        emailInput = findViewById(R.id.emailInput)
        passwordInput = findViewById(R.id.passwordInput)
        forgotPasswordText = findViewById(R.id.forgotPasswordText)
        recoveryInput = findViewById(R.id.recoveryInput)
        recoveryKeyView = findViewById(R.id.recoveryKeyView)
        errorText = findViewById(R.id.errorText)
        progress = findViewById(R.id.progress)
        primaryButton = findViewById(R.id.loginButton)
        secondaryButton = findViewById(R.id.registerButton)

        primaryButton.setOnClickListener { onPrimary() }
        secondaryButton.setOnClickListener { onSecondary() }
        forgotPasswordText.setOnClickListener {
            // Implement forgot password functionality
            Toast.makeText(this, "Forgot password clicked", Toast.LENGTH_SHORT).show()
        }

        // The recovery prompt goes back to the form; the recovery key screen goes nowhere
        // until "I saved it", which is the point of it; a running step is left to finish.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val state = viewModel.state.value
                when {
                    state.working != null || state.screen is Screen.RecoveryKey -> Unit
                    state.screen is Screen.Recovery -> viewModel.backToForm()
                    else -> {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.state.collect { render(it) }
            }
        }
    }

    private fun render(state: LoginViewModel.State) {
        val screen = state.screen
        if (screen == Screen.Done) {
            startMainActivity()
            return
        }
        val form = screen == Screen.Form
        val recovery = screen is Screen.Recovery
        val showingKey = screen is Screen.RecoveryKey

        findViewById<View>(R.id.logoImage).isVisible = !showingKey
        titleText.isVisible = !showingKey
        titleText.setText(if (recovery) R.string.recovery_prompt_title else R.string.sign_in_to_pushthat)
        bodyText.isVisible = recovery
        if (recovery) bodyText.setText(R.string.recovery_prompt_body)

        emailInput.isVisible = form
        passwordInput.isVisible = form
        forgotPasswordText.isVisible = form
        recoveryInput.isVisible = recovery

        recoveryKeyView.isVisible = showingKey
        if (screen is Screen.RecoveryKey && boundRecoveryKey != screen.recoveryKey) {
            boundRecoveryKey = screen.recoveryKey
            RecoveryKeyView.bind(recoveryKeyView, screen.recoveryKey) { viewModel.recoveryKeySaved() }
        }

        primaryButton.isVisible = !showingKey
        secondaryButton.isVisible = !showingKey
        primaryButton.text = getString(
            when {
                state.working != null -> state.working
                recovery -> R.string.continue_
                else -> R.string.sign_in
            }
        )
        secondaryButton.setText(if (recovery) R.string.no_recovery_key else R.string.register)

        val working = state.working != null
        progress.isVisible = working
        for (view in listOf(emailInput, passwordInput, recoveryInput, primaryButton, secondaryButton)) {
            view.isEnabled = !working
        }

        errorText.isVisible = state.error != null
        errorText.text = state.error
    }

    private fun onPrimary() {
        when (viewModel.state.value.screen) {
            Screen.Form -> {
                val credentials = credentials(registering = false) ?: return
                viewModel.signIn(credentials.first, credentials.second)
            }
            is Screen.Recovery -> {
                val text = recoveryInput.text.toString()
                if (text.isBlank()) {
                    recoveryInput.error = getString(R.string.wrong_recovery_key)
                    return
                }
                viewModel.recover(text)
            }
            else -> Unit
        }
    }

    private fun onSecondary() {
        when (viewModel.state.value.screen) {
            Screen.Form -> {
                val credentials = credentials(registering = true) ?: return
                viewModel.register(credentials.first, credentials.second)
            }
            // Said before anything is replaced, since it cannot be undone.
            is Screen.Recovery -> AlertDialog.Builder(this, R.style.DeleteDialogStyle)
                .setMessage(R.string.start_over_warning)
                .setPositiveButton(R.string.continue_) { _, _ -> viewModel.startOver() }
                .setNegativeButton(R.string.cancel, null)
                .show()
            else -> Unit
        }
    }

    /**
     * The email (trimmed: Firebase refuses the spaces a keyboard leaves) and the password
     * as typed. Not trimmed: a space at either end is part of the password, and the keys are
     * derived from it as typed on every app. Registration asks for 10 characters; sign-in
     * takes what it is given, since accounts from before the rule have shorter passwords.
     */
    private fun credentials(registering: Boolean): Pair<String, String>? {
        val email = emailInput.text.toString().trim()
        val password = passwordInput.text.toString()
        if (email.isEmpty()) {
            emailInput.error = getString(R.string.email_required)
            return null
        }
        if (password.isEmpty()) {
            passwordInput.error = getString(R.string.password_required)
            return null
        }
        if (registering && password.length < MIN_NEW_PASSWORD_LENGTH) {
            passwordInput.error = getString(R.string.password_rule)
            return null
        }
        return email to password
    }

    /**
     * Apps targeting Android 16 (API 36) are always laid out edge to edge, so the
     * screen's own padding has to be combined with the system bar insets to keep
     * the form clear of the status and navigation bars.
     */
    private fun applyWindowInsets() {
        val root = findViewById<View>(R.id.loginRoot)
        val basePadding = root.paddingTop
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            view.updatePadding(
                left = basePadding + insets.left,
                top = basePadding + insets.top,
                right = basePadding + insets.right,
                bottom = basePadding + insets.bottom
            )
            windowInsets
        }
    }

    private fun startMainActivity() {
        if (isFinishing) return
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    companion object {
        /** docs/e2ee.md: the sign-up screen asks for at least 10 characters and says why. */
        const val MIN_NEW_PASSWORD_LENGTH = 10
    }
}
