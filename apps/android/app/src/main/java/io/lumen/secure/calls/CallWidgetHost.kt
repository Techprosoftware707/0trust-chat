package io.lumen.secure.calls

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import io.lumen.secure.BuildConfig
import io.lumen.secure.core.calls.BridgeInbound
import io.lumen.secure.core.calls.CallAction
import io.lumen.secure.core.calls.CallStateUpdate
import io.lumen.secure.core.calls.CallWidgetUrl
import io.lumen.secure.core.calls.NativeRtc
import io.lumen.secure.core.calls.WidgetBridge
import io.lumen.secure.log.LumenLog
import io.lumen.secure.matrix.MatrixSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.matrix.rustcomponents.sdk.ClientProperties
import org.matrix.rustcomponents.sdk.WidgetCapabilities
import org.matrix.rustcomponents.sdk.WidgetCapabilitiesProvider
import org.matrix.rustcomponents.sdk.WidgetDriverHandle
import org.matrix.rustcomponents.sdk.WidgetSettings
import org.matrix.rustcomponents.sdk.generateWebviewUrl
import org.matrix.rustcomponents.sdk.getElementCallRequiredPermissions
import org.matrix.rustcomponents.sdk.makeWidgetDriver
import java.util.UUID

/**
 * Runs the bundled Lumen call widget (integration.md §6.2) in a WebView served by
 * WebViewAssetLoader at https://appassets.androidplatform.net/call-widget/, connected to the
 * Rust SDK's widget driver:
 * - widget → native: `window.lumenNative.postMessage(json)` via WebViewCompat.addWebMessageListener,
 *   restricted to the asset origin and the main frame (no addJavascriptInterface);
 * - native → widget: `window.postMessage(<json>, origin)` via evaluateJavascript;
 * - the driver's capability provider grants exactly getElementCallRequiredPermissions().
 */
class CallWidgetHost(
    private val context: Context,
    private val session: MatrixSession,
    private val roomId: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onCallState(update: CallStateUpdate)
        fun onFatal(reason: Failure)
        /** The page asks for camera/microphone; return true while the call screen is shown. */
        fun isCallScreenVisible(): Boolean
    }

    enum class Failure { WEBVIEW_TOO_OLD, ROOM_NOT_FOUND, WIDGET_URL_INVALID, DRIVER_FAILED, RENDERER_GONE }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val widgetId = UUID.randomUUID().toString()
    private var handle: WidgetDriverHandle? = null
    private var driverJob: Job? = null

    /** MSC4533 SFU token and MSC4515 transports, answered next to the driver (see NativeRtc). */
    private val nativeRtc = NativeRtc(roomId, session.userId, session.deviceId, widgetId, SessionHomeserverApi(session))

    @SuppressLint("SetJavaScriptEnabled")
    val webView: WebView = WebView(context).apply {
        settings.javaScriptEnabled = true // the widget is a JavaScript app (bundled, same-origin assets only)
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.setGeolocationEnabled(false)
        settings.mediaPlaybackRequiresUserGesture = false
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }

    private val assetLoader = WebViewAssetLoader.Builder()
        .setDomain(CallWidgetUrl.ASSET_ORIGIN.toUri().host!!)
        .addPathHandler("/call-widget/", WidgetAssets(context))
        .build()

    private class WidgetAssets(context: Context) : WebViewAssetLoader.PathHandler {
        private val assets = WebViewAssetLoader.AssetsPathHandler(context)
        override fun handle(path: String): WebResourceResponse? {
            if (path.contains("..")) return null
            return assets.handle("call-widget/$path")
        }
    }

    suspend fun start(intent: CallWidgetUrl.Intent, video: Boolean, notify: CallWidgetUrl.Notify, dark: Boolean, lang: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            listener.onFatal(Failure.WEBVIEW_TOO_OLD)
            return
        }
        val room = session.client.getRoom(roomId) ?: run {
            listener.onFatal(Failure.ROOM_NOT_FOUND)
            return
        }
        val theme = if (dark) "dark" else "light"
        val settings = WidgetSettings(
            widgetId = widgetId,
            initAfterContentLoad = true,
            rawUrl = CallWidgetUrl.rawUrl(intent, video, notify, theme, lang),
        )
        val url = try {
            generateWebviewUrl(settings, room, ClientProperties(clientId = BuildConfig.APPLICATION_ID, languageTag = lang, theme = theme))
        } catch (e: Exception) {
            LumenLog.e("call", "widget URL generation failed", e)
            listener.onFatal(Failure.WIDGET_URL_INVALID)
            return
        }
        if (!url.startsWith(CallWidgetUrl.INDEX + "?")) {
            listener.onFatal(Failure.WIDGET_URL_INVALID)
            return
        }
        val driverAndHandle = try {
            makeWidgetDriver(settings)
        } catch (e: Exception) {
            LumenLog.e("call", "widget driver creation failed", e)
            listener.onFatal(Failure.DRIVER_FAILED)
            return
        }
        handle = driverAndHandle.handle
        val ownUser = session.userId
        val ownDevice = session.deviceId
        driverJob = scope.launch(Dispatchers.Default) {
            try {
                driverAndHandle.driver.run(room, object : WidgetCapabilitiesProvider {
                    override suspend fun acquireCapabilities(capabilities: WidgetCapabilities): WidgetCapabilities =
                        getElementCallRequiredPermissions(ownUser, ownDevice)
                })
            } catch (e: Exception) {
                LumenLog.w("call", "widget driver stopped", e)
            }
        }
        scope.launch(Dispatchers.Default) {
            val h = driverAndHandle.handle
            while (isActive) {
                val msg = h.recv() ?: break
                val amended = nativeRtc.onToWidget(msg)
                withContext(Dispatchers.Main) { deliver(amended) }
            }
        }
        installBridge()
        webView.loadUrl(url)
    }

    private fun installBridge() {
        webView.webViewClient = WidgetWebViewClient()
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val fromWidget = request.origin.toString().trimEnd('/') == CallWidgetUrl.ASSET_ORIGIN
                val allowed = request.resources.filter { r ->
                    when (r) {
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> granted(android.Manifest.permission.RECORD_AUDIO)
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> granted(android.Manifest.permission.CAMERA)
                        else -> false
                    }
                }
                if (fromWidget && listener.isCallScreenVisible() && allowed.isNotEmpty()) {
                    request.grant(allowed.toTypedArray())
                } else {
                    request.deny()
                }
            }
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(
            webView,
            "lumenNative",
            setOf(CallWidgetUrl.ASSET_ORIGIN),
        ) { _: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, _: JavaScriptReplyProxy ->
            if (!isMainFrame || sourceOrigin.toString().trimEnd('/') != CallWidgetUrl.ASSET_ORIGIN) return@addWebMessageListener
            val data = message.data ?: return@addWebMessageListener
            when (val m = WidgetBridge.classify(data, widgetId)) {
                is BridgeInbound.ToDriver -> when (val r = nativeRtc.onFromWidget(m.json)) {
                    NativeRtc.FromWidget.Forward -> handle?.send(m.json)
                    is NativeRtc.FromWidget.Intercepted -> scope.launch(Dispatchers.IO) {
                        val answer = nativeRtc.answer(r.request)
                        withContext(Dispatchers.Main) { deliver(answer) }
                    }
                }
                is BridgeInbound.CallState -> {
                    m.ack?.let(::deliver)
                    listener.onCallState(m.update)
                }
                is BridgeInbound.Drop -> LumenLog.d("call", "dropped widget message: ${m.reason}")
            }
        }
    }

    // onRenderProcessGone is implemented below; the androidx.webkit detector flags the Kotlin
    // supertype constructor call `WebViewClient()` itself.
    @SuppressLint("MissingOnRenderProcessGone")
    private inner class WidgetWebViewClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            assetLoader.shouldInterceptRequest(request.url)

        // The widget never navigates; anything else is refused.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            !request.url.toString().startsWith(CallWidgetUrl.ASSET_ORIGIN + "/call-widget/")

        // The renderer crashed or was killed for memory: end the call instead of crashing the app.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            LumenLog.w("call", "WebView renderer gone (crash=${detail.didCrash()})")
            listener.onFatal(Failure.RENDERER_GONE)
            return true
        }
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED

    private fun deliver(json: String) {
        val script = WidgetBridge.postMessageScript(json, CallWidgetUrl.ASSET_ORIGIN) ?: return
        webView.evaluateJavascript(script, null)
    }

    fun sendAction(action: CallAction) {
        deliver(WidgetBridge.actionMessage(action))
    }

    fun destroy() {
        driverJob?.cancel()
        scope.cancel()
        handle = null
        webView.stopLoading()
        webView.destroy()
    }
}
