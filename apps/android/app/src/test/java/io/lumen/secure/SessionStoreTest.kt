package io.lumen.secure

import io.lumen.secure.core.security.BlobStorage
import io.lumen.secure.core.security.KeyWrapper
import io.lumen.secure.core.security.SealedBlob
import io.lumen.secure.core.security.SecretVault
import io.lumen.secure.core.security.StoredSession
import io.lumen.secure.security.SessionStore
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * SessionStore on the vault, with a software AES-256-GCM [KeyWrapper] standing in for the
 * Android Keystore wrapper (the real one is exercised by the instrumented KeystoreTest).
 */
class SessionStoreTest {
    private class FakeKeystore : KeyWrapper {
        var key: SecretKey? = null
        override fun seal(plaintext: ByteArray, associatedData: ByteArray): SealedBlob {
            val k = key ?: KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { key = it }
            val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, k, GCMParameterSpec(128, iv)); updateAAD(associatedData) }
            return SealedBlob(iv, c.doFinal(plaintext))
        }
        override fun open(blob: SealedBlob, associatedData: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key ?: throw IllegalStateException("key deleted"), GCMParameterSpec(128, blob.iv))
                updateAAD(associatedData)
            }
            return c.doFinal(blob.ciphertext)
        }
        override fun deleteKey() { key = null }
    }

    private class Mem : BlobStorage {
        val m = mutableMapOf<String, ByteArray>()
        override fun read(name: String) = m[name]
        override fun write(name: String, bytes: ByteArray) { m[name] = bytes }
        override fun delete(name: String) { m.remove(name) }
        override fun names() = m.keys.toSet()
    }

    private val session = StoredSession("@a:example.com", "DEVICE", "syt_token", "syr_refresh", "https://m.example.com", null, "NATIVE", "0123456789abcdef", "example.com")

    @Test
    fun `session and store key round trip, nothing in plaintext`() {
        val keys = FakeKeystore()
        val mem = Mem()
        val store = SessionStore(SecretVault(keys, mem))
        val dbKey = store.newDbKey(session.storeDir)
        assertEquals(32, dbKey.size)
        store.saveSession(session)
        val (s, k) = store.load()!!
        assertEquals(session, s)
        assertArrayEquals(dbKey, k)
        mem.m.values.forEach { blob -> assertTrue(!String(blob, Charsets.ISO_8859_1).contains("syt_token")) }
    }

    @Test
    fun `a lost Keystore key means no session, not a crash`() {
        val keys = FakeKeystore()
        val store = SessionStore(SecretVault(keys, Mem()))
        store.newDbKey(session.storeDir)
        store.saveSession(session)
        keys.key = null // e.g. Keystore entry removed
        assertNull(store.load())
    }

    @Test
    fun `wipe deletes everything including the key`() {
        val keys = FakeKeystore()
        val mem = Mem()
        val store = SessionStore(SecretVault(keys, mem))
        store.newDbKey(session.storeDir)
        store.saveSession(session)
        store.wipe()
        assertTrue(mem.m.isEmpty())
        assertNull(keys.key)
        assertNull(store.load())
    }
}
