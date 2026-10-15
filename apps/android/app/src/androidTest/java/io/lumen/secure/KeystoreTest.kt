package io.lumen.secure

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.lumen.secure.core.security.SecretVault
import io.lumen.secure.security.FileBlobStorage
import io.lumen.secure.security.KeystoreKeyWrapper
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** The real Android Keystore wrapper (AES-256-GCM, StrongBox when available). */
@RunWith(AndroidJUnit4::class)
class KeystoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun sealOpenAndDelete() {
        val wrapper = KeystoreKeyWrapper(context, "lumen_test_" + System.nanoTime())
        val dir = File(context.cacheDir, "vault-test-" + System.nanoTime())
        val vault = SecretVault(wrapper, FileBlobStorage(dir))
        val secret = ByteArray(32) { (it * 7).toByte() }
        vault.put("db_key", secret)
        assertArrayEquals(secret, vault.get("db_key"))
        assertNotNull(wrapper.strongBoxBacked)
        // The file on disk is ciphertext.
        val raw = File(dir, "db_key.bin").readBytes()
        assertTrue(!raw.toList().windowed(secret.size).any { it == secret.toList() })
        vault.wipe()
        assertNull(vault.get("db_key"))
        dir.deleteRecursively()
    }
}
