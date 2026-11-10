package io.madar.v2

import androidx.test.ext.junit.runners.AndroidJUnit4
import libXray.LibXray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LibXrayRuntimeSmokeTest {
    private fun invoke(method: String, payload: JSONObject? = null): JSONObject {
        val request = JSONObject().put("apiVersion", 3).put("method", method)
        if (payload != null) request.put("payload", payload)
        return JSONObject(LibXray.invoke(request.toString()))
    }

    @Test
    fun bundledNativeXrayLoadsStartsAndStops() {
        val version = invoke("xrayVersion")
        assertTrue(version.optString("error"), version.optBoolean("success"))
        assertTrue(version.optJSONObject("data")?.optString("version").orEmpty().isNotBlank())

        val config = JSONObject()
            .put("log", JSONObject().put("loglevel", "warning"))
            .put("inbounds", org.json.JSONArray())
            .put("outbounds", org.json.JSONArray().put(
                JSONObject().put("tag", "direct").put("protocol", "freedom")
            ))
        val started = invoke("runXray", JSONObject().put("xrayJson", config.toString()))
        assertTrue(started.optString("error"), started.optBoolean("success"))
        try {
            val state = invoke("getXrayState")
            assertTrue(state.optBoolean("success"))
            assertTrue(state.optJSONObject("data")?.optBoolean("running") == true)
        } finally {
            val stopped = invoke("stopXray")
            assertTrue(stopped.optString("error"), stopped.optBoolean("success"))
        }
        val stateAfterStop = invoke("getXrayState")
        assertTrue(stateAfterStop.optBoolean("success"))
        assertFalse(stateAfterStop.optJSONObject("data")?.optBoolean("running") == true)
    }
}
