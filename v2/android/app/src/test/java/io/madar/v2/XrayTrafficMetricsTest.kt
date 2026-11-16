package io.madar.v2

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class XrayTrafficMetricsTest {
    @Test fun acceptsOnlyBidirectionalTrafficOnSelectedProxy() {
        val metrics = JSONObject("""{"stats":{"outbound":{"madar-proxy":{"uplink":123,"downlink":56},"direct":{"uplink":8000,"downlink":9000}}}}""")
        assertTrue(XrayTrafficMetrics.hasBidirectionalProxyTraffic(metrics))
    }

    @Test fun ignoresDirectTrafficOrOnlyOneDirection() {
        assertFalse(XrayTrafficMetrics.hasBidirectionalProxyTraffic(
            JSONObject("""{"stats":{"outbound":{"direct":{"uplink":123,"downlink":456}}}}""")))
        assertFalse(XrayTrafficMetrics.hasBidirectionalProxyTraffic(
            JSONObject("""{"stats":{"outbound":{"madar-proxy":{"uplink":123,"downlink":0}}}}""")))
        assertFalse(XrayTrafficMetrics.hasBidirectionalProxyTraffic(
            JSONObject("""{"stats":{"outbound":{"madar-proxy":{"uplink":0,"downlink":123}}}}""")))
    }

    @Test fun rejectsLegacyFlatMetricsAndMalformedPayloads() {
        assertFalse(XrayTrafficMetrics.hasBidirectionalProxyTraffic(
            JSONObject("""{"outbound>>>madar-proxy>>>traffic>>>uplink":123,"outbound>>>madar-proxy>>>traffic>>>downlink":456}""")))
        assertFalse(XrayTrafficMetrics.hasBidirectionalProxyTraffic(JSONObject("{}")))
    }

    @Test fun measuresRealByteDeltaInMegabitsPerSecond() {
        val before = TrafficCounters(uploadBytes=1000, downloadBytes=2000)
        val after = TrafficCounters(uploadBytes=1_001_000, downloadBytes=2_002_000)
        val speed = XrayTrafficMetrics.rate(before, after, 1000)
        assertTrue(kotlin.math.abs(speed.uploadMbps - 8.0) < 0.01)
        assertTrue(kotlin.math.abs(speed.downloadMbps - 16.0) < 0.01)
        assertTrue(XrayTrafficMetrics.rate(after, before, 1000) == LiveSpeed())
        assertTrue(XrayTrafficMetrics.rate(before, after, 0) == LiveSpeed())
    }

}
