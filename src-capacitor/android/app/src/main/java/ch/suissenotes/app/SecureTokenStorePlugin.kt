package ch.suissenotes.app

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * SecureTokenStore: small key/value store for the session token and other
 * secrets, backed by the Android Keystore.
 *
 * Values are encrypted with a non-exportable AES-256-GCM key that lives in
 * the AndroidKeyStore; only ciphertext + IV (base64) is written to a private
 * SharedPreferences file. The app has android:allowBackup="false", so the
 * file is not part of any backup, and the key never leaves the device.
 *
 * JS: get({ key }) -> { value: string | null }, set({ key, value }), remove({ key }).
 * Every failure rejects: the JS layer then refuses to store (no plaintext fallback).
 */
@CapacitorPlugin(name = "SecureTokenStore")
class SecureTokenStorePlugin : Plugin() {

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "ch.suissenotes.app.secure.v1"
        private const val PREFS = "ch.suissenotes.app.secure"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        private const val MAX_KEY_LENGTH = 128
    }

    private fun prefs(): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun validKey(call: PluginCall): String? {
        val key = call.getString("key")
        if (key.isNullOrEmpty() || key.length > MAX_KEY_LENGTH || !key.matches(Regex("^[A-Za-z0-9_.-]+$"))) {
            call.reject("INVALID_KEY")
            return null
        }
        return key
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val key = validKey(call) ?: return
        try {
            val stored = prefs().getString(key, null)
            val result = JSObject()
            if (stored == null) {
                result.put("value", org.json.JSONObject.NULL)
                call.resolve(result)
                return
            }
            val parts = stored.split(":")
            if (parts.size != 2) {
                call.reject("CORRUPT_VALUE")
                return
            }
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val cipherText = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
            result.put("value", String(cipher.doFinal(cipherText), Charsets.UTF_8))
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("KEYSTORE_READ_FAILED", e)
        }
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = validKey(call) ?: return
        val value = call.getString("value")
        if (value == null) {
            call.reject("MISSING_VALUE")
            return
        }
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            val cipherText = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
                Base64.encodeToString(cipherText, Base64.NO_WRAP)
            if (!prefs().edit().putString(key, encoded).commit()) {
                call.reject("KEYSTORE_WRITE_FAILED")
                return
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject("KEYSTORE_WRITE_FAILED", e)
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = validKey(call) ?: return
        try {
            prefs().edit().remove(key).commit()
            call.resolve()
        } catch (e: Exception) {
            call.reject("KEYSTORE_REMOVE_FAILED", e)
        }
    }
}
