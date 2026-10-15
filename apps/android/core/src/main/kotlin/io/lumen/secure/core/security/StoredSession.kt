package io.lumen.secure.core.security

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The persisted session (sealed in the vault, never stored in plaintext). Mirrors the Rust SDK's
 * `Session` plus what the app needs to rebuild the client.
 */
data class StoredSession(
    val userId: String,
    val deviceId: String,
    val accessToken: String,
    val refreshToken: String?,
    val homeserverUrl: String,
    val oauthData: String?,
    val slidingSyncVersion: String,
    /** Directory name (under noBackupFilesDir / cacheDir) of this session's Rust SDK stores. */
    val storeDir: String,
    val serverName: String?,
) {
    fun toJson(): String = buildJsonObject {
        put("v", 1)
        put("user_id", userId)
        put("device_id", deviceId)
        put("access_token", accessToken)
        refreshToken?.let { put("refresh_token", it) }
        put("homeserver_url", homeserverUrl)
        oauthData?.let { put("oauth_data", it) }
        put("sliding_sync_version", slidingSyncVersion)
        put("store_dir", storeDir)
        serverName?.let { put("server_name", it) }
    }.toString()

    /** Debug representation without secrets. */
    override fun toString(): String = "StoredSession(device=$deviceId, storeDir=$storeDir)"

    companion object {
        fun fromJson(json: String): StoredSession? {
            val o = try {
                Json.parseToJsonElement(json) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return null
            fun s(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if ((o["v"] as? JsonPrimitive)?.content != "1") return null
            return StoredSession(
                userId = s("user_id") ?: return null,
                deviceId = s("device_id") ?: return null,
                accessToken = s("access_token") ?: return null,
                refreshToken = s("refresh_token"),
                homeserverUrl = s("homeserver_url") ?: return null,
                oauthData = s("oauth_data"),
                slidingSyncVersion = s("sliding_sync_version") ?: return null,
                storeDir = s("store_dir")?.takeIf { Regex("^[A-Za-z0-9_-]{8,64}$").matches(it) } ?: return null,
                serverName = s("server_name"),
            )
        }
    }
}
