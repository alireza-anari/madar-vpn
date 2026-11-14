package io.madar.v2

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionMachineTest {
    @Test fun requiresTrafficProbeBeforeConnected() {
        val machine = ConnectionMachine(listOf(Candidate("reality-1", true, true)))
        assertEquals(ConnectionState.Dialing("reality-1"), machine.start())
        assertEquals(ConnectionState.Dialing("reality-1"), machine.trafficVerified())
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

    @Test fun tunnelLossImmediatelyTriggersFailoverAndReverification() {
        val machine = ConnectionMachine(listOf(
            Candidate("a",true,true),Candidate("b",true,true)
        ))
        machine.start()
        machine.handshakeSucceeded()
        machine.trafficVerified()
        assertEquals(ConnectionState.Dialing("b"),machine.connectionLost())
        assertEquals(ConnectionState.Dialing("b"),machine.trafficVerified())
        assertEquals(ConnectionState.TestingTraffic("b"),machine.handshakeSucceeded())
        assertEquals(ConnectionState.Connected("b"),machine.trafficVerified())
        assertEquals(ConnectionState.Failed("TUNNEL_LOST"),machine.connectionLost())
    }

    @Test fun networkChangeInvalidatesCachedCandidateList() {
        val machine=ConnectionMachine(listOf(Candidate("old-wifi",true,true)))
        machine.start()
        machine.handshakeSucceeded()
        assertEquals(ConnectionState.Failed("NETWORK_CHANGED_RESELECT_REQUIRED"),machine.networkChanged())
        assertEquals(ConnectionState.Failed("NETWORK_CHANGED_RESELECT_REQUIRED"),machine.trafficVerified())
        assertEquals(ConnectionState.Failed("NETWORK_CHANGED_RESELECT_REQUIRED"),machine.start())
    }
}
