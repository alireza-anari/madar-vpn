package io.madar.v2

/** A conservative UI state machine: no handshake-only "Connected" state. */
data class Candidate(val id: String, val verified: Boolean, val capacityAvailable: Boolean)
sealed interface ConnectionState {
    data object Idle : ConnectionState
    data class Dialing(val routeId: String) : ConnectionState
    data class TestingTraffic(val routeId: String) : ConnectionState
    data class Connected(val routeId: String) : ConnectionState
    data class Failed(val code: String) : ConnectionState
}

class ConnectionMachine(private val candidates: List<Candidate>) {
    var state: ConnectionState = ConnectionState.Idle
        private set
    private var cursor = 0
    private var networkInvalidated = false
    private val eligible = candidates.filter { it.verified && it.capacityAvailable && it.id.isNotBlank() }

    fun start(): ConnectionState {
        if (networkInvalidated) {
            state = ConnectionState.Failed("NETWORK_CHANGED_RESELECT_REQUIRED")
            return state
        }
        cursor = 0
        state = if (eligible.isEmpty()) ConnectionState.Failed("NO_VERIFIED_ROUTE")
                else ConnectionState.Dialing(eligible[0].id)
        return state
    }

    fun handshakeSucceeded(): ConnectionState {
        val old = state
        if (old is ConnectionState.Dialing && !networkInvalidated)
            state = ConnectionState.TestingTraffic(old.routeId)
        return state
    }

    fun trafficVerified(): ConnectionState {
        val old = state
        if (old is ConnectionState.TestingTraffic && !networkInvalidated)
            state = ConnectionState.Connected(old.routeId)
        return state
    }

    private fun nextRoute(failureCode: String): ConnectionState {
        cursor++
        state = if (cursor < eligible.size) ConnectionState.Dialing(eligible[cursor].id)
                else ConnectionState.Failed(failureCode)
        return state
    }

    fun attemptFailed(): ConnectionState {
        if (networkInvalidated) return state
        if (state !is ConnectionState.Dialing && state !is ConnectionState.TestingTraffic) return state
        return nextRoute("ALL_ROUTES_FAILED")
    }

    /** When a verified tunnel drops, status must stop saying Connected immediately. */
    fun connectionLost(): ConnectionState {
        if (networkInvalidated) return state
        if (state !is ConnectionState.Connected) return attemptFailed()
        return nextRoute("TUNNEL_LOST")
    }

    /** A new network requires new route health and carrier evidence. */
    fun networkChanged(): ConnectionState {
        networkInvalidated = true
        state = ConnectionState.Failed("NETWORK_CHANGED_RESELECT_REQUIRED")
        return state
    }

    fun disconnect() { state = ConnectionState.Idle }
}
