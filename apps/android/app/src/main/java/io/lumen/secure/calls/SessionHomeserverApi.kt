package io.lumen.secure.calls

import io.lumen.secure.core.calls.HomeserverApi
import io.lumen.secure.core.calls.NativeRtc
import io.lumen.secure.core.config.HttpResponse
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.MatrixSession
import io.lumen.secure.net.PlatformHttp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The session's homeserver with its access token, for [NativeRtc]. The token stays here: it goes
 * only into the Authorization header of requests to the session's own homeserver.
 */
class SessionHomeserverApi(private val session: MatrixSession) : HomeserverApi {
    private val base = session.homeserverUrl.trimEnd('/')

    override fun url(path: String): String = "$base/${path.trimStart('/')}"

    override fun request(method: String, path: String, jsonBody: String?): HttpResponse =
        PlatformHttp.request(method, url(path), session.client.session().accessToken, jsonBody)
}

/**
 * Whether the server offers calls, from the raw `GET …/org.matrix.msc4143/rtc/transports` answer
 * (the SDK's discoverRtcTransports() rejects Lumen's `{type: livekit, url}` form). Cached per
 * session; null = not known (offline), in which case the call buttons stay visible.
 */
class CallSupport {
    private val mutex = Mutex()
    private var cached: Pair<MatrixSession, Boolean>? = null

    suspend fun available(session: MatrixSession): Boolean? = mutex.withLock {
        cached?.takeIf { it.first === session }?.let { return it.second }
        val result = withContext(Dispatchers.IO) {
            try {
                val r = SessionHomeserverApi(session).request("GET", NativeRtc.TRANSPORTS_PATH, null)
                when (r.status) {
                    200 -> NativeRtc.hasTransports(r.body)
                    404 -> false
                    else -> null
                }
            } catch (e: java.io.IOException) {
                LumenLog.w("call", "RTC transports check failed", e)
                null
            }
        }
        if (result != null) cached = session to result
        result
    }
}
