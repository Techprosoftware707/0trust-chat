package io.lumen.secure.core.config

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Minimal HTTP GET used by discovery; the app implements it with the platform TLS stack. */
fun interface HttpGet {
    /** Returns the response, or throws [java.io.IOException] when the server cannot be reached. */
    fun get(url: String): HttpResponse
}

data class HttpResponse(val status: Int, val body: String)

data class IdentityProvider(val id: String, val name: String)

data class LoginFlows(
    val sso: Boolean,
    val identityProviders: List<IdentityProvider>,
    val token: Boolean,
    val password: Boolean,
) {
    companion object {
        private val idPattern = Regex("^[A-Za-z0-9._~-]{1,255}$")

        /** Parses `GET /_matrix/client/v3/login`. Returns null for a malformed document. */
        fun parse(json: String): LoginFlows? {
            val doc = try {
                Json.parseToJsonElement(json) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return null
            val flows = doc["flows"] as? JsonArray ?: return null
            var sso = false
            var token = false
            var password = false
            val idps = mutableListOf<IdentityProvider>()
            for (f in flows) {
                val o = f as? JsonObject ?: continue
                when ((o["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content) {
                    "m.login.sso" -> {
                        sso = true
                        (o["identity_providers"] as? JsonArray)?.forEach { p ->
                            val po = p as? JsonObject ?: return@forEach
                            val id = (po["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@forEach
                            if (!idPattern.matches(id)) return@forEach
                            val name = (po["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                                ?.filter { !it.isISOControl() }?.take(64)?.ifBlank { null } ?: id
                            idps += IdentityProvider(id, name)
                        }
                    }
                    "m.login.token" -> token = true
                    "m.login.password" -> password = true
                }
            }
            return LoginFlows(sso, idps, token, password)
        }
    }
}

data class DiscoveredServer(
    /** The server name the user entered (null when they entered a URL). */
    val serverName: String?,
    val homeserverUrl: String,
    val lumen: LumenAppInfo?,
    val loginFlows: LoginFlows,
) {
    /** The SSO provider to use: the Lumen block's, else the only one offered, else none (generic SSO). */
    val ssoIdpId: String?
        get() = lumen?.ssoIdpId?.takeIf { id -> loginFlows.identityProviders.isEmpty() || loginFlows.identityProviders.any { it.id == id } }
            ?: loginFlows.identityProviders.singleOrNull()?.id

    val displayName: String
        get() = lumen?.brandName ?: serverName ?: homeserverUrl.substringAfter("://")
}

sealed interface DiscoveryResult {
    data class Ok(val server: DiscoveredServer) : DiscoveryResult
    data class Failed(val reason: DiscoveryFailure) : DiscoveryResult
}

enum class DiscoveryFailure {
    /** Not a server name, Matrix ID or acceptable URL. */
    INVALID_INPUT,

    /** The host could not be reached (DNS, TLS, timeout). */
    UNREACHABLE,

    /** `/.well-known/matrix/client` exists but is invalid (FAIL_PROMPT in the Matrix spec). */
    INVALID_WELL_KNOWN,

    /** `/_matrix/client/versions` did not answer like a Matrix server. */
    NOT_A_MATRIX_SERVER,

    /** The server offers no sign-in method this app supports (SSO or password). */
    NO_SUPPORTED_LOGIN,
}

/**
 * Server discovery (integration.md §2): well-known → versions → login flows.
 * All network access goes through [http]; nothing here disables certificate validation.
 */
class ServerDiscovery(private val http: HttpGet, private val debug: Boolean) {

    fun discover(rawInput: String): DiscoveryResult {
        val (serverName, homeserver, lumen) = when (val input = ServerInput.parse(rawInput, debug)) {
            ServerInput.Invalid -> return DiscoveryResult.Failed(DiscoveryFailure.INVALID_INPUT)
            is ServerInput.HomeserverUrl -> Triple(null, input.url, null)
            is ServerInput.ServerName -> {
                val wk = try {
                    http.get("https://${input.name}/.well-known/matrix/client")
                } catch (_: java.io.IOException) {
                    null
                }
                when {
                    // No well-known (404, unreachable well-known host): the server name is the base URL.
                    wk == null || wk.status == 404 -> {
                        val base = UrlPolicy.validateEndpointUrl("https://${input.name}", debug)
                            ?: return DiscoveryResult.Failed(DiscoveryFailure.INVALID_INPUT)
                        Triple(input.name, base, null)
                    }
                    wk.status !in 200..299 -> return DiscoveryResult.Failed(DiscoveryFailure.INVALID_WELL_KNOWN)
                    else -> when (val parsed = WellKnownParser.parse(wk.body, debug)) {
                        is WellKnownResult.Ok -> Triple(input.name, parsed.homeserver, parsed.lumen)
                        is WellKnownResult.Error -> return DiscoveryResult.Failed(DiscoveryFailure.INVALID_WELL_KNOWN)
                    }
                }
            }
        }
        val versions = try {
            http.get("$homeserver/_matrix/client/versions")
        } catch (_: java.io.IOException) {
            return DiscoveryResult.Failed(DiscoveryFailure.UNREACHABLE)
        }
        if (versions.status != 200 || !looksLikeVersions(versions.body)) {
            return DiscoveryResult.Failed(DiscoveryFailure.NOT_A_MATRIX_SERVER)
        }
        val login = try {
            http.get("$homeserver/_matrix/client/v3/login")
        } catch (_: java.io.IOException) {
            return DiscoveryResult.Failed(DiscoveryFailure.UNREACHABLE)
        }
        val flows = (if (login.status == 200) LoginFlows.parse(login.body) else null)
            ?: return DiscoveryResult.Failed(DiscoveryFailure.NOT_A_MATRIX_SERVER)
        if (!(flows.sso && flows.token) && !flows.password) {
            return DiscoveryResult.Failed(DiscoveryFailure.NO_SUPPORTED_LOGIN)
        }
        return DiscoveryResult.Ok(DiscoveredServer(serverName, homeserver, lumen, flows))
    }

    private fun looksLikeVersions(body: String): Boolean = try {
        val o = Json.parseToJsonElement(body) as? JsonObject
        (o?.get("versions") as? JsonArray)?.isNotEmpty() == true
    } catch (_: Exception) {
        false
    }
}
