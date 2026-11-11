package io.madar.v2

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CarrierRoutesTest {
    private val mci = VerifiedRoute("r443", "reality", "vpn.example.com",
        443, "www.cloudflare.com", null, "A".repeat(43), "abcd", "mci")
    private val irancell = VerifiedRoute("r8443", "reality", "vpn.example.com",
        8443, "www.cloudflare.com", null, "A".repeat(43), "abcd", "irancell")
    private val wss = VerifiedRoute("rws", "wss", "vpn.example.com",
        443, "vpn.example.com", "/madar-ws", null, null, "mci")
    private val snapshot = SubscriptionSnapshot("sub", Long.MAX_VALUE, 1024L, 0L,
        "123e4567-e89b-42d3-a456-426614174000", listOf(wss, irancell, mci))

    @Test fun explicitlySelectedOperatorCannotSilentlySwitchToOtherCarrier() {
        assertEquals(listOf(mci), CarrierRoutes.select(snapshot, CarrierOperator.MCI))
        assertEquals(listOf(irancell), CarrierRoutes.select(snapshot, CarrierOperator.IRANCELL))
        assertEquals(emptyList<VerifiedRoute>(), CarrierRoutes.select(
            snapshot.copy(routes=listOf(irancell)), CarrierOperator.MCI))
    }

    @Test fun linkImportsOnlyFromConfiguredHttpsOrigin() {
        val token="A".repeat(43)
        val origin="https://madar-v2-staging.example.com"
        assertEquals(token, SubscriptionTokenFormat.fromInput("$origin/s/$token", origin))
        assertEquals(token, SubscriptionTokenFormat.fromInput(token, origin))
        assertNull(SubscriptionTokenFormat.fromInput("http://madar-v2-staging.example.com/s/$token", origin))
        assertNull(SubscriptionTokenFormat.fromInput("https://foreign.example.com/s/$token", origin))
        assertNull(SubscriptionTokenFormat.fromInput("$origin/s/$token?leak=yes", origin))
        assertNull(SubscriptionTokenFormat.fromInput("$origin/s/$token/extra", origin))
        assertNull(SubscriptionTokenFormat.fromInput("https://user:pass@madar-v2-staging.example.com/s/$token", origin))
        assertNull(SubscriptionTokenFormat.fromInput("$origin/s/$token#fragment", origin))
        assertTrue(CarrierOperator.fromCode("mci") == CarrierOperator.MCI)
        assertNull(CarrierOperator.fromCode("unknown"))
    }
}
