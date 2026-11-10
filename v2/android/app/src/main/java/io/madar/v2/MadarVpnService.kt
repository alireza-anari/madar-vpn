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
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
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
            currentCoroutineContext().ensureActive()
            VpnStatus.update(ConnectionState.Dialing("subscription"))
            val origin = BuildConfig.SUBSCRIPTION_API_ORIGIN
            require(origin.startsWith("https://")) { "VPN_SERVICE_NOT_CONFIGURED" }
            val token = SubscriptionTokenStore(this).read()
                ?: throw IllegalStateException("NO_SUBSCRIPTION_TOKEN")
            val result = SubscriptionApi(origin).fetch(token)
            currentCoroutineContext().ensureActive()
            val snapshot = (result as? SubscriptionResult.Available)?.snapshot
                ?: throw IllegalStateException("SUBSCRIPTION_UNAVAILABLE")

            val descriptor = establishTunnel()
                ?: throw IllegalStateException("VPN_PERMISSION_OR_TUN_FAILED")
            tunnel = descriptor
            val native = LibXrayNativeEngine(this)
            engine = native
            var activeIndex = -1
            var lastFailure = "ALL_ROUTES_FAILED"

            suspend fun tryRoute(index: Int): Boolean {
                currentCoroutineContext().ensureActive()
                if (!snapshot.hasUsablePlan(System.currentTimeMillis())) {
                    lastFailure = "SUBSCRIPTION_EXPIRED_OR_EMPTY"
                    return false
                }
                val route = snapshot.routes[index]
                VpnStatus.update(ConnectionState.Dialing(route.id))
                val config = try {
                    XrayConfigBuilder.build(snapshot, route.id, descriptor.fd)
                } catch (_: Exception) {
                    lastFailure = "INVALID_ROUTE_CONFIG"
                    return false
                }
                val started = native.start(descriptor.fd, config)
                currentCoroutineContext().ensureActive()
                if (started !is TunnelEngineOutcome.Started) {
                    lastFailure = "XRAY_START_FAILED"
                    native.stop()
                    return false
                }
                VpnStatus.update(ConnectionState.TestingTraffic(route.id))
                val traffic = native.verifyTraffic()
                currentCoroutineContext().ensureActive()
                if (traffic) {
                    activeIndex = index
                    VpnStatus.update(ConnectionState.Connected(route.id))
                    updateNotification("Connected · " + route.transport.uppercase())
                    return true
                }
                lastFailure = "TUNNELED_TRAFFIC_UNVERIFIED"
                native.stop()
                return false
            }

            var connected = false
            for (index in snapshot.routes.indices) {
                if (tryRoute(index)) {
                    connected = true
                    break
                }
            }
            if (!connected) throw IllegalStateException(lastFailure)

            // Monitor the real data path. On loss, rotate through the other
            // server-verified routes before disconnecting the user.
            while (currentCoroutineContext().isActive) {
                delay(30_000)
                currentCoroutineContext().ensureActive()
                if (native.verifyTraffic()) continue
                native.stop()
                VpnStatus.update(ConnectionState.Failed("TUNNEL_LOST"))
                var recovered = false
                for (offset in 1 until snapshot.routes.size) {
                    val index = (activeIndex + offset) % snapshot.routes.size
                    if (index != activeIndex && tryRoute(index)) {
                        recovered = true
                        break
                    }
                }
                if (!recovered) throw IllegalStateException("TUNNEL_LOST")
            }
        } catch (cancelled: CancellationException) {
            stopTunnelResources()
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
