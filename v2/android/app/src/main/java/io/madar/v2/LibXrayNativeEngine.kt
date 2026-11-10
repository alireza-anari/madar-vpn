package io.madar.v2

import android.net.VpnService
import go.libXray.DialerController
import go.libXray.LibXray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private object MadarSocketProtector : DialerController {
    @Volatile private var service: java.lang.ref.WeakReference<VpnService>? = null
    fun attach(value: VpnService) { service = java.lang.ref.WeakReference(value) }
    fun detach() { service = null }
    override fun protectFd(fd: Int): Boolean = service?.get()?.protect(fd) == true
}

class LibXrayNativeEngine(private val vpnService: VpnService) : NativeTunnelEngine {
    @Volatile private var started = false
    override fun available(): Boolean = true

    override fun start(tunFd: Int, configJson: String): TunnelEngineOutcome {
        if (tunFd <= 0 || configJson.isBlank()) return TunnelEngineOutcome.Rejected("INVALID_TUN")
        return try {
            MadarSocketProtector.attach(vpnService)
            LibXray.registerDialerController(MadarSocketProtector)
            LibXray.setDNS(MadarSocketProtector, "1.1.1.1:53")
            val response = invoke("runXray", JSONObject().put("xrayJson", configJson))
            if (!response.optBoolean("success", false)) {
                reset()
                TunnelEngineOutcome.Rejected("XRAY_START_REJECTED")
            } else {
                val state = invoke("getXrayState")
                val running = state.optJSONObject("data")?.optBoolean("running", false) == true
                if (!state.optBoolean("success", false) || !running) {
                    stopCore()
                    TunnelEngineOutcome.Rejected("XRAY_NOT_RUNNING")
                } else {
                    started = true
                    TunnelEngineOutcome.Started
                }
            }
        } catch (_: Exception) {
            stopCore()
            TunnelEngineOutcome.Rejected("XRAY_START_FAILED")
        }
    }

    override fun verifyTraffic(): Boolean {
        if (!started) return false
        return try {
            val state = invoke("getXrayState")
            if (!state.optBoolean("success", false) ||
                state.optJSONObject("data")?.optBoolean("running", false) != true) return false
            val probeOk = listOf(
                "https://cp.cloudflare.com/generate_204",
                "https://www.gstatic.com/generate_204"
            ).any { url ->
                runCatching {
                    val connection = URL(url).openConnection() as HttpURLConnection
                    try {
                        connection.connectTimeout = 8000
                        connection.readTimeout = 8000
                        connection.instanceFollowRedirects = false
                        connection.useCaches = false
                        connection.requestMethod = "GET"
                        connection.responseCode == 204
                    } finally { connection.disconnect() }
                }.getOrDefault(false)
            }
            if (!probeOk) return false
            var observed = false
            repeat(4) {
                val metrics = runCatching {
                    val connection = URL("http://127.0.0.1:49227/debug/vars")
                        .openConnection() as HttpURLConnection
                    try {
                        connection.connectTimeout = 1500
                        connection.readTimeout = 1500
                        connection.useCaches = false
                        JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
                    } finally { connection.disconnect() }
                }.getOrNull()
                if (metrics != null) {
                    val up = metrics.optLong("outbound>>>madar-proxy>>>traffic>>>uplink", 0L)
                    val down = metrics.optLong("outbound>>>madar-proxy>>>traffic>>>downlink", 0L)
                    if (up > 0L && down > 0L) observed = true
                }
                if (!observed) Thread.sleep(250)
            }
            observed
        } catch (_: Exception) { false }
    }

    override fun stop() = stopCore()

    private fun invoke(method: String, payload: JSONObject? = null): JSONObject {
        val request = JSONObject().put("apiVersion", 3).put("method", method)
        if (payload != null) request.put("payload", payload)
        return JSONObject(LibXray.invoke(request.toString()))
    }

    private fun stopCore() {
        runCatching { invoke("stopXray") }
        started = false
        reset()
    }

    private fun reset() {
        runCatching { LibXray.resetDNS() }
        MadarSocketProtector.detach()
    }
}
