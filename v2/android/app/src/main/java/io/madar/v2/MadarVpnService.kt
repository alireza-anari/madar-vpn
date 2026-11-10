package io.madar.v2

import android.content.Intent
import android.net.VpnService

/** Android system VPN boundary. No permission prompts or TUN are started in
 * the preview build; a production adapter and actual TUN forwarding must be
 * integrated before enabling any connection action in the UI.
 */
class MadarVpnService : VpnService() {
    private val coordinator = SafeTunnelCoordinator(UnavailableNativeEngine)

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // No native engine: deliberately do not call Builder.establish(), which
        // would hijack user traffic and make the network appear broken.
        if (!UnavailableNativeEngine.available()) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        stopSelf(startId)
        return START_NOT_STICKY
    }

    override fun onRevoke() {
        coordinator.stop()
        super.onRevoke()
    }

    override fun onDestroy() {
        coordinator.stop()
        super.onDestroy()
    }
}
