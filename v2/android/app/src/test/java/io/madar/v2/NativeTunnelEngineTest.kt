package io.madar.v2

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class NativeTunnelEngineTest {
    private val route="route-1"

    @Test fun noNativeEngineDoesNotClaimConnectedOrStealTraffic() {
        val coordinator=SafeTunnelCoordinator(UnavailableNativeEngine)
        assertFalse(UnavailableNativeEngine.available())
        assertEquals(ConnectionState.Failed("NATIVE_ENGINE_NOT_READY"),
            coordinator.launch(19,"{}",route))
        assertEquals(ConnectionState.Failed("NATIVE_ENGINE_NOT_READY"),coordinator.verify())
        coordinator.stop()
        assertEquals(ConnectionState.Idle,coordinator.state)
    }

    @Test fun onlySuccessfulTunnelTrafficMovesToConnected() {
        val engine=FakeEngine()
        val coordinator=SafeTunnelCoordinator(engine)
        assertEquals(ConnectionState.TestingTraffic(route),
            coordinator.launch(42,"{}",route))
        assertEquals(ConnectionState.Failed("TUNNELED_TRAFFIC_UNVERIFIED"),
            coordinator.verify())
        assertEquals(ConnectionState.TestingTraffic(route),
            coordinator.launch(42,"{}",route))
        engine.traffic=true
        assertEquals(ConnectionState.Connected(route),coordinator.verify())
        coordinator.stop()
        assertEquals(ConnectionState.Idle,coordinator.state)
    }

    @Test fun launchRejectsInvalidTUNDescriptor() {
        val coordinator=SafeTunnelCoordinator(FakeEngine())
        assertEquals(ConnectionState.Failed("NATIVE_ENGINE_NOT_READY"),
            coordinator.launch(-1,"{}",route))
    }

    class FakeEngine : NativeTunnelEngine {
        var traffic=false
        override fun available() = true
        override fun start(tunFd: Int, configJson: String) = TunnelEngineOutcome.Started
        override fun verifyTraffic() = traffic
        override fun stop() {}
    }
}
