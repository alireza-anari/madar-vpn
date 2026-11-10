package io.madar.v2

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** OS-keyed local secret storage. Android backups are disabled for this app. */
class SubscriptionTokenStore(context: Context) {
    private val prefs = context.applicationContext
        .getSharedPreferences("madar_v2_secure", Context.MODE_PRIVATE)
    private val alias = "madar-v2-subscription-token-key-v1"

    private fun key(): SecretKey {
        val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keystore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore"
        )
        generator.init(KeyGenParameterSpec.Builder(
            alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build())
        return generator.generateKey()
    }

    fun save(token: String): Boolean {
        if (!SubscriptionTokenFormat.isValid(token)) return false
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val encrypted = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
            prefs.edit()
                .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .putString("payload", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .commit()
        } catch (_: Exception) { false }
    }

    fun read(): String? {
        val iv = prefs.getString("iv", null) ?: return null
        val encoded = prefs.getString("payload", null) ?: return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(
                128, Base64.decode(iv, Base64.NO_WRAP)
            ))
            val token = String(cipher.doFinal(Base64.decode(encoded, Base64.NO_WRAP)), Charsets.UTF_8)
            if (SubscriptionTokenFormat.isValid(token)) token else null
        } catch (_: Exception) {
            clear()
            null
        }
    }

    fun clear() {
        prefs.edit().remove("iv").remove("payload").apply()
    }
}
