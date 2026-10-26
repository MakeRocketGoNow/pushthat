package com.makerocketgonow.pushthat

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.auth
import com.google.firebase.Firebase
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.firestore

class LoginActivity : AppCompatActivity() {
    private lateinit var auth: FirebaseAuth
    private val tag = "LoginActivity"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)
        applyWindowInsets()

        auth = Firebase.auth

        // Check if user is already signed in
        if (auth.currentUser != null) {
            startMainActivity()
            return
        }

        val emailInput = findViewById<EditText>(R.id.emailInput)
        val passwordInput = findViewById<EditText>(R.id.passwordInput)
        val loginButton = findViewById<Button>(R.id.loginButton)
        val registerButton = findViewById<Button>(R.id.registerButton)
        val forgotPasswordText = findViewById<TextView>(R.id.forgotPasswordText)

        loginButton.setOnClickListener {
            val email = emailInput.text.toString().trim()
            val password = passwordInput.text.toString().trim()

            if (email.isEmpty()) {
                emailInput.error = getString(R.string.email_required)
                return@setOnClickListener
            }

            if (password.isEmpty()) {
                passwordInput.error = getString(R.string.password_required)
                return@setOnClickListener
            }

            // Show loading feedback
            loginButton.isEnabled = false
            loginButton.text = getString(R.string.signing_in)

            auth.signInWithEmailAndPassword(email, password)
                .addOnCompleteListener(this) { task ->
                    // Re-enable button
                    loginButton.isEnabled = true
                    loginButton.text = getString(R.string.sign_in)

                    if (task.isSuccessful) {
                        startMainActivity()
                    } else {
                        Log.w(tag, "signInWithEmail:failure", task.exception)
                        Toast.makeText(
                            this,
                            task.exception?.message ?: getString(R.string.authentication_failed),
                            Toast.LENGTH_LONG
                        ).show()
                    }
                }
        }

        registerButton.setOnClickListener {
            val email = emailInput.text.toString().trim()
            val password = passwordInput.text.toString().trim()

            if (email.isEmpty()) {
                emailInput.error = getString(R.string.email_required)
                return@setOnClickListener
            }

            if (password.isEmpty()) {
                passwordInput.error = getString(R.string.password_required)
                return@setOnClickListener
            }

            // Show loading feedback
            registerButton.isEnabled = false
            registerButton.text = getString(R.string.creating_account)

            createAccount(email, password)
        }

        forgotPasswordText.setOnClickListener {
            // Implement forgot password functionality
            Toast.makeText(this, "Forgot password clicked", Toast.LENGTH_SHORT).show()
        }
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

    private fun createAccount(email: String, password: String) {
        auth.createUserWithEmailAndPassword(email, password)
            .addOnCompleteListener(this) { task ->
                // Re-enable button
                val registerButton = findViewById<Button>(R.id.registerButton)
                registerButton.isEnabled = true
                registerButton.text = getString(R.string.register)

                if (task.isSuccessful) {
                    Log.d(tag, "createUserWithEmail:success")
                    // Save user data to Firestore
                    val db = Firebase.firestore
                    val userData = hashMapOf(
                        "email" to email,
                        "createdAt" to FieldValue.serverTimestamp()
                    )

                    db.collection("users")
                        .document(auth.currentUser!!.uid)
                        .set(userData)
                        .addOnSuccessListener {
                            Log.d(tag, "User data saved to Firestore")
                            startMainActivity()
                        }
                        .addOnFailureListener { e ->
                            Log.w(tag, "Error saving user data", e)
                            startMainActivity()
                        }
                } else {
                    Log.w(tag, "createUserWithEmail:failure", task.exception)
                    Toast.makeText(
                        baseContext,
                        task.exception?.message ?: getString(R.string.authentication_failed),
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
    }

    private fun startMainActivity() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}