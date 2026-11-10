package io.madar.v2

/** The VpnService runtime must not start a virtual interface unless a vetted,
 * native engine can use that file descriptor immediately. This contract is
 * intentionally independent of libXray's currently unstable wrapper API.
 */
interface NativeTunnelEngine {
    fun available(): Boolean
    fun start(tunFd: Int, configJson: String): TunnelEngineOutcome
    fun verifyTraffic(): Boolean
    fun stop()
}

sealed interface TunnelEngineOutcome {
    data object Started : TunnelEngineOutcome
    data class Rejected(val code: String) : TunnelEngineOutcome
}

/** Default until a pinned libXray AAR with native TUN binding is built,
 * license-reviewed, tested and integrated. No blackhole interface is created.
 */
object UnavailableNativeEngine : NativeTunnelEngine {
    override fun available() = false
    override fun start(tunFd: Int, configJson: String) =
        TunnelEngineOutcome.Rejected("NATIVE_ENGINE_NOT_INSTALLED")
    override fun verifyTraffic() = false
    override fun stop() = Unit
}

class SafeTunnelCoordinator(private val engine: NativeTunnelEngine) {
    var state: ConnectionState = ConnectionState.Idle
        private set

    fun launch(tunFd: Int, configJson: String, routeId: String): ConnectionState {
        if (!engine.available() || tunFd < 0 || configJson.isBlank() || routeId.isBlank()) {
            state = ConnectionState.Failed("NATIVE_ENGINE_NOT_READY")
            return state
        }
        state = ConnectionState.Dialing(routeId)
        return when (engine.start(tunFd,configJson)) {
            is TunnelEngineOutcome.Rejected -> {
                state = ConnectionState.Failed("NATIVE_START_FAILED")
                state
            }
            TunnelEngineOutcome.Started -> {
                state = ConnectionState.TestingTraffic(routeId)
                state
            }
        }
    }

    fun verify(): ConnectionState {
        val current = state
        if (current is ConnectionState.TestingTraffic) {
            state = if (engine.verifyTraffic()) ConnectionState.Connected(current.routeId)
                else ConnectionState.Failed("TUNNELED_TRAFFIC_UNVERIFIED")
        }
        return state
    }

    fun stop() {
        engine.stop()
        state = ConnectionState.Idle
    }
}
