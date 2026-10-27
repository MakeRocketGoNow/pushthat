package com.makerocketgonow.pushthat

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import android.view.View
import android.widget.Button
import android.widget.TextView

/**
 * Fills in res/layout/view_recovery_key.xml, the one recovery key screen: on the sign-in
 * screen after registration or a migration, and in a dialog from the menu.
 */
object RecoveryKeyView {
    fun bind(root: View, recoveryKey: String, onSaved: () -> Unit) {
        // Four groups to a line, so the eight never break mid-group on a narrow screen.
        root.findViewById<TextView>(R.id.recoveryKeyText).text =
            recoveryKey.split("-").chunked(4).joinToString("\n") { it.joinToString("-") }
        val copy = root.findViewById<Button>(R.id.recoveryKeyCopy)
        copy.setText(R.string.copy)
        copy.setOnClickListener {
            copyToClipboard(root.context, recoveryKey)
            copy.setText(R.string.copied)
        }
        root.findViewById<Button>(R.id.recoveryKeySaved).setOnClickListener { onSaved() }
    }

    /**
     * Marked sensitive, so that Android 13's clipboard preview and keyboards that show the
     * clipboard do not put the key on screen. The extra's string is used below Android 13,
     * where the constant does not exist but some keyboards already honour it.
     */
    private fun copyToClipboard(context: Context, recoveryKey: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText(context.getString(R.string.recovery_key_clip_label), recoveryKey)
        val sensitive = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ClipDescription.EXTRA_IS_SENSITIVE
        } else {
            "android.content.extra.IS_SENSITIVE"
        }
        clip.description.extras = PersistableBundle().apply { putBoolean(sensitive, true) }
        clipboard.setPrimaryClip(clip)
    }
}
