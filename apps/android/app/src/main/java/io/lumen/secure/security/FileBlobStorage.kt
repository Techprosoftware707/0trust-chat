package io.lumen.secure.security

import android.util.AtomicFile
import io.lumen.secure.core.security.BlobStorage
import java.io.File

/** Sealed secrets as files in `noBackupFilesDir/vault` (never backed up), written atomically. */
class FileBlobStorage(private val dir: File) : BlobStorage {
    init {
        dir.mkdirs()
    }

    private fun file(name: String) = AtomicFile(File(dir, "$name.bin"))

    override fun read(name: String): ByteArray? = try {
        file(name).readFully()
    } catch (_: java.io.FileNotFoundException) {
        null
    }

    override fun write(name: String, bytes: ByteArray) {
        val f = file(name)
        val out = f.startWrite()
        try {
            out.write(bytes)
            f.finishWrite(out)
        } catch (e: Exception) {
            f.failWrite(out)
            throw e
        }
    }

    override fun delete(name: String) {
        file(name).delete()
    }

    override fun names(): Set<String> =
        dir.listFiles()?.mapNotNull { f -> f.name.takeIf { it.endsWith(".bin") }?.removeSuffix(".bin") }?.toSet().orEmpty()
}
