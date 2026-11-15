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
    data class Authorized(val token: String, val telegramId: String) : LoginFinishResult
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
                val telegramId = payload.getString("telegram_id")
                if (!SubscriptionTokenFormat.isValid(token) ||
                    !telegramId.matches(Regex("^[0-9]{5,20}$")))
                    LoginFinishResult.Error("INVALID_LOGIN")
                else LoginFinishResult.Authorized(token, telegramId)
            }
            else -> LoginFinishResult.Error(payload.optString("error", "LOGIN_FAILED"))
        }
    } catch (_: Exception) { LoginFinishResult.Error("NETWORK_ERROR") }

    private fun post(path: String, json: JSONObject): Pair<Int, JSONObject> {
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
            val bytes = json.toString().toByteArray(Charsets.UTF_8)
            require(bytes.size <= 512)
            conn.outputStream.use { it.write(bytes) }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { reader ->
                val buffer = CharArray(8193)
                val count = reader.read(buffer)
                if (count < 0) "" else {
                    require(count < 8192)
                    String(buffer, 0, count)
                }
            }.orEmpty()
            return status to (if (text.isBlank()) JSONObject() else JSONObject(text))
        } finally { conn.disconnect() }
    }
}
