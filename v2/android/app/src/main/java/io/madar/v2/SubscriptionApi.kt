package io.madar.v2

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets

data class VerifiedRoute(
    val id: String,
    val transport: String,
    val host: String,
    val port: Int,
    val serverName: String,
    val websocketPath: String?,
    val realityPublicKey: String?,
    val realityShortId: String?,
    val operatorHint: String? = null
)

data class SubscriptionSnapshot(
    val id: String,
    val expiresAtMs: Long,
    val quotaBytes: Long,
    val usedBytes: Long,
    val clientUuid: String,
    val routes: List<VerifiedRoute>
) {
    fun hasUsablePlan(nowMs: Long): Boolean =
        expiresAtMs > nowMs && quotaBytes > 0 && usedBytes < quotaBytes && routes.isNotEmpty()
}

sealed interface SubscriptionResult {
    data class Available(val snapshot: SubscriptionSnapshot) : SubscriptionResult
    data class Unavailable(val code: String) : SubscriptionResult
}

object SubscriptionTokenFormat {
    private val token = Regex("^[A-Za-z0-9_-]{43}$")
    fun isValid(value: String?): Boolean = value != null && token.matches(value)

    /** A single HTTPS subscription URL works in both v2rayNG and Madar.
     * Parse only our configured API origin: never fetch a pasted foreign URL
     * and never accept query-based or userinfo-based credentials.
     */
    fun fromInput(value: String?, configuredOrigin: String): String? {
        val trimmed = value?.trim() ?: return null
        if (isValid(trimmed)) return trimmed // Legacy private preview support.
        return try {
            val expected = URI(configuredOrigin)
            val supplied = URI(trimmed)
            if (expected.scheme != "https" || expected.host.isNullOrBlank() ||
                expected.rawQuery != null || expected.rawFragment != null ||
                expected.userInfo != null ||
                (expected.path.isNotBlank() && expected.path != "/") ||
                supplied.scheme != "https" || supplied.userInfo != null ||
                supplied.rawQuery != null || supplied.rawFragment != null ||
                supplied.host == null ||
                !supplied.host.equals(expected.host, ignoreCase = true) ||
                supplied.port != expected.port)
                null
            else {
                val path = supplied.rawPath
                val part = if (path.startsWith("/s/")) path.removePrefix("/s/") else ""
                if (isValid(part)) part else null
            }
        } catch (_: Exception) { null }
    }
}

/**
 * This client only fetches route metadata; it DOES NOT establish a VPN tunnel.
 * Tokens are sent in Authorization, never in URL/query/logs. Redirects are off
 * so the Authorization header cannot be forwarded to another host.
 */
class SubscriptionApi(baseUrl: String) {
    private val endpoint: String

    init {
        val parsed = URI(baseUrl)
        require(parsed.scheme == "https" && !parsed.host.isNullOrBlank() &&
            parsed.userInfo == null && parsed.query == null && parsed.fragment == null &&
            (parsed.path.isNullOrBlank() || parsed.path == "/")) {
            "Expected an HTTPS API origin without path, userinfo or query"
        }
        endpoint = parsed.toString().trimEnd('/') + "/api/v2/subscription"
    }

    fun fetch(token: String): SubscriptionResult {
        if (!SubscriptionTokenFormat.isValid(token))
            return SubscriptionResult.Unavailable("INVALID_TOKEN")
        var connection: HttpURLConnection? = null
        try {
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 5000
                readTimeout = 8000
                instanceFollowRedirects = false
                useCaches = false
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Cache-Control", "no-store")
            }
            val status = connection.responseCode
            if (status != 200) return SubscriptionResult.Unavailable(
                when (status) {
                    401, 403 -> "SUBSCRIPTION_UNAVAILABLE"
                    429 -> "TRY_LATER"
                    503 -> "SERVER_UNAVAILABLE"
                    else -> "NETWORK_ERROR"
                }
            )
            val stream = connection.inputStream
            val bytes = ByteArrayOutputStream()
            stream.use { input ->
                val buffer = ByteArray(4096)
                while (true) {
                    val count = input.read(buffer)
                    if (count == -1) break
                    if (bytes.size() + count > 65536)
                        return SubscriptionResult.Unavailable("RESPONSE_TOO_LARGE")
                    bytes.write(buffer, 0, count)
                }
            }
            val payload = JSONObject(bytes.toString(StandardCharsets.UTF_8.name()))
            val profile = parseSubscription(payload)
            return if (profile.hasUsablePlan(System.currentTimeMillis()))
                SubscriptionResult.Available(profile)
            else SubscriptionResult.Unavailable("SUBSCRIPTION_EXPIRED_OR_EMPTY")
        } catch (_: Exception) {
            // No raw tokens, PII, URLs or server responses in any log.
            return SubscriptionResult.Unavailable("NETWORK_ERROR")
        } finally {
            connection?.disconnect()
        }
    }

    private fun parseSubscription(json: JSONObject): SubscriptionSnapshot {
        require(json.getInt("version") == 1)
        val client = json.getJSONObject("client")
        require(client.getString("protocol") == "vless")
        val uuid = client.getString("uuid")
        require(Regex("^[0-9a-fA-F-]{36}$").matches(uuid))
        val array = json.getJSONArray("routes")
        require(array.length() in 1..8)
        val routes = (0 until array.length()).map { i ->
            val route = array.getJSONObject(i)
            val endpoint = route.getJSONObject("endpoint")
            val tls = route.getJSONObject("tls")
            val host = endpoint.getString("host")
            val port = endpoint.getInt("port")
            val transport = route.getString("transport")
            val sni = tls.getString("server_name")
            require(host.isNotBlank() && host.length <= 253 &&
                sni.isNotBlank() && sni.length <= 253 && port in 1..65535)
            require(transport == "reality" || transport == "wss")
            val wsPath = if (transport == "wss")
                route.getJSONObject("websocket").getString("path") else null
            val hint = if (route.isNull("operator_hint")) null else route.getString("operator_hint")
            require(hint == null || CarrierOperator.fromCode(hint) != null)
            val pubKey = if (transport == "reality")
                tls.getString("reality_public_key") else null
            val shortId = if (transport == "reality")
                tls.getString("short_id") else null
            require((wsPath == null || (wsPath.startsWith("/") && wsPath.length <= 256)) &&
                (pubKey == null || pubKey.length == 43))
            VerifiedRoute(
                id = route.getString("id"),
                transport = transport,
                host = host,
                port = port,
                serverName = sni,
                websocketPath = wsPath,
                realityPublicKey = pubKey,
                realityShortId = shortId,
                operatorHint = hint
            )
        }
        val id = json.getString("subscription_id")
        val expiry = json.getLong("expires_at")
        val quota = json.getLong("quota_bytes")
        val used = json.getLong("used_bytes")
        require(id.isNotBlank() && quota >= 0 && used >= 0)
        return SubscriptionSnapshot(id, expiry, quota, used, uuid, routes)
    }
}
