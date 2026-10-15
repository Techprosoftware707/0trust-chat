package io.lumen.secure.security

import io.lumen.secure.core.security.SecretVault
import io.lumen.secure.core.security.StoredSession
import io.lumen.secure.core.security.VaultException
import io.lumen.secure.log.LumenLog
import java.security.SecureRandom

/**
 * Session persistence (ADR 0003 D7): the session JSON and the 32-byte key of the Rust SDK's
 * SQLite stores are sealed in the [SecretVault] (Android Keystore AES-256-GCM). Nothing secret is
 * written in plaintext.
 */
class SessionStore(private val vault: SecretVault) {

    fun load(): Pair<StoredSession, ByteArray>? = try {
        val json = vault.get(SESSION)?.toString(Charsets.UTF_8) ?: return null
        val session = StoredSession.fromJson(json) ?: return null
        val key = vault.get(dbKeyName(session.storeDir)) ?: return null
        session to key
    } catch (e: VaultException) {
        // The Keystore key is gone (e.g. device restored without it) or the blob is corrupt: the
        // session cannot be used. The caller treats this as signed out and wipes the stores.
        LumenLog.w("session", "stored session cannot be opened", e)
        null
    }

    fun saveSession(session: StoredSession) = vault.put(SESSION, session.toJson().toByteArray(Charsets.UTF_8))

    fun dbKey(storeDir: String): ByteArray? = try {
        vault.get(dbKeyName(storeDir))
    } catch (e: VaultException) {
        LumenLog.w("session", "store key cannot be opened", e)
        null
    }

    /** Creates and seals a new random key for a new store directory. */
    fun newDbKey(storeDir: String): ByteArray {
        val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
        vault.put(dbKeyName(storeDir), key)
        return key
    }

    fun removeDbKey(storeDir: String) = vault.remove(dbKeyName(storeDir))

    /** Deletes the session, all store keys and the Keystore key itself. */
    fun wipe() = vault.wipe()

    private fun dbKeyName(storeDir: String) = "dbkey_" + storeDir.lowercase().filter { it.isLetterOrDigit() || it == '_' || it == '-' }

    private companion object {
        const val SESSION = "session"
    }
}
