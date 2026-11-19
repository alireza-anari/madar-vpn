package io.madar.v2

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class LiveSpeed(val downloadMbps: Double = 0.0, val uploadMbps: Double = 0.0)

object VpnStatus {
    private val mutable = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    val state: StateFlow<ConnectionState> = mutable.asStateFlow()

    private val speedValue = MutableStateFlow(LiveSpeed())
    val speed: StateFlow<LiveSpeed> = speedValue.asStateFlow()

    fun update(value: ConnectionState) {
        mutable.value = value
        if (value !is ConnectionState.Connected) speedValue.value = LiveSpeed()
    }
    fun updateSpeed(value: LiveSpeed) {
        if (mutable.value is ConnectionState.Connected)
            speedValue.value = value
    }
}
