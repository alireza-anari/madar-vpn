package io.madar.v2

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MadarVpnService : VpnService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var connectJob: Job? = null
    @Volatile private var tunnel: ParcelFileDescriptor? = null
    @Volatile private var engine: NativeTunnelEngine? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopTunnel()
            stopSelf(startId)
            return START_NOT_STICKY
        }
        startAsForeground("Preparing secure connection")
        if (connectJob?.isActive != true) connectJob = scope.launch { connect() }
        return START_NOT_STICKY
    }

    private suspend fun connect() {
        try {
            VpnStatus.update(ConnectionState.Failed("SUBSCRIPTION_CHECKING"))
            val origin = BuildConfig.SUBSCRIPTION_API_ORIGIN
            require(origin.startsWith("https://")) { "VPN_SERVICE_NOT_CONFIGURED" }
            val token = SubscriptionTokenStore(this).read()
                ?: throw IllegalStateException("NO_SUBSCRIPTION_TOKEN")
            val result = SubscriptionApi(origin).fetch(token)
            val snapshot = (result as? SubscriptionResult.Available)?.snapshot
                ?: throw IllegalStateException("SUBSCRIPTION_UNAVAILABLE")
            val descriptor = establishTunnel()
                ?: throw IllegalStateException("VPN_PERMISSION_OR_TUN_FAILED")
            tunnel = descriptor
            val native = LibXrayNativeEngine(this)
            engine = native

            var connected = false
            var lastFailure = "ALL_ROUTES_FAILED"
            for (route in snapshot.routes) {
                if (!snapshot.hasUsablePlan(System.currentTimeMillis())) {
                    lastFailure = "SUBSCRIPTION_EXPIRED_OR_EMPTY"
                    break
                }
                VpnStatus.update(ConnectionState.Dialing(route.id))
                val config = XrayConfigBuilder.build(snapshot, route.id, descriptor.fd)
                val started = native.start(descriptor.fd, config)
                if (started !is TunnelEngineOutcome.Started) {
                    lastFailure = "XRAY_START_FAILED"
                    native.stop()
                    continue
                }
                VpnStatus.update(ConnectionState.TestingTraffic(route.id))
                val traffic = withContext(Dispatchers.IO) { native.verifyTraffic() }
                if (traffic) {
                    VpnStatus.update(ConnectionState.Connected(route.id))
                    updateNotification("Connected · " + route.transport.uppercase())
                    connected = true
                    break
                }
                lastFailure = "TUNNELED_TRAFFIC_UNVERIFIED"
                native.stop()
            }
            if (!connected) throw IllegalStateException(lastFailure)
            while (connectJob?.isActive == true) {
                delay(30_000)
                if (engine?.verifyTraffic() != true) {
                    VpnStatus.update(ConnectionState.Failed("TUNNEL_LOST"))
                    throw IllegalStateException("TUNNEL_LOST")
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val code = error.message?.takeIf { it.matches(Regex("[A-Z0-9_]{3,64}")) }
                ?: "CONNECTION_FAILED"
            VpnStatus.update(ConnectionState.Failed(code))
            updateNotification("Connection failed")
            stopTunnelResources()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun establishTunnel(): ParcelFileDescriptor? {
        if (prepare(this) != null) return null
        return Builder()
            .setSession("Madar VPN")
            .setMtu(1500)
            .setBlocking(true)
            .addAddress("10.111.0.1", 30)
            .addRoute("0.0.0.0", 0)
            .addDnsServer("1.1.1.1")
            .addAddress("fd00:2026:11::1", 126)
            .addRoute("::", 0)
            .addDnsServer("2606:4700:4700::1111")
            .establish()
    }

    private fun stopTunnelResources() {
        runCatching { engine?.stop() }
        engine = null
        runCatching { tunnel?.close() }
        tunnel = null
    }

    private fun stopTunnel() {
        connectJob?.cancel()
        connectJob = null
        stopTunnelResources()
        VpnStatus.update(ConnectionState.Idle)
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onRevoke() {
        stopTunnel()
        super.onRevoke()
        stopSelf()
    }

    override fun onDestroy() {
        stopTunnel()
        scope.cancel()
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Madar VPN", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "VPN connection status" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun notification(text: String): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
        return builder.setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("Madar VPN")
            .setContentText(text)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()
    }

    private fun startAsForeground(text: String) {
        val note = notification(text)
        if (Build.VERSION.SDK_INT >= 34)
            startForeground(NOTIFICATION_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED)
        else startForeground(NOTIFICATION_ID, note)
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    companion object {
        const val ACTION_STOP = "io.madar.v2.action.STOP_VPN"
        private const val CHANNEL_ID = "madar-vpn-status"
        private const val NOTIFICATION_ID = 2201
    }
}
