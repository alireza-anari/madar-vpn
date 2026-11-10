package io.madar.v2

/** Deterministic connection lifecycle. Never infer Connected from a socket open. */
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
    private val eligible = candidates.filter { it.verified && it.capacityAvailable && it.id.isNotBlank() }

    fun start(): ConnectionState {
        cursor = 0
        state = if (eligible.isEmpty()) ConnectionState.Failed("NO_VERIFIED_ROUTE")
                else ConnectionState.Dialing(eligible[0].id)
        return state
    }

    fun handshakeSucceeded(): ConnectionState {
        val old = state
        if (old is ConnectionState.Dialing)
            state = ConnectionState.TestingTraffic(old.routeId)
        return state
    }

    fun trafficVerified(): ConnectionState {
        val old = state
        if (old is ConnectionState.TestingTraffic)
            state = ConnectionState.Connected(old.routeId)
        return state
    }

    fun attemptFailed(): ConnectionState {
        if (state !is ConnectionState.Dialing && state !is ConnectionState.TestingTraffic) return state
        cursor++
        state = if (cursor < eligible.size) ConnectionState.Dialing(eligible[cursor].id)
                else ConnectionState.Failed("ALL_ROUTES_FAILED")
        return state
    }

    fun disconnect() { state = ConnectionState.Idle }
}
