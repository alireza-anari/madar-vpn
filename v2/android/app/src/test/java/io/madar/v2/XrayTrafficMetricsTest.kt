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
}
