package io.madar.v2

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionMachineTest {
    @Test fun requiresTrafficProbeBeforeConnected() {
        val machine = ConnectionMachine(listOf(Candidate("reality-1", true, true)))
        assertEquals(ConnectionState.Dialing("reality-1"), machine.start())
        assertEquals(ConnectionState.TestingTraffic("reality-1"), machine.handshakeSucceeded())
        assertEquals(ConnectionState.Connected("reality-1"), machine.trafficVerified())
    }

    @Test fun fallsBackAndRejectsExhaustedRoutes() {
        val machine = ConnectionMachine(listOf(
            Candidate("unverified", false, true),
            Candidate("first", true, true),
            Candidate("second", true, true),
            Candidate("exhausted", true, false)
        ))
        assertEquals(ConnectionState.Dialing("first"), machine.start())
        assertEquals(ConnectionState.Dialing("second"), machine.attemptFailed())
        assertEquals(ConnectionState.Failed("ALL_ROUTES_FAILED"), machine.attemptFailed())
    }

    @Test fun neverClaimsConnectionWithoutVerifiedCandidates() {
        val machine = ConnectionMachine(listOf(Candidate("route", false, true)))
        assertTrue(machine.start() is ConnectionState.Failed)
        assertTrue(machine.trafficVerified() is ConnectionState.Failed)
    }
}
