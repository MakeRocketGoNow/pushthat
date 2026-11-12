package com.makerocketgonow.pushthat.e2ee

import android.content.Context
import com.google.firebase.Firebase
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.auth
import com.makerocketgonow.pushthat.PushFiles

/**
 * Signs out, dropping this install's account key. Every sign-out goes through here, so the
 * order below is kept in one place rather than repeated (and half-explained) at each button.
 *
 * The key first, so a sign-out that stops between the two leaves a session with no key
 * (which asks for the password) and never a key on a phone that is signed out. `deviceId`
 * stays: it belongs to the install, not the account.
 */
fun signOut(context: Context, auth: FirebaseAuth = Firebase.auth) {
    forgetSession(context)
    auth.signOut()
}

/**
 * What a session leaves on this install, dropped when it ends however it ends (Logout, or
 * Firebase ending it on its own): the account key, and the last file decrypted with it,
 * which sits in plaintext in the cache until the next file is opened.
 */
fun forgetSession(context: Context) {
    AccountKeyStore.clear(context)
    PushFiles.clear(context)
}
