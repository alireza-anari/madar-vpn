package io.madar.v2

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SubscriptionClientTest {
    @Test fun tokensRequireExactOpaqueFormat() {
        assertFalse(SubscriptionTokenFormat.isValid(null))
        assertFalse(SubscriptionTokenFormat.isValid("https://example.com/?token=abc"))
        assertFalse(SubscriptionTokenFormat.isValid("A".repeat(42)))
        assertTrue(SubscriptionTokenFormat.isValid("A".repeat(43)))
    }

    @Test fun noConnectionUsableForExpiredOrExhaustedSubscription() {
        val route=VerifiedRoute("r","wss","vpn.example.com",443,"vpn.example.com",
            "/proxy",null,null)
        val base=SubscriptionSnapshot("sub",10_000,100,50,
            "123e4567-e89b-42d3-a456-426614174000",listOf(route))
        assertTrue(base.hasUsablePlan(9_000))
        assertFalse(base.hasUsablePlan(10_000))
        assertFalse(base.copy(usedBytes=100).hasUsablePlan(9_000))
        assertFalse(base.copy(routes=emptyList()).hasUsablePlan(9_000))
    }

    @Test fun APIOriginMustUseHttpsAndCannotContainQueryOrCredentials() {
        try { SubscriptionApi("http://example.com"); throw AssertionError("not rejected") }
        catch (_: IllegalArgumentException) {}
        try { SubscriptionApi("https://user:pass@example.com/"); throw AssertionError("not rejected") }
        catch (_: IllegalArgumentException) {}
        try { SubscriptionApi("https://example.com/?token=secret"); throw AssertionError("not rejected") }
        catch (_: IllegalArgumentException) {}
        SubscriptionApi("https://example.com")
    }
}
