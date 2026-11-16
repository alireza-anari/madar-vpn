package io.madar.v2

import android.security.NetworkSecurityPolicy
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onAllNodesWithText
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import androidx.test.ext.junit.runners.AndroidJUnit4

@RunWith(AndroidJUnit4::class)
class MadarLoginScreenTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun firstScreenUsesMadarBrandAndTelegramLogin() {
        compose.onNodeWithText("مدار VPN").fetchSemanticsNode()
        compose.onNodeWithContentDescription("لوگوی مدار").fetchSemanticsNode()
        compose.onNodeWithText("ورود با تلگرام", substring = true).fetchSemanticsNode()
        compose.onNodeWithText("بدون کپی کانفیگ، بدون انتخاب سرور").fetchSemanticsNode()
    }

    @Test
    fun cleartextIsAllowedOnlyForLocalXrayMetrics() {
        val policy = NetworkSecurityPolicy.getInstance()
        assertTrue(policy.isCleartextTrafficPermitted("127.0.0.1"))
        assertTrue(policy.isCleartextTrafficPermitted("localhost"))
        assertFalse(policy.isCleartextTrafficPermitted("example.com"))
    }

    @Test
    fun loginScreenDoesNotExposeManualConfigurationOrCarrierFields() {
        assertTrue(compose.onAllNodesWithText("وارد کردن لینک", substring = true).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodesWithText("انتخاب اپراتور", substring = true).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodesWithText("انتخاب سرور").fetchSemanticsNodes().isEmpty())
    }
}
