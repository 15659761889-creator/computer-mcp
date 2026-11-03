package com.computermcp.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class VaultEntry(
    val id: String = UUID.randomUUID().toString(),
    val label: String,
    val username: String,
    val password: String,
)

/**
 * Saved accounts. They exist only on this phone, encrypted with a key the Android keystore holds,
 * and leave it one at a time, when the person allows the AI to type one.
 */
class VaultStore(context: Context) {
    private val prefs = context.getSharedPreferences("vault", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    fun load(): List<VaultEntry> {
        val sealed = prefs.getString("data", null) ?: return emptyList()
        val iv = prefs.getString("iv", null) ?: return emptyList()
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            val list = JSONArray(String(cipher.doFinal(Base64.decode(sealed, Base64.NO_WRAP))))
            List(list.length()) { index ->
                val e = list.getJSONObject(index)
                VaultEntry(e.getString("id"), e.getString("label"), e.optString("username"), e.optString("password"))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun save(entries: List<VaultEntry>) {
        val list = JSONArray()
        for (e in entries) list.put(JSONObject().put("id", e.id).put("label", e.label).put("username", e.username).put("password", e.password))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        prefs.edit()
            .putString("data", Base64.encodeToString(cipher.doFinal(list.toString().toByteArray()), Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    fun put(entry: VaultEntry) = save(load().filter { it.id != entry.id } + entry)

    fun remove(id: String) = save(load().filter { it.id != id })

    /** The entry whose name fits what the AI asked for, if any. */
    fun bestMatch(hint: String): VaultEntry? {
        val wanted = hint.trim().lowercase()
        val entries = load()
        return entries.find { it.label.lowercase() == wanted }
            ?: entries.find { it.label.lowercase().contains(wanted) || wanted.contains(it.label.lowercase()) }
    }

    private companion object {
        const val ALIAS = "computer-mcp-vault"
    }
}
