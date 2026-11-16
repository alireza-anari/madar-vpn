package io.madar.v2

import org.json.JSONObject

data class TrafficCounters(val uploadBytes: Long, val downloadBytes: Long)

/** Xray /debug/vars stats are nested as stats.outbound[tag][direction]. */
internal object XrayTrafficMetrics {
    fun counters(json: JSONObject): TrafficCounters? {
        val values = json.optJSONObject("stats")
            ?.optJSONObject("outbound")
            ?.optJSONObject("madar-proxy") ?: return null
        val upload = values.optLong("uplink", -1L)
        val download = values.optLong("downlink", -1L)
        return if (upload >= 0 && download >= 0) TrafficCounters(upload, download) else null
    }
    fun hasBidirectionalProxyTraffic(json: JSONObject): Boolean =
        counters(json)?.let { it.uploadBytes > 0 && it.downloadBytes > 0 } ?: false

    fun rate(previous: TrafficCounters, current: TrafficCounters, elapsedMs: Long): LiveSpeed {
        if (elapsedMs <= 0 || current.uploadBytes < previous.uploadBytes ||
            current.downloadBytes < previous.downloadBytes) return LiveSpeed()
        val scale = 8.0 * 1000 / (elapsedMs * 1_000_000)
        return LiveSpeed(
            downloadMbps = (current.downloadBytes - previous.downloadBytes) * scale,
            uploadMbps = (current.uploadBytes - previous.uploadBytes) * scale
        )
    }
}
