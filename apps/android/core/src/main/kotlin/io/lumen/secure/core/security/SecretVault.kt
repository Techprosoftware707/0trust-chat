package io.lumen.secure.core.security

/**
 * Wraps secrets with a non-exportable key (Android Keystore AES-256-GCM in the app; a software
 * AES key in tests). Implementations choose the IV; [SealedBlob] carries it.
 */
interface KeyWrapper {
    fun seal(plaintext: ByteArray, associatedData: ByteArray): SealedBlob
    fun open(blob: SealedBlob, associatedData: ByteArray): ByteArray
    fun deleteKey()
}

/** Byte storage for sealed secrets (files in `noBackupFilesDir` in the app). */
interface BlobStorage {
    fun read(name: String): ByteArray?
    fun write(name: String, bytes: ByteArray)
    fun delete(name: String)
    fun names(): Set<String>
}

/** Serialised form: `"LMS1" | ivLength(1) | iv | ciphertext+tag`. */
class SealedBlob(val iv: ByteArray, val ciphertext: ByteArray) {
    fun encode(): ByteArray {
        require(iv.size in 1..255)
        return MAGIC + byteArrayOf(iv.size.toByte()) + iv + ciphertext
    }

    companion object {
        private val MAGIC = "LMS1".toByteArray(Charsets.US_ASCII)

        fun decode(bytes: ByteArray): SealedBlob? {
            if (bytes.size < MAGIC.size + 2) return null
            if (!bytes.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) return null
            val ivLen = bytes[MAGIC.size].toInt() and 0xff
            val ivStart = MAGIC.size + 1
            if (ivLen == 0 || bytes.size < ivStart + ivLen + 16) return null
            return SealedBlob(bytes.copyOfRange(ivStart, ivStart + ivLen), bytes.copyOfRange(ivStart + ivLen, bytes.size))
        }
    }
}

class VaultException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Named secrets sealed under one [KeyWrapper] key. The secret's name is bound as associated
 * data, so a sealed blob cannot be swapped for another name's blob.
 */
class SecretVault(private val keys: KeyWrapper, private val storage: BlobStorage) {

    fun put(name: String, secret: ByteArray) {
        requireName(name)
        storage.write(name, keys.seal(secret, ad(name)).encode())
    }

    /** Returns null when no secret is stored; throws [VaultException] when it cannot be opened. */
    fun get(name: String): ByteArray? {
        requireName(name)
        val raw = storage.read(name) ?: return null
        val blob = SealedBlob.decode(raw) ?: throw VaultException("corrupt secret '$name'")
        return try {
            keys.open(blob, ad(name))
        } catch (e: Exception) {
            throw VaultException("secret '$name' cannot be opened", e)
        }
    }

    fun remove(name: String) {
        requireName(name)
        storage.delete(name)
    }

    /** Deletes every stored secret and the wrapping key. */
    fun wipe() {
        storage.names().forEach(storage::delete)
        keys.deleteKey()
    }

    private fun ad(name: String) = "lumen-vault:v1:$name".toByteArray(Charsets.UTF_8)

    private fun requireName(name: String) =
        require(Regex("^[a-z0-9_.-]{1,64}$").matches(name)) { "invalid secret name" }
}
