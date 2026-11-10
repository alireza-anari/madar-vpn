package io.madar.v2

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class XrayConfigBuilderTest {
    private val uuid="123e4567-e89b-42d3-a456-426614174000"
    private val reality=VerifiedRoute("r1","reality","vpn.example.com",443,
        "www.example.com",null,"A".repeat(43),"0123456789abcdef")
    private val wss=VerifiedRoute("r2","wss","vpn.example.com",443,
        "vpn.example.com","/edge/ws",null,null)
    private fun snapshot(route: VerifiedRoute)=SubscriptionSnapshot(
        "sub",System.currentTimeMillis()+60_000,1024,0,uuid,listOf(route)
    )

    @Test fun realityBuildUsesRawRealityAndTunFd() {
        val root=JSONObject(XrayConfigBuilder.build(snapshot(reality),"r1",42))
        assertEquals("42",root.getJSONObject("env").getString("xray.tun.fd"))
        assertEquals("tun",root.getJSONArray("inbounds").getJSONObject(0).getString("protocol"))
        val out=root.getJSONArray("outbounds").getJSONObject(0)
        assertEquals("vless",out.getString("protocol"))
        val stream=out.getJSONObject("streamSettings")
        assertEquals("raw",stream.getString("network"))
        assertEquals("reality",stream.getString("security"))
        assertEquals("xtls-rprx-vision",out.getJSONObject("settings")
            .getJSONArray("vnext").getJSONObject(0).getJSONArray("users")
            .getJSONObject(0).getString("flow"))
        assertFalse(stream.getJSONObject("realitySettings").has("privateKey"))
    }

    @Test fun wssBuildRequiresTlsAndCorrectHostPath() {
        val root=JSONObject(XrayConfigBuilder.build(snapshot(wss),"r2",43))
        val stream=root.getJSONArray("outbounds").getJSONObject(0).getJSONObject("streamSettings")
        assertEquals("ws",stream.getString("network"))
        assertEquals("tls",stream.getString("security"))
        assertFalse(stream.getJSONObject("tlsSettings").getBoolean("allowInsecure"))
        assertEquals("/edge/ws",stream.getJSONObject("wsSettings").getString("path"))
        assertEquals("vpn.example.com",stream.getJSONObject("wsSettings")
            .getJSONObject("headers").getString("Host"))
    }

    @Test fun invalidOrUnassignedRouteNeverBuilds() {
        assertThrows(IllegalArgumentException::class.java) {
            XrayConfigBuilder.build(snapshot(reality),"not-assigned",42)
        }
        assertThrows(IllegalArgumentException::class.java) {
            XrayConfigBuilder.build(snapshot(reality.copy(realityPublicKey="bad")),"r1",42)
        }
        assertThrows(IllegalArgumentException::class.java) {
            XrayConfigBuilder.build(snapshot(wss.copy(websocketPath="/ws\r\nInjected: x")),"r2",42)
        }
        assertThrows(IllegalArgumentException::class.java) {
            XrayConfigBuilder.build(snapshot(reality), "r1", -1)
        }
    }
}
