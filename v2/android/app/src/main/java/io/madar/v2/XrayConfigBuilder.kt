package io.madar.v2

import org.json.JSONArray
import org.json.JSONObject

/** Strict VLESS client config generation. Server values are treated as data,
 * never as JSON fragments or shell input. Only Reality and TLS/WSS are allowed.
 */
object XrayConfigBuilder {
    private val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    private val endpointPattern = Regex("^[A-Za-z0-9][A-Za-z0-9.:-]{1,252}$")
    private val publicKeyPattern = Regex("^[A-Za-z0-9_-]{43}$")
    private val shortIdPattern = Regex("^[a-fA-F0-9]{0,16}$")

    fun build(snapshot: SubscriptionSnapshot, routeId: String, tunFd: Int): String {
        require(tunFd > 0) { "Invalid TUN descriptor" }
        require(snapshot.hasUsablePlan(System.currentTimeMillis())) { "Subscription is not usable" }
        require(uuidPattern.matches(snapshot.clientUuid)) { "Invalid client UUID" }
        val route = snapshot.routes.firstOrNull { it.id == routeId }
            ?: throw IllegalArgumentException("Route is not part of the subscription")
        require(endpointPattern.matches(route.host)) { "Invalid route endpoint" }
        require(endpointPattern.matches(route.serverName)) { "Invalid TLS server name" }
        require(route.port in 1..65535) { "Invalid route port" }

        val user = JSONObject()
            .put("id", snapshot.clientUuid)
            .put("encryption", "none")
        val stream = JSONObject()

        when (route.transport) {
            "reality" -> {
                val publicKey = route.realityPublicKey ?: throw IllegalArgumentException("Missing Reality public key")
                val shortId = route.realityShortId ?: throw IllegalArgumentException("Missing Reality short ID")
                require(publicKeyPattern.matches(publicKey)) { "Invalid Reality public key" }
                require(shortIdPattern.matches(shortId)) { "Invalid Reality short ID" }
                user.put("flow", "xtls-rprx-vision")
                stream.put("network", "raw")
                    .put("security", "reality")
                    .put("realitySettings", JSONObject()
                        .put("fingerprint", "chrome")
                        .put("serverName", route.serverName)
                        .put("publicKey", publicKey)
                        .put("shortId", shortId)
                        .put("spiderX", "/"))
            }
            "wss" -> {
                val path = route.websocketPath ?: throw IllegalArgumentException("Missing WebSocket path")
                require(path.startsWith("/") && path.length <= 256 &&
                    !Regex("[\\r\\n\\u0000-\\u001f?&#]").containsMatchIn(path)) {
                    "Invalid WebSocket path"
                }
                stream.put("network", "ws")
                    .put("security", "tls")
                    .put("tlsSettings", JSONObject()
                        .put("serverName", route.serverName)
                        .put("fingerprint", "chrome")
                        .put("allowInsecure", false))
                    .put("wsSettings", JSONObject()
                        .put("path", path)
                        .put("headers", JSONObject().put("Host", route.serverName)))
            }
            else -> throw IllegalArgumentException("Unsupported transport")
        }

        val outbound = JSONObject()
            .put("tag", "madar-proxy")
            .put("protocol", "vless")
            .put("settings", JSONObject().put("vnext", JSONArray().put(
                JSONObject()
                    .put("address", route.host)
                    .put("port", route.port)
                    .put("users", JSONArray().put(user))
            )))
            .put("streamSettings", stream)

        val tunInbound = JSONObject()
            .put("tag", "madar-tun")
            .put("port", 0)
            .put("protocol", "tun")
            .put("settings", JSONObject().put("name", "madar0").put("mtu", 1500))

        return JSONObject()
            .put("log", JSONObject().put("loglevel", "warning"))
            .put("env", JSONObject().put("xray.tun.fd", tunFd.toString()))
            .put("inbounds", JSONArray().put(tunInbound))
            .put("outbounds", JSONArray()
                .put(outbound)
                .put(JSONObject().put("tag", "direct").put("protocol", "freedom"))
                .put(JSONObject().put("tag", "blocked").put("protocol", "blackhole")))
            .put("routing", JSONObject().put("domainStrategy", "AsIs").put("rules", JSONArray().put(
                JSONObject()
                    .put("type", "field")
                    .put("inboundTag", JSONArray().put("madar-tun"))
                    .put("outboundTag", "madar-proxy")
            )))
            .put("policy", JSONObject().put("levels", JSONObject().put("0",
                JSONObject().put("statsUserUplink", true).put("statsUserDownlink", true)))
                .put("system", JSONObject()
                    .put("statsOutboundUplink", true)
                    .put("statsOutboundDownlink", true)))
            .put("stats", JSONObject())
            .put("metrics", JSONObject().put("listen", "127.0.0.1:49227"))
            .toString()
    }
}
