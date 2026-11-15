package io.madar.v2

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale
import kotlin.math.max

class MainActivity : ComponentActivity() {
    private val vpnConsent = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) startVpnService()
        else VpnStatus.update(ConnectionState.Failed("VPN_PERMISSION_DENIED"))
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MadarHome(::requestVpnConnection, ::disconnectVpn) }
    }
    private fun requestVpnConnection() {
        val consent = VpnService.prepare(this)
        if (consent == null) startVpnService() else vpnConsent.launch(consent)
    }
    private fun startVpnService() {
        val intent = Intent(this, MadarVpnService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent)
        else startService(intent)
    }
    private fun disconnectVpn() {
        startService(Intent(this, MadarVpnService::class.java)
            .setAction(MadarVpnService.ACTION_STOP))
    }
}

private val Navy = Color(0xFF05152B)
private val Panel = Color(0xFF102942)
private val Panel2 = Color(0xFF0A2039)
private val Aqua = Color(0xFF00E0D2)
private val Cyan = Color(0xFF00BEF5)
private val Blue = Color(0xFF276FFF)
private val Muted = Color(0xFF9EB7CC)
private val Green = Color(0xFF31E4A6)
private val White = Color(0xFFF2FAFF)
private val MadarColors = darkColorScheme(
    primary = Aqua, onPrimary = Navy, background = Navy,
    onBackground = White, surface = Panel, onSurface = White,
    surfaceVariant = Panel2, onSurfaceVariant = Muted
)

@Composable
fun MadarHome(onConnect: () -> Unit, onDisconnect: () -> Unit) {
    val context = LocalContext.current
    val tokenStore = remember(context) { SubscriptionTokenStore(context) }
    val prefs = remember(context) {
        context.getSharedPreferences("madar_v2_profile", android.content.Context.MODE_PRIVATE)
    }
    val scope = rememberCoroutineScope()
    var signedIn by remember { mutableStateOf(tokenStore.read() != null) }
    var telegramId by remember { mutableStateOf(prefs.getString("telegram_id", null)) }
    var loginBusy by remember { mutableStateOf(false) }
    var loginError by remember { mutableStateOf<String?>(null) }
    var snapshot by remember { mutableStateOf<SubscriptionSnapshot?>(null) }
    var snapshotError by remember { mutableStateOf<String?>(null) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val vpn by VpnStatus.state.collectAsState()
    val speed by VpnStatus.speed.collectAsState()

    LaunchedEffect(signedIn) {
        if (!signedIn) snapshot = null
        else while (isActive) {
            val result = withContext(Dispatchers.IO) {
                val token = tokenStore.read()
                if (token == null) SubscriptionResult.Unavailable("NO_TOKEN")
                else if (BuildConfig.SUBSCRIPTION_API_ORIGIN.isBlank())
                    SubscriptionResult.Unavailable("NOT_CONFIGURED")
                else SubscriptionApi(BuildConfig.SUBSCRIPTION_API_ORIGIN).fetch(token)
            }
            when (result) {
                is SubscriptionResult.Available -> {
                    snapshot = result.snapshot
                    snapshotError = null
                }
                is SubscriptionResult.Unavailable -> {
                    snapshot = null
                    snapshotError = result.code
                }
            }
            delay(30000)
        }
    }

    val startTelegramLogin: () -> Unit = {
        if (!loginBusy) {
            loginBusy = true
            loginError = null
            scope.launch {
                val api = runCatching {
                    AndroidLoginApi(BuildConfig.SUBSCRIPTION_API_ORIGIN)
                }.getOrNull()
                if (api == null) loginError = "ورود تلگرام هنوز پیکربندی نشده است."
                else when (val start = withContext(Dispatchers.IO) { api.start() }) {
                    is LoginStartResult.Error ->
                        loginError = if (start.code == "not_ready")
                            "ورود تلگرام هنوز در سرور فعال نشده است."
                            else "درخواست ورود انجام نشد. دوباره تلاش کنید."
                    is LoginStartResult.Ready -> {
                        val opened = runCatching {
                            context.startActivity(Intent(Intent.ACTION_VIEW,
                                Uri.parse(start.challenge.url)))
                        }.isSuccess
                        if (!opened) loginError = "لینک ورود را در تلگرام باز کنید."
                        else {
                            while (isActive && System.currentTimeMillis() <
                                start.challenge.expiresAtMs) {
                                delay(2500)
                                when (val finish = withContext(Dispatchers.IO) {
                                    api.complete(start.challenge)
                                }) {
                                    LoginFinishResult.Pending -> Unit
                                    is LoginFinishResult.Authorized -> {
                                        if (tokenStore.save(finish.token)) {
                                            prefs.edit().putString("telegram_id", finish.telegramId)
                                                .apply()
                                            telegramId = finish.telegramId
                                            signedIn = true
                                            tab = 0
                                        } else loginError = "ذخیره امن نشست ممکن نشد."
                                        break
                                    }
                                    is LoginFinishResult.Error -> {
                                        if (finish.code != "NETWORK_ERROR") {
                                            loginError = when (finish.code) {
                                                "subscription_not_ready" ->
                                                    "اشتراک فعال و مسیر آماده‌ای پیدا نشد."
                                                "expired" -> "مهلت ورود تمام شد."
                                                else -> "ورود تأیید نشد. دوباره تلاش کنید."
                                            }
                                            break
                                        }
                                    }
                                }
                            }
                            if (!signedIn && loginError == null)
                                loginError = "مهلت ورود تمام شد. دوباره تلاش کنید."
                        }
                    }
                }
                loginBusy = false
            }
        }
    }
    val openSupport: () -> Unit = {
        runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW,
                Uri.parse("https://t.me/Madar_vpn_bot")))
        }
    }

    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        MaterialTheme(colorScheme = MadarColors) {
            if (!signedIn) LoginPage(loginBusy, loginError, startTelegramLogin)
            else Scaffold(containerColor = Navy, bottomBar = {
                NavigationBar(containerColor = Panel2) {
                    listOf("اتصال", "مصرف", "پروفایل").forEachIndexed { index, name ->
                        NavigationBarItem(
                            selected = tab == index,
                            onClick = { tab = index },
                            icon = { Text(listOf("⌂", "▥", "◯")[index], fontSize = 24.sp) },
                            label = { Text(name) },
                            alwaysShowLabel = true
                        )
                    }
                }
            }) { insets ->
                Column(
                    Modifier.fillMaxSize()
                        .background(Brush.verticalGradient(listOf(Navy, Color(0xFF061D36), Navy)))
                        .padding(insets)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 18.dp, vertical = 18.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp)
                ) {
                    Header()
                    when (tab) {
                        0 -> ConnectionPage(vpn, speed, snapshot, snapshotError,
                            onConnect, onDisconnect)
                        1 -> UsagePage(snapshot, snapshotError)
                        else -> ProfilePage(telegramId, snapshot, openSupport) {
                            onDisconnect()
                            tokenStore.clear()
                            prefs.edit().clear().apply()
                            telegramId = null
                            snapshot = null
                            signedIn = false
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Header() {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween) {
        Row(verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            BrandMark(42.dp)
            Text("مدار VPN", fontSize = 21.sp, color = White, fontWeight = FontWeight.Bold)
        }
        Text("●  مشترک مدار", color = Green, fontSize = 11.sp)
    }
}

/** Vector brand treatment based on the approved turquoise shield/lock logo. */
@Composable
private fun BrandMark(diameter: Dp) {
    Box(Modifier.size(diameter).background(Panel2, CircleShape)
        .border(2.dp, Brush.linearGradient(listOf(Cyan, Aqua)), CircleShape),
        contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize().padding(diameter * .20f)) {
            val w = size.width
            val h = size.height
            val shield = Path().apply {
                moveTo(w * .5f, h * .06f)
                lineTo(w * .9f, h * .26f)
                lineTo(w * .86f, h * .65f)
                quadraticTo(w * .77f, h * .86f, w * .5f, h * .98f)
                quadraticTo(w * .23f, h * .86f, w * .14f, h * .65f)
                lineTo(w * .14f, h * .26f)
                close()
            }
            drawPath(shield, Brush.linearGradient(listOf(Cyan, Aqua)),
                style = Stroke(width = w * .075f, cap = StrokeCap.Round))
            drawLine(Cyan, Offset(-w * .15f, h * .4f), Offset(w * .26f, h * .4f),
                strokeWidth = w * .065f, cap = StrokeCap.Round)
            drawLine(Aqua, Offset(-w * .06f, h * .59f), Offset(w * .27f, h * .59f),
                strokeWidth = w * .065f, cap = StrokeCap.Round)
            drawRoundRect(Aqua, topLeft = Offset(w * .41f, h * .46f),
                size = Size(w * .20f, h * .27f))
            drawArc(Aqua, startAngle = 180f, sweepAngle = 180f,
                useCenter = false, topLeft = Offset(w * .43f, h * .30f),
                size = Size(w * .16f, h * .32f),
                style = Stroke(width = w * .06f, cap = StrokeCap.Round))
        }
    }
}

@Composable
private fun PanelCard(content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(22.dp),
        color = Panel, border = BorderStroke(1.dp, Color(0xFF23527B))) {
        Column(Modifier.padding(17.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content)
    }
}

@Composable
private fun LoginPage(busy: Boolean, error: String?, onLogin: () -> Unit) {
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(
        listOf(Color(0xFF041325), Color(0xFF083153), Navy))).padding(24.dp),
        contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            BrandMark(138.dp)
            Text("مدار VPN", style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold, color = White)
            Text("دسترسی امن، سریع و پایدار", color = Muted)
            Spacer(Modifier.height(18.dp))
            PanelCard {
                Text("ورود به حساب کاربری", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text("با همان حساب تلگرامی وارد شوید که اشتراک مدار را با آن فعال کرده‌اید.",
                    color = Muted, fontSize = 13.sp, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth())
                Button(onClick = onLogin, enabled = !busy,
                    modifier = Modifier.fillMaxWidth().height(54.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Cyan, contentColor = Navy),
                    shape = RoundedCornerShape(16.dp)) {
                    Text(if (busy) "در انتظار تأیید تلگرام…" else "✈  ورود با تلگرام",
                        fontWeight = FontWeight.Bold, fontSize = 17.sp)
                }
                if (busy) CircularProgressIndicator(color = Aqua,
                    modifier = Modifier.align(Alignment.CenterHorizontally).size(25.dp))
                error?.let { Text(it, color = Color(0xFFFFB3B3), fontSize = 13.sp) }
            }
            Text("بدون کپی کانفیگ، بدون انتخاب سرور", color = Muted, fontSize = 12.sp)
        }
    }
}

@Composable
private fun ConnectionPage(state: ConnectionState, speed: LiveSpeed,
    subscription: SubscriptionSnapshot?, error: String?,
    onConnect: () -> Unit, onDisconnect: () -> Unit) {
    val connected = state is ConnectionState.Connected
    val busy = state is ConnectionState.Dialing || state is ConnectionState.TestingTraffic
    val canConnect = subscription?.hasUsablePlan(System.currentTimeMillis()) == true
    Text("اتصال با یک لمس", fontSize = 25.sp, fontWeight = FontWeight.Bold)
    Text("مدار به‌صورت خودکار مسیر مناسب را انتخاب می‌کند.", color = Muted, fontSize = 13.sp)
    Spacer(Modifier.height(8.dp))
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Box(Modifier.size(222.dp)
            .border(8.dp, Brush.sweepGradient(listOf(Cyan, Blue, Aqua, Cyan)), CircleShape)
            .background(Brush.radialGradient(listOf(Color(0xFF0B426A), Panel2)), CircleShape)
            .clickable(enabled = !busy && (connected || canConnect)) {
                if (connected) onDisconnect() else onConnect()
            }, contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PowerGlyph(if (connected) Green else Aqua)
                Text(if (connected) "قطع اتصال" else if (busy) "در حال اتصال"
                    else "اتصال", fontSize = 21.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
    Text(when (state) {
        ConnectionState.Idle -> if (canConnect) "●  آماده اتصال" else "●  اشتراک در دسترس نیست"
        is ConnectionState.Dialing -> "●  در حال برقراری مسیر امن"
        is ConnectionState.TestingTraffic -> "●  بررسی عبور واقعی داده"
        is ConnectionState.Connected -> "●  متصل و تأییدشده"
        is ConnectionState.Failed -> "●  اتصال برقرار نشد؛ دوباره تلاش کنید"
    }, color = if (connected || (state == ConnectionState.Idle && canConnect)) Green else Muted,
        textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.weight(1f)) { MetricCard("↓  سرعت دانلود", speed.downloadMbps) }
        Box(Modifier.weight(1f)) { MetricCard("↑  سرعت آپلود", speed.uploadMbps) }
    }
    PanelCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("مسیر هوشمند", fontWeight = FontWeight.SemiBold)
            Text("⚡ خودکار", color = Aqua)
        }
        Text("بدون نیاز به انتخاب سرور یا وارد کردن لینک", color = Muted, fontSize = 12.sp)
    }
    PanelCard {
        Text("محافظت از کل دستگاه", fontWeight = FontWeight.Bold)
        Text(if (connected) "تونل دستگاه فعال است."
            else "با تأیید اجازه VPN اندروید، تونل سراسری فعال می‌شود.",
            color = Muted, fontSize = 12.sp)
    }
    if (!canConnect && !connected) Text(
        if (error == "SUBSCRIPTION_UNAVAILABLE") "اشتراک فعال ندارید."
        else "در حال بررسی اشتراک و مسیرهای تأییدشده…",
        color = Muted, fontSize = 12.sp)
}

@Composable
private fun PowerGlyph(tint: Color) {
    Canvas(Modifier.size(65.dp)) {
        drawArc(tint, startAngle = 135f, sweepAngle = 270f,
            useCenter = false, style = Stroke(width = 6.dp.toPx(), cap = StrokeCap.Round))
        drawLine(tint, Offset(center.x, 0f), Offset(center.x, center.y * .91f),
            strokeWidth = 6.dp.toPx(), cap = StrokeCap.Round)
    }
}

@Composable
private fun MetricCard(label: String, value: Double) {
    Surface(shape = RoundedCornerShape(18.dp), color = Panel,
        border = BorderStroke(1.dp, Color(0xFF24466B))) {
        Column(Modifier.fillMaxWidth().padding(15.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Text(label, color = Muted, fontSize = 12.sp)
            Text(String.format(Locale.US, "%.1f Mbps", value),
                color = Aqua, fontWeight = FontWeight.Bold, fontSize = 19.sp)
        }
    }
}

@Composable
private fun UsagePage(subscription: SubscriptionSnapshot?, error: String?) {
    Text("اشتراک و مصرف", fontSize = 25.sp, fontWeight = FontWeight.Bold)
    if (subscription == null) {
        PanelCard {
            Text("اطلاعات اشتراک", fontWeight = FontWeight.Bold)
            Text(if (error == "SUBSCRIPTION_UNAVAILABLE")
                "اشتراک فعالی برای این حساب پیدا نشد."
                else "در حال دریافت اطلاعات ثبت‌شده در سرور مدار…", color = Muted)
        }
        return
    }
    val quota = subscription.quotaBytes.coerceAtLeast(1)
    val used = subscription.usedBytes.coerceIn(0L, quota)
    val remaining = max(0L, quota - used)
    val progress = (used.toFloat() / quota).coerceIn(0f, 1f)
    val days = max(0L, (subscription.expiresAtMs -
        System.currentTimeMillis() + 86399999L) / 86400000L)
    PanelCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("اشتراک فعال", fontWeight = FontWeight.Bold, color = Green)
            Text("✦ مدار VPN", color = Aqua)
        }
        Text("اطلاعات به‌روز اشتراک شما", color = Muted, fontSize = 12.sp)
    }
    PanelCard {
        Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.size(172.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(progress = { progress },
                    modifier = Modifier.fillMaxSize(), color = Aqua,
                    trackColor = Color(0xFF22425E), strokeWidth = 13.dp)
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(String.format(Locale.US, "%.0f%%", progress * 100),
                        fontSize = 35.sp, fontWeight = FontWeight.Bold)
                    Text("مصرف‌شده", color = Muted, fontSize = 12.sp)
                }
            }
        }
        Text("حجم باقی‌مانده: " + gb(remaining) + " گیگابایت",
            color = Green, fontWeight = FontWeight.Bold)
        InfoLine("حجم کل اشتراک", gb(subscription.quotaBytes) + " گیگابایت")
        InfoLine("حجم مصرف‌شده", gb(used) + " گیگابایت")
        InfoLine("زمان باقی‌مانده", days.toString() + " روز")
    }
    Text("مقادیر مصرف و زمان فقط از سرور مدار دریافت می‌شوند.",
        color = Muted, fontSize = 12.sp)
}

private fun gb(value: Long): String =
    String.format(Locale.US, "%.1f", value / 1073741824.0)

@Composable
private fun InfoLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Muted, fontSize = 13.sp)
        Text(value, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
    }
}

@Composable
private fun ProfilePage(telegramId: String?, subscription: SubscriptionSnapshot?,
    onSupport: () -> Unit, onLogout: () -> Unit) {
    var guide by remember { mutableStateOf(false) }
    var faq by remember { mutableStateOf(false) }
    Text("پروفایل و پشتیبانی", fontSize = 25.sp, fontWeight = FontWeight.Bold)
    PanelCard {
        Text("◯  حساب تلگرام", fontWeight = FontWeight.Bold, fontSize = 18.sp)
        Text(telegramId?.let { "شناسه تلگرام: $it" } ?: "حساب تأییدشده",
            color = Muted, fontSize = 12.sp)
        Text("●  ورود تأییدشده", color = Green, fontSize = 12.sp)
    }
    PanelCard {
        Text("✦  اشتراک من", fontWeight = FontWeight.Bold)
        Text(if (subscription?.hasUsablePlan(System.currentTimeMillis()) == true)
            "فعال · " + gb(max(0L, subscription.quotaBytes - subscription.usedBytes)) +
                " گیگابایت باقی‌مانده" else "در حال بررسی اشتراک", color = Green)
    }
    ActionRow("☏", "پشتیبانی آنلاین", "ارتباط با ربات مدار", onSupport)
    ActionRow("?", "سؤالات متداول", "پاسخ به پرسش‌های رایج", { faq = !faq })
    if (faq) PanelCard {
        Text("آیا باید سرور انتخاب کنم؟", fontWeight = FontWeight.Bold)
        Text("خیر، مدار مسیرهای تأییدشده را خودکار امتحان می‌کند.", color = Muted)
        Text("آیا تمام گوشی تونل می‌شود؟", fontWeight = FontWeight.Bold)
        Text("پس از اجازه اندروید و تأیید اتصال، تونل سراسری فعال است.", color = Muted)
    }
    ActionRow("▤", "راهنمای استفاده", "آموزش ورود و اتصال", { guide = !guide })
    if (guide) PanelCard {
        Text("۱. با حساب تلگرام خود وارد شوید.")
        Text("۲. اجازه اتصال VPN را تأیید کنید.")
        Text("۳. یک بار دکمه اتصال را لمس کنید.")
        Text("۴. حجم و زمان باقی‌مانده را در تب مصرف ببینید.")
    }
    ActionRow("ⓘ", "درباره مدار", "VPN اختصاصی مشترکان مدار", {})
    ActionRow("⇥", "خروج از حساب", "پاک‌کردن نشست از دستگاه", onLogout)
}

@Composable
private fun ActionRow(symbol: String, title: String,
    subtitle: String, onClick: () -> Unit) {
    Surface(Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(18.dp), color = Panel,
        border = BorderStroke(1.dp, Color(0xFF24466B))) {
        Row(Modifier.fillMaxWidth().padding(15.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text(symbol, fontSize = 24.sp, color = Aqua)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(title, fontWeight = FontWeight.SemiBold)
                Text(subtitle, color = Muted, fontSize = 12.sp)
            }
            Text("‹", fontSize = 24.sp, color = Muted)
        }
    }
}
