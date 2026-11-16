package io.madar.v2

import androidx.compose.ui.test.assertExists
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
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
        compose.onNodeWithText("مدار VPN").assertExists()
        compose.onNodeWithContentDescription("لوگوی مدار").assertExists()
        compose.onNodeWithText("ورود با تلگرام", substring = true).assertExists()
        compose.onNodeWithText("بدون کپی کانفیگ، بدون انتخاب سرور").assertExists()
    }

    @Test
    fun loginScreenDoesNotExposeManualConfigurationOrCarrierFields() {
        compose.onNodeWithText("وارد کردن لینک", substring = true).assertDoesNotExist()
        compose.onNodeWithText("انتخاب اپراتور", substring = true).assertDoesNotExist()
        compose.onNodeWithText("انتخاب سرور", substring = true).assertDoesNotExist()
    }
}
