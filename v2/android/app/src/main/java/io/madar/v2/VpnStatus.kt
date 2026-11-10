package io.madar.v2

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object VpnStatus {
    private val mutable = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    val state: StateFlow<ConnectionState> = mutable.asStateFlow()
    fun update(value: ConnectionState) { mutable.value = value }
}
