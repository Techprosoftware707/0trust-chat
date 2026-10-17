package io.lumen.secure.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import io.lumen.secure.BuildConfig
import io.lumen.secure.R
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.ui.theme.lumenColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.matrix.rustcomponents.sdk.MediaSource
import java.io.File
import java.util.UUID

/** Decrypted media stays in memory (bitmaps) or in the app's private cache (files opened by the user). */
object MediaLoader {
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    suspend fun bitmap(session: MatrixSession, source: MediaSource, maxPx: Int = 1280): Bitmap? {
        val key = source.url()
        cache.get(key)?.let { return it }
        return withContext(Dispatchers.IO) {
            try {
                val bytes = session.client.getMediaContent(source)
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / sample > maxPx || bounds.outHeight / sample > maxPx) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                    ?.also { cache.put(key, it) }
            } catch (e: Exception) {
                LumenLog.w("media", "image load failed", e)
                null
            }
        }
    }

    /** Decrypts to cache/opened and opens it with another app through FileProvider (read-only grant). */
    suspend fun open(context: Context, session: MatrixSession, source: MediaSource, filename: String, mimeType: String?): Boolean {
        val dir = File(context.cacheDir, "opened").apply { mkdirs() }
        val safeName = filename.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(80).ifBlank { "file" }
        val target = File(File(dir, UUID.randomUUID().toString()).apply { mkdirs() }, safeName)
        val ok = withContext(Dispatchers.IO) {
            try {
                target.writeBytes(session.client.getMediaContent(source))
                true
            } catch (e: Exception) {
                LumenLog.w("media", "file download failed", e)
                false
            }
        }
        if (!ok) return false
        val uri = FileProvider.getUriForFile(context, "${BuildConfig.APPLICATION_ID}.files", target)
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mimeType ?: "application/octet-stream")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(Intent.createChooser(intent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    suspend fun saveTo(context: Context, session: MatrixSession, source: MediaSource, target: Uri): Boolean = withContext(Dispatchers.IO) {
        try {
            val bytes = session.client.getMediaContent(source)
            context.contentResolver.openOutputStream(target)?.use { it.write(bytes) } != null
        } catch (e: Exception) {
            LumenLog.w("media", "save failed", e)
            false
        }
    }
}

/**
 * How message rows show and open encrypted media. The real one decrypts through the session;
 * the default draws a neutral placeholder (previews and screenshot tests have no session).
 */
interface MediaHost {
    @Composable
    fun Image(source: MediaSource, contentDescription: String, modifier: Modifier)

    suspend fun open(context: Context, source: MediaSource, filename: String, mimeType: String?): Boolean

    suspend fun save(context: Context, source: MediaSource, target: Uri): Boolean
}

class SessionMediaHost(private val session: MatrixSession) : MediaHost {
    @Composable
    override fun Image(source: MediaSource, contentDescription: String, modifier: Modifier) =
        EncryptedImage(session, source, contentDescription, modifier)

    override suspend fun open(context: Context, source: MediaSource, filename: String, mimeType: String?) =
        MediaLoader.open(context, session, source, filename, mimeType)

    override suspend fun save(context: Context, source: MediaSource, target: Uri) = MediaLoader.saveTo(context, session, source, target)
}

object PlaceholderMediaHost : MediaHost {
    @Composable
    override fun Image(source: MediaSource, contentDescription: String, modifier: Modifier) {
        Box(modifier.background(MaterialTheme.lumenColors.surface3), contentAlignment = Alignment.Center) {
            androidx.compose.material3.Icon(
                androidx.compose.ui.res.painterResource(R.drawable.ic_lucide_image), contentDescription,
                tint = MaterialTheme.lumenColors.textSubtle,
            )
        }
    }

    override suspend fun open(context: Context, source: MediaSource, filename: String, mimeType: String?) = false

    override suspend fun save(context: Context, source: MediaSource, target: Uri) = false
}

val LocalMediaHost = staticCompositionLocalOf<MediaHost> { PlaceholderMediaHost }

@Composable
fun EncryptedImage(session: MatrixSession, source: MediaSource, contentDescription: String, modifier: Modifier = Modifier) {
    var bitmap by remember(source) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(source) { mutableStateOf(false) }
    LaunchedEffect(source) {
        bitmap = MediaLoader.bitmap(session, source)
        failed = bitmap == null
    }
    val b = bitmap
    val c = MaterialTheme.lumenColors
    when {
        b != null -> Image(b.asImageBitmap(), contentDescription, modifier = modifier, contentScale = ContentScale.Crop)
        failed -> Box(modifier.background(c.surface2), contentAlignment = Alignment.Center) {
            androidx.compose.foundation.layout.Column(horizontalAlignment = Alignment.CenterHorizontally) {
                androidx.compose.material3.Icon(androidx.compose.ui.res.painterResource(R.drawable.ic_lucide_image), null, tint = c.textSubtle)
                Text(stringResource(R.string.media_load_failed), color = c.textMuted, style = MaterialTheme.typography.bodySmall)
            }
        }
        else -> Box(modifier.background(c.surface3), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(24.dp), color = c.accent, strokeWidth = 2.5.dp)
        }
    }
}

/** A picked file copied into the app's private cache, ready for the SDK's encrypted upload. */
data class PickedFile(val file: File, val name: String, val mimeType: String, val size: Long, val imageSize: Pair<Int, Int>?)

object Attachments {
    suspend fun copy(context: Context, uri: Uri): PickedFile? = withContext(Dispatchers.IO) {
        try {
            val cr = context.contentResolver
            var name = "file"
            var size = -1L
            cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getString(0)?.let { name = it }
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
            val mime = cr.getType(uri) ?: "application/octet-stream"
            val dir = File(context.cacheDir, "uploads").apply { mkdirs() }
            val out = File(dir, UUID.randomUUID().toString())
            cr.openInputStream(uri)?.use { input -> out.outputStream().use { input.copyTo(it) } } ?: return@withContext null
            val image = if (mime.startsWith("image/")) {
                val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(out.absolutePath, o)
                if (o.outWidth > 0 && o.outHeight > 0) o.outWidth to o.outHeight else null
            } else {
                null
            }
            PickedFile(out, name.take(200), mime, if (size >= 0) size else out.length(), image)
        } catch (e: Exception) {
            LumenLog.w("media", "attachment copy failed", e)
            null
        }
    }
}
