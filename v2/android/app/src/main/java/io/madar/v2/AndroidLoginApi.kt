package io.madar.v2

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

data class TelegramLoginChallenge(
    val id: String,
    val verifier: String,
    val url: String,
    val expiresAtMs: Long
)

sealed interface LoginStartResult {
    data class Ready(val challenge: TelegramLoginChallenge) : LoginStartResult
    data class Error(val code: String) : LoginStartResult
}

sealed interface LoginFinishResult {
    data object Pending : LoginFinishResult
    data class Authorized(val token: String) : LoginFinishResult
    data class Error(val code: String) : LoginFinishResult
}

/** No user-entered configuration. Telegram deep links contain only the public
 * challenge id. The private polling verifier stays on the device. */
class AndroidLoginApi(origin: String) {
    private val base: String
    init {
        val uri = URI(origin)
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() &&
            uri.userInfo == null && uri.query == null && uri.fragment == null &&
            (uri.path.isNullOrBlank() || uri.path == "/"))
        base = origin.trimEnd('/')
    }

    fun start(): LoginStartResult = try {
        val (status, payload) = post("/api/v2/android/login/start", JSONObject())
        if (status != 200) LoginStartResult.Error(payload.optString("error", "NOT_READY"))
        else {
            val id = payload.getString("id")
            val verifier = payload.getString("verifier")
            val url = payload.getString("login_url")
            val uri = URI(url)
            require(id.matches(Regex("^[A-Za-z0-9_-]{24}$")) &&
                SubscriptionTokenFormat.isValid(verifier) &&
                uri.scheme == "https" && uri.host == "t.me" &&
                uri.userInfo == null && uri.fragment == null &&
                uri.rawQuery == "start=app_$id" &&
                uri.path.matches(Regex("^/[A-Za-z][A-Za-z0-9_]{4,31}$")))
            LoginStartResult.Ready(TelegramLoginChallenge(
                id, verifier, url, payload.getLong("expires_at")
            ))
        }
    } catch (_: Exception) { LoginStartResult.Error("NETWORK_ERROR") }

    fun complete(challenge: TelegramLoginChallenge): LoginFinishResult = try {
        val body = JSONObject().put("id", challenge.id).put("verifier", challenge.verifier)
        val (status, payload) = post("/api/v2/android/login/complete", body)
        when (status) {
            202 -> LoginFinishResult.Pending
            200 -> {
                val token = payload.getString("access_token")
                if (!SubscriptionTokenFormat.isValid(token))
                    LoginFinishResult.Error("INVALID_LOGIN")
                else LoginFinishResult.Authorized(token)
            }
            else -> LoginFinishResult.Error(payload.optString("error", "LOGIN_FAILED"))
        }
    } catch (_: Exception) { LoginFinishResult.Error("NETWORK_ERROR") }

    /** Revoke this device's bearer token server-side during logout. */
    fun logout(token: String): Boolean {
        if (!SubscriptionTokenFormat.isValid(token)) return false
        return try {
            val (status, payload) = post(
                "/api/v2/android/logout", JSONObject(), token
            )
            status == 200 && payload.optString("status") == "signed_out"
        } catch (_: Exception) { false }
    }

    private fun post(
        path: String,
        json: JSONObject,
        bearerToken: String? = null
    ): Pair<Int, JSONObject> {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 7000
            conn.readTimeout = 10000
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.setRequestProperty("Accept", "application/json")
            if (bearerToken != null)
                conn.setRequestProperty("Authorization", "Bearer $bearerToken")
            val bytes = json.toString().toByteArray(Charsets.UTF_8)
            require(bytes.size <= 512)
            conn.outputStream.use { it.write(bytes) }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { input ->
                val bytes = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(1024)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    require(bytes.size() + count <= 8192) { "LOGIN_RESPONSE_TOO_LARGE" }
                    bytes.write(buffer, 0, count)
                }
                bytes.toString(Charsets.UTF_8.name())
            }.orEmpty()
            return status to (if (text.isBlank()) JSONObject() else JSONObject(text))
        } finally { conn.disconnect() }
    }
}
