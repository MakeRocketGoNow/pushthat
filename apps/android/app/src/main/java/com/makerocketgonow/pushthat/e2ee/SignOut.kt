package com.makerocketgonow.pushthat.e2ee

import android.content.Context
import com.google.firebase.Firebase
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.auth

/**
 * Signs out, dropping this install's account key. Every sign-out goes through here, so the
 * order below is kept in one place rather than repeated (and half-explained) at each button.
 *
 * The key first, so a sign-out that stops between the two leaves a session with no key
 * (which asks for the password) and never a key on a phone that is signed out. `deviceId`
 * stays: it belongs to the install, not the account.
 */
fun signOut(context: Context, auth: FirebaseAuth = Firebase.auth) {
    AccountKeyStore.clear(context)
    auth.signOut()
}
