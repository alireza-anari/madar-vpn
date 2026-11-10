package io.madar.v2

import org.json.JSONObject

/** Xray /debug/vars stats are nested as stats.outbound[tag][direction]. */
internal object XrayTrafficMetrics {
    fun hasBidirectionalProxyTraffic(json: JSONObject): Boolean {
        val counters = json.optJSONObject("stats")
            ?.optJSONObject("outbound")
            ?.optJSONObject("madar-proxy") ?: return false
        return counters.optLong("uplink", 0L) > 0L &&
            counters.optLong("downlink", 0L) > 0L
    }
}
