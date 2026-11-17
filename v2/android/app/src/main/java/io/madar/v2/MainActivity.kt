package io.madar.v2

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.graphics.Color as AndroidColor
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.DataUsage
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Logout
import androidx.compose.material.icons.outlined.MenuBook
import androidx.compose.material.icons.outlined.PowerSettingsNew
import androidx.compose.material.icons.outlined.Security
import androidx.compose.material.icons.outlined.Send
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.SupportAgent
import androidx.compose.material.icons.outlined.Upload
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale
import kotlin.math.max
import kotlin.math.cos
import kotlin.math.sin

private fun normalizeOtpInput(value: String): String = buildString {
    for (char in value) {
        val digit = when (char) {
            in '۰'..'۹' -> ('0'.code + char.code - '۰'.code).toChar()
            in '٠'..'٩' -> ('0'.code + char.code - '٠'.code).toChar()
            else -> char
        }
        if (digit in '0'..'9' && length < 6) append(digit)
    }
}

class MainActivity : ComponentActivity() {
    private val vpnConsent = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) startVpnService()
        else VpnStatus.update(ConnectionState.Failed("VPN_PERMISSION_DENIED"))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = AndroidColor.TRANSPARENT
        window.navigationBarColor = AndroidColor.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
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

private val Navy = Color(0xFF050C18)
private val Panel = Color(0xFF0D2033)
private val Aqua = Color(0xFF41EBD2)
private val Cyan = Color(0xFF50D5FF)
private val Blue = Color(0xFF5478FF)
private val Muted = Color(0xFF91A9BE)
private val Green = Color(0xFF4BE0B3)
private val White = Color(0xFFF4FAFF)
private val Danger = Color(0xFFFF829B)
private val Violet = Color(0xFF8B70FF)

private val MadarColors = darkColorScheme(
    primary = Aqua, onPrimary = Navy, secondary = Cyan, onSecondary = Navy,
    background = Navy, onBackground = White, surface = Panel, onSurface = White,
    surfaceVariant = Color(0xFF123650), onSurfaceVariant = Muted, error = Danger
)

@Composable
fun MadarHome(onConnect: () -> Unit, onDisconnect: () -> Unit) {
    val context = LocalContext.current
    val tokenStore = remember(context) { SubscriptionTokenStore(context) }
    val scope = rememberCoroutineScope()
    var signedIn by remember { mutableStateOf(tokenStore.read() != null) }
    var loginBusy by remember { mutableStateOf(false) }
    var loginError by remember { mutableStateOf<String?>(null) }
    var loginChallenge by remember { mutableStateOf<TelegramLoginChallenge?>(null) }
    var loginCode by rememberSaveable { mutableStateOf("") }
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
                    if (result.code in setOf(
                            "SUBSCRIPTION_UNAVAILABLE", "SUBSCRIPTION_EXPIRED_OR_EMPTY"
                        ) && VpnStatus.state.value !is ConnectionState.Idle &&
                        VpnStatus.state.value !is ConnectionState.Failed) onDisconnect()
                }
            }
            delay(30000)
        }
    }

    val openTelegramLogin: () -> Unit = {
        val challenge = loginChallenge
        if (challenge != null) {
            val opened = runCatching {
                context.startActivity(Intent(
                    Intent.ACTION_VIEW, Uri.parse(challenge.url)
                ))
            }.isSuccess
            if (!opened) loginError = "تلگرام باز نشد. دوباره تلاش کنید."
        }
    }

    val startTelegramLogin: () -> Unit = {
        if (!loginBusy) {
            loginBusy = true
            loginError = null
            loginChallenge = null
            loginCode = ""
            scope.launch {
                val api = runCatching {
                    AndroidLoginApi(BuildConfig.SUBSCRIPTION_API_ORIGIN)
                }.getOrNull()
                if (api == null) {
                    loginError = "ورود تلگرام هنوز پیکربندی نشده است."
                } else when (val start = withContext(Dispatchers.IO) { api.start() }) {
                    is LoginStartResult.Error -> {
                        loginError = when (start.code) {
                            "not_ready" -> "ورود تلگرام هنوز در سرور فعال نشده است."
                            "rate_limited" -> "درخواست‌های ورود زیاد بوده است. چند دقیقه دیگر تلاش کنید."
                            else -> "درخواست ورود انجام نشد. دوباره تلاش کنید."
                        }
                    }
                    is LoginStartResult.Ready -> {
                        loginChallenge = start.challenge
                        val opened = runCatching {
                            context.startActivity(Intent(
                                Intent.ACTION_VIEW, Uri.parse(start.challenge.url)
                            ))
                        }.isSuccess
                        if (!opened) loginError = "تلگرام باز نشد. دکمه «باز کردن دوباره ربات» را بزنید."
                    }
                }
                loginBusy = false
            }
        }
    }

    val verifyTelegramCode: () -> Unit = {
        val challenge = loginChallenge
        if (!loginBusy && challenge != null && loginCode.length == 6) {
            loginBusy = true
            loginError = null
            scope.launch {
                val api = runCatching {
                    AndroidLoginApi(BuildConfig.SUBSCRIPTION_API_ORIGIN)
                }.getOrNull()
                if (api == null) {
                    loginError = "ورود تلگرام هنوز پیکربندی نشده است."
                } else when (val finish = withContext(Dispatchers.IO) {
                    api.verify(challenge, loginCode)
                }) {
                    LoginFinishResult.Pending -> {
                        loginError = "هنوز کدی دریافت نشده است. در تلگرام عضویت در کانال مدار را تأیید کنید؛ سپس دوباره کد را بررسی کنید."
                    }
                    is LoginFinishResult.Authorized -> {
                        if (tokenStore.save(finish.token)) {
                            signedIn = true
                            tab = 0
                            loginChallenge = null
                            loginCode = ""
                        } else loginError = "ذخیره امن نشست ممکن نشد."
                    }
                    is LoginFinishResult.Error -> {
                        loginError = when (finish.code) {
                            "invalid_code" -> "کد واردشده اشتباه است. دوباره بررسی کنید."
                            "too_many_attempts" -> "تعداد تلاش‌ها بیش از حد مجاز است. درخواست ورود جدید بسازید."
                            "subscription_inactive" -> "برای ورود، اشتراک فعال با حجم باقی‌مانده لازم است."
                            "subscription_not_ready" -> "اشتراک فعال است، اما مسیر یا اطلاعات اتصال هنوز آماده نیست."
                            "expired" -> "مهلت کد تمام شد. درخواست ورود جدید بسازید."
                            "already_used" -> "این درخواست قبلاً استفاده شده است. درخواست ورود جدید بسازید."
                            else -> "تأیید کد انجام نشد. اتصال اینترنت را بررسی و دوباره تلاش کنید."
                        }
                        if (finish.code in setOf(
                                "too_many_attempts", "subscription_inactive",
                                "subscription_not_ready", "expired", "already_used",
                                "invalid_challenge"
                            )) {
                            loginChallenge = null
                            loginCode = ""
                        } else if (finish.code == "invalid_code") {
                            loginCode = ""
                        }
                    }
                }
                loginBusy = false
            }
        }
    }

    val cancelTelegramLogin: () -> Unit = {
        loginChallenge = null
        loginCode = ""
        loginError = null
    }

    val openSupport: () -> Unit = {
        runCatching {
            context.startActivity(Intent(
                Intent.ACTION_VIEW, Uri.parse("https://t.me/Madar_vpn_bot")
            ))
        }
    }

    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        MaterialTheme(colorScheme = MadarColors) {
            CompositionLocalProvider(
                LocalTextStyle provides MaterialTheme.typography.bodyMedium.copy(
                    fontFamily = FontFamily.SansSerif
                )
            ) {
                Box(Modifier.fillMaxSize()) {
                    NeonBackdrop()
                    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                        if (!signedIn) {
                            LoginPage(
                                challenge = loginChallenge,
                                code = loginCode,
                                busy = loginBusy,
                                error = loginError,
                                onStart = startTelegramLogin,
                                onCodeChange = { value ->
                                    loginCode = normalizeOtpInput(value)
                                },
                                onVerify = verifyTelegramCode,
                                onOpenTelegram = openTelegramLogin,
                                onCancel = cancelTelegramLogin
                            )
                        } else {
                            Scaffold(
                                modifier = Modifier.fillMaxSize(),
                                containerColor = Color.Transparent,
                                contentWindowInsets = WindowInsets(0, 0, 0, 0),
                                bottomBar = { MadarBottomBar(tab) { tab = it } }
                            ) { insets ->
                                Column(
                                    Modifier.fillMaxSize()
                                        .padding(insets)
                                        .verticalScroll(rememberScrollState())
                                        .padding(horizontal = 20.dp)
                                        .padding(top = 10.dp, bottom = 18.dp),
                                    verticalArrangement = Arrangement.spacedBy(20.dp)
                                ) {
                                    Header()
                                    Crossfade(
                                        targetState = tab,
                                        animationSpec = tween(360, easing = FastOutSlowInEasing),
                                        label = "madar-main-tabs"
                                    ) { selected ->
                                        when (selected) {
                                            0 -> ConnectionPage(
                                                vpn, speed, snapshot, snapshotError,
                                                onConnect, onDisconnect
                                            )
                                            1 -> UsagePage(snapshot, snapshotError)
                                            else -> ProfilePage(
                                                snapshot, snapshotError, openSupport
                                            ) {
                                                val currentToken = tokenStore.read()
                                                onDisconnect()
                                                tokenStore.clear()
                                                snapshot = null
                                                signedIn = false
                                                if (currentToken != null) scope.launch(Dispatchers.IO) {
                                                    runCatching {
                                                        AndroidLoginApi(BuildConfig.SUBSCRIPTION_API_ORIGIN)
                                                            .logout(currentToken)
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}


@Composable
private fun NeonBackdrop() {
    val transition = rememberInfiniteTransition(label = "madar-aurora")
    val drift by transition.animateFloat(
        initialValue = 0f, targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(12000, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "aurora-drift"
    )
    val shimmer by transition.animateFloat(
        initialValue = 0.12f, targetValue = 0.34f,
        animationSpec = infiniteRepeatable(
            animation = tween(5200, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "aurora-shimmer"
    )
    Canvas(Modifier.fillMaxSize()) {
        drawRect(
            Brush.verticalGradient(
                listOf(Color(0xFF020610), Color(0xFF071321), Color(0xFF050D19))
            )
        )
        val grid = 48.dp.toPx()
        val verticalCount = (size.width / grid).toInt()
        val horizontalCount = (size.height / grid).toInt()
        for (index in 0..verticalCount) {
            val x = index * grid
            drawLine(
                Color(0x0B6AD9F4),
                Offset(x, 0f),
                Offset(x, size.height),
                1.dp.toPx()
            )
        }
        for (index in 0..horizontalCount) {
            val y = index * grid
            drawLine(
                Color(0x096AD9F4),
                Offset(0f, y),
                Offset(size.width, y),
                1.dp.toPx()
            )
        }
        val upper = Offset(size.width * (0.84f - drift * 0.12f), size.height * 0.10f)
        drawCircle(
            brush = Brush.radialGradient(
                listOf(Color(0x553B79FF), Color(0x2437D9F1), Color.Transparent),
                center = upper,
                radius = size.width * 0.84f
            ),
            radius = size.width * 0.84f,
            center = upper
        )
        val lower = Offset(size.width * (0.10f + drift * 0.10f), size.height * 0.80f)
        drawCircle(
            brush = Brush.radialGradient(
                listOf(Color(0x3430F0D5), Color(0x182D6BFF), Color.Transparent),
                center = lower,
                radius = size.width * 0.76f
            ),
            radius = size.width * 0.76f,
            center = lower
        )
        val side = Offset(size.width * 1.02f, size.height * (0.46f + drift * 0.06f))
        drawCircle(
            brush = Brush.radialGradient(
                listOf(Color(0x1F8A68FF), Color.Transparent),
                center = side,
                radius = size.width * 0.48f
            ),
            radius = size.width * 0.48f,
            center = side
        )
        for (index in 0..34) {
            val x = ((index * 73) % 997) / 997f * size.width
            val y = ((index * 193) % 991) / 991f * size.height
            val alpha = 0.10f + (index % 4) * 0.045f + shimmer * 0.10f
            drawCircle(
                color = Color(0xFFB8F4FF).copy(alpha = alpha.coerceAtMost(0.32f)),
                radius = if (index % 5 == 0) 1.35f else 0.75f,
                center = Offset(x, y)
            )
        }
    }
}

@Composable
private fun Header() {
    Row(
        Modifier.fillMaxWidth().padding(top = 5.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Box(
                Modifier.size(50.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(
                        Brush.radialGradient(
                            listOf(Color(0x6638E8F5), Color(0x222B72C9), Color.Transparent)
                        )
                    )
                    .border(
                        BorderStroke(
                            1.dp,
                            Brush.linearGradient(listOf(Cyan, Aqua, Blue, Violet))
                        ),
                        RoundedCornerShape(18.dp)
                    ),
                contentAlignment = Alignment.Center
            ) { BrandMark(39.dp) }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "مدار VPN",
                    fontSize = 19.sp,
                    fontWeight = FontWeight.Black,
                    color = White,
                    letterSpacing = 0.1.sp
                )
                Text(
                    "شبکه اختصاصی و هوشمند",
                    fontSize = 10.sp,
                    color = Muted,
                    letterSpacing = 0.25.sp
                )
            }
        }
        StatusPill("حساب تأییدشده", Green, Icons.Outlined.Shield)
    }
}

@Composable
private fun BrandMark(diameter: Dp) {
    Canvas(Modifier.size(diameter).semantics { contentDescription = "لوگوی مدار" }) {
        val sx = size.width / 100f
        val sy = size.height / 100f
        val stroke = size.minDimension * 0.065f
        val mark = Brush.linearGradient(listOf(Cyan, Aqua, Blue, Violet))
        val shield = Path().apply {
            moveTo(55f * sx, 13f * sy)
            cubicTo(65f * sx, 19f * sy, 76f * sx, 22f * sy, 84f * sx, 24f * sy)
            lineTo(84f * sx, 46f * sy)
            cubicTo(84f * sx, 64f * sy, 72f * sx, 78f * sy, 55f * sx, 88f * sy)
            cubicTo(39f * sx, 78f * sy, 27f * sx, 64f * sy, 27f * sx, 46f * sy)
            lineTo(27f * sx, 24f * sy)
            cubicTo(38f * sx, 22f * sy, 47f * sx, 18f * sy, 55f * sx, 13f * sy)
            close()
        }
        drawPath(
            shield,
            mark,
            style = Stroke(
                width = stroke,
                cap = StrokeCap.Round,
                join = androidx.compose.ui.graphics.StrokeJoin.Round
            )
        )
        drawLine(mark, Offset(5f * sx, 39f * sy), Offset(25f * sx, 39f * sy), stroke, StrokeCap.Round)
        drawLine(mark, Offset(1f * sx, 51f * sy), Offset(23f * sx, 51f * sy), stroke, StrokeCap.Round)
        drawLine(mark, Offset(8f * sx, 63f * sy), Offset(25f * sx, 63f * sy), stroke, StrokeCap.Round)
        drawArc(
            mark,
            startAngle = 180f,
            sweepAngle = 180f,
            useCenter = false,
            topLeft = Offset(45f * sx, 34f * sy),
            size = Size(21f * sx, 23f * sy),
            style = Stroke(width = stroke * 0.82f, cap = StrokeCap.Round)
        )
        drawRoundRect(
            mark,
            topLeft = Offset(42f * sx, 46f * sy),
            size = Size(27f * sx, 25f * sy),
            cornerRadius = CornerRadius(5f * sx, 5f * sy)
        )
        drawCircle(
            Color(0xFF071321),
            radius = 2.5f * sx,
            center = Offset(55.5f * sx, 55f * sy)
        )
        drawRoundRect(
            Color(0xFF071321),
            topLeft = Offset(54f * sx, 56f * sy),
            size = Size(3f * sx, 7f * sy),
            cornerRadius = CornerRadius(1.5f * sx, 1.5f * sy)
        )
    }
}

@Composable
private fun MadarCard(
    modifier: Modifier = Modifier,
    padding: Dp = 18.dp,
    content: @Composable ColumnScope.() -> Unit
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(27.dp),
        color = Color.Transparent,
        contentColor = White,
        border = BorderStroke(
            1.dp,
            Brush.linearGradient(
                listOf(Color(0xFF3A7897), Color(0xFF1B4562), Color(0xFF287C87), Color(0xFF294D80))
            )
        ),
        shadowElevation = 16.dp
    ) {
        Box(
            Modifier
                .background(
                    Brush.linearGradient(
                        listOf(Color(0xF2163048), Color(0xF00A1D30), Color(0xF0122940))
                    )
                )
        ) {
            Box(
                Modifier.matchParentSize().background(
                    Brush.radialGradient(
                        listOf(Color(0x142CE8E1), Color.Transparent),
                        center = Offset(0f, 0f),
                        radius = 520f
                    )
                )
            )
            Column(
                Modifier.fillMaxWidth().padding(padding),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                content = content
            )
        }
    }
}

@Composable
private fun ScreenHeading(eyebrow: String, title: String, subtitle: String) {
    Row(
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(11.dp)
    ) {
        Box(
            Modifier.width(4.dp).height(48.dp).clip(CircleShape)
                .background(Brush.verticalGradient(listOf(Aqua, Cyan, Violet)))
        )
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                eyebrow,
                color = Aqua,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.0.sp
            )
            Text(title, fontSize = 25.sp, fontWeight = FontWeight.Black, color = White)
            Text(subtitle, color = Muted, fontSize = 12.sp, lineHeight = 19.sp)
        }
    }
}

@Composable
private fun StatusPill(label: String, tint: Color, icon: ImageVector? = null) {
    val transition = rememberInfiniteTransition(label = "status-indicator")
    val pulse by transition.animateFloat(
        initialValue = 0.40f,
        targetValue = 0.95f,
        animationSpec = infiniteRepeatable(
            animation = tween(1450, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "status-pulse"
    )
    Row(
        Modifier.clip(CircleShape)
            .background(tint.copy(alpha = 0.105f))
            .border(1.dp, tint.copy(alpha = 0.30f), CircleShape)
            .padding(horizontal = 11.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp)
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
        } else {
            Box(
                Modifier.size(7.dp)
                    .background(tint.copy(alpha = pulse), CircleShape)
                    .border(1.dp, tint.copy(alpha = 0.34f), CircleShape)
            )
        }
        Text(label, color = tint, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun LoginPage(
    challenge: TelegramLoginChallenge?,
    code: String,
    busy: Boolean,
    error: String?,
    onStart: () -> Unit,
    onCodeChange: (String) -> Unit,
    onVerify: () -> Unit,
    onOpenTelegram: () -> Unit,
    onCancel: () -> Unit
) {
    val transition = rememberInfiniteTransition(label = "login-identity")
    val rotation by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(18000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "login-orbit-rotation"
    )
    val pulse by transition.animateFloat(
        initialValue = 0.94f,
        targetValue = 1.035f,
        animationSpec = infiniteRepeatable(
            animation = tween(2400, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "login-logo-pulse"
    )
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 22.dp, vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(Modifier.size(184.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val center = Offset(size.width / 2f, size.height / 2f)
                val radius = size.minDimension * 0.43f * pulse
                drawCircle(
                    brush = Brush.radialGradient(
                        listOf(Color(0x6636DDF5), Color(0x222D73E5), Color.Transparent),
                        center = center,
                        radius = size.minDimension * 0.56f
                    ),
                    radius = size.minDimension * 0.56f
                )
                drawCircle(
                    color = Color(0x4438D8F4),
                    radius = radius * 1.08f,
                    style = Stroke(width = 1.dp.toPx())
                )
                drawArc(
                    brush = Brush.sweepGradient(listOf(Cyan, Aqua, Blue, Violet, Cyan)),
                    startAngle = rotation,
                    sweepAngle = 238f,
                    useCenter = false,
                    topLeft = Offset(center.x - radius, center.y - radius),
                    size = Size(radius * 2f, radius * 2f),
                    style = Stroke(width = 2.5.dp.toPx(), cap = StrokeCap.Round)
                )
                val angle = rotation * (Math.PI / 180.0)
                val orbit = radius * 1.08f
                val satellite = Offset(
                    center.x + cos(angle).toFloat() * orbit,
                    center.y + sin(angle).toFloat() * orbit
                )
                drawCircle(Color(0x5535E9F1), radius = 8.dp.toPx(), center = satellite)
                drawCircle(Color(0xFFE2FFFF), radius = 2.6.dp.toPx(), center = satellite)
            }
            Box(
                Modifier.size(132.dp).clip(CircleShape)
                    .background(
                        Brush.radialGradient(
                            listOf(Color(0xFF164F6D), Color(0xFF0B2944), Color(0xFF071827))
                        )
                    )
                    .border(1.dp, Brush.linearGradient(listOf(Cyan, Aqua, Blue)), CircleShape),
                contentAlignment = Alignment.Center
            ) { BrandMark(105.dp) }
        }
        Spacer(Modifier.height(8.dp))
        Text("مدار VPN", fontSize = 34.sp, fontWeight = FontWeight.Black, color = White)
        Text(
            "اتصال هوشمند؛ تجربه‌ای فراتر از یک VPN",
            color = Muted,
            fontSize = 12.sp,
            letterSpacing = 0.15.sp
        )
        Spacer(Modifier.height(26.dp))
        MadarCard(padding = 22.dp) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        if (challenge == null) "ورود امن به مدار" else "تأیید هویت تلگرام",
                        fontSize = 21.sp,
                        fontWeight = FontWeight.Black,
                        color = White
                    )
                    Text("احراز هویت یک‌بارمصرف", color = Aqua, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                }
                Box(
                    Modifier.size(42.dp).clip(RoundedCornerShape(14.dp))
                        .background(Color(0x2236DDEB))
                        .border(1.dp, Color(0x5541DDEB), RoundedCornerShape(14.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Outlined.Lock, contentDescription = null, tint = Aqua, modifier = Modifier.size(21.dp))
                }
            }
            Crossfade(
                targetState = challenge == null,
                animationSpec = tween(320, easing = FastOutSlowInEasing),
                label = "login-step"
            ) { firstStep ->
                if (firstStep) {
                    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        Text(
                            "برای ورود، ربات مدار را فعال کنید. عضویت در کانال اطلاع‌رسانی مدار الزامی است؛ پس از تأیید عضویت، کد ورود برایتان ارسال می‌شود.",
                            color = Muted,
                            fontSize = 12.sp,
                            lineHeight = 21.sp
                        )
                        GradientButton(
                            label = if (busy) "در حال ایجاد درخواست…" else "دریافت کد از تلگرام",
                            icon = Icons.Outlined.Send,
                            enabled = !busy,
                            onClick = onStart
                        )
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.Center
                        ) {
                            Icon(Icons.Outlined.Shield, contentDescription = null, tint = Green, modifier = Modifier.size(15.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("ورود فقط از طریق ربات رسمی مدار", color = Muted, fontSize = 10.sp)
                        }
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(13.dp)) {
                        Text(
                            "در تلگرام روی «Start» بزنید. اگر هنوز فعال نشده‌اید، عضو کانال مدار شوید و «بررسی عضویت و ادامه» را بزنید. سپس کد ۶ رقمی را اینجا وارد کنید.",
                            color = Muted,
                            fontSize = 12.sp,
                            lineHeight = 21.sp
                        )
                        StatusPill("در انتظار کد ورود", Aqua, Icons.Outlined.Lock)
                        OutlinedTextField(
                            value = code,
                            onValueChange = onCodeChange,
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            enabled = !busy,
                            label = { Text("کد تأیید ۶ رقمی") },
                            placeholder = { Text("••••••", color = Muted) },
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Number,
                                imeAction = ImeAction.Done
                            ),
                            textStyle = LocalTextStyle.current.copy(
                                textAlign = TextAlign.Center,
                                letterSpacing = 9.sp,
                                fontSize = 24.sp,
                                fontWeight = FontWeight.Black,
                                color = White
                            ),
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = White,
                                unfocusedTextColor = White,
                                focusedBorderColor = Aqua,
                                unfocusedBorderColor = Color(0xFF385A73),
                                focusedLabelColor = Aqua,
                                unfocusedLabelColor = Muted,
                                cursorColor = Aqua
                            )
                        )
                        GradientButton(
                            label = if (busy) "در حال بررسی کد…" else "تأیید کد و ورود",
                            icon = Icons.Outlined.Lock,
                            enabled = !busy && code.length == 6,
                            onClick = onVerify
                        )
                        TextButton(onClick = onOpenTelegram, enabled = !busy) {
                            Text("باز کردن دوباره ربات تلگرام", color = Aqua, fontWeight = FontWeight.SemiBold)
                        }
                        TextButton(onClick = onCancel, enabled = !busy) {
                            Text("لغو و شروع مجدد", color = Muted)
                        }
                    }
                }
            }
            if (busy) {
                CircularProgressIndicator(
                    color = Aqua,
                    trackColor = Color(0x334BC8FF),
                    strokeWidth = 2.5.dp,
                    modifier = Modifier.align(Alignment.CenterHorizontally).size(24.dp)
                )
            }
            if (error != null) {
                Text(error, color = Danger, fontSize = 12.sp, lineHeight = 19.sp)
            }
        }
        Spacer(Modifier.height(17.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Icon(Icons.Outlined.Security, contentDescription = null, tint = Aqua, modifier = Modifier.size(16.dp))
            Text(
                "کد یک‌بارمصرف، بدون کپی کانفیگ و انتخاب سرور",
                color = Muted,
                fontSize = 10.sp
            )
        }
        Spacer(Modifier.height(7.dp))
        Text("حریم خصوصی شما، اولویت مدار است", color = Color(0xFF66849D), fontSize = 9.sp)
    }
}

@Composable
private fun GradientButton(
    label: String, icon: ImageVector, enabled: Boolean = true, onClick: () -> Unit
) {
    Row(
        Modifier.fillMaxWidth().height(58.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(
                if (enabled) Brush.horizontalGradient(listOf(Color(0xFF54D8FF), Aqua, Color(0xFF2BE0B9)))
                else Brush.horizontalGradient(listOf(Color(0xFF3D657A), Color(0xFF29485F)))
            )
            .border(
                1.dp,
                if (enabled) Color(0x887CFFF0) else Color(0x334D8194),
                RoundedCornerShape(18.dp)
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center
    ) {
        Icon(icon, contentDescription = null, tint = Color(0xFF061421), modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Text(label, color = Color(0xFF061421), fontWeight = FontWeight.Black, fontSize = 15.sp)
    }
}

@Composable
private fun ConnectionPage(
    state: ConnectionState, speed: LiveSpeed, subscription: SubscriptionSnapshot?,
    error: String?, onConnect: () -> Unit, onDisconnect: () -> Unit
) {
    val connected = state is ConnectionState.Connected
    val busy = state is ConnectionState.Dialing || state is ConnectionState.TestingTraffic
    val canConnect = subscription?.hasUsablePlan(System.currentTimeMillis()) == true
    val statusText = when (state) {
        ConnectionState.Idle -> if (canConnect) "آماده اتصال" else if (error == "SERVER_UNAVAILABLE") "در انتظار مسیر اتصال" else "اشتراک در دسترس نیست"
        is ConnectionState.Dialing -> "در حال برقراری مسیر امن"
        is ConnectionState.TestingTraffic -> "در حال بررسی عبور داده"
        is ConnectionState.Connected -> "متصل و تأییدشده"
        is ConnectionState.Failed -> "اتصال برقرار نشد"
    }
    val statusTint = if (connected || (state == ConnectionState.Idle && canConnect)) Green
        else if (busy) Aqua else Muted

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ScreenHeading(
            "MADAR NETWORK",
            "شبکه تو، تحت کنترل تو",
            "اتصال هوشمند با انتخاب خودکار بهترین مسیر تأییدشده."
        )
        MadarCard(padding = 17.dp) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("هسته اتصال مدار", color = White, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Text("SECURE CONNECTION CORE", color = Color(0xFF7195AD), fontSize = 8.sp, letterSpacing = 1.1.sp)
                }
                StatusPill(statusText, statusTint)
            }
            ConnectOrb(
                connected,
                busy,
                canConnect || connected,
                { if (connected) onDisconnect() else onConnect() }
            )
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(15.dp))
                    .background(Color(0x1A39CFE2))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center
            ) {
                Icon(Icons.Outlined.Bolt, contentDescription = null, tint = Aqua, modifier = Modifier.size(17.dp))
                Spacer(Modifier.width(7.dp))
                Text("انتخاب خودکار اپراتور و مسیر", color = White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(11.dp)) {
            Box(Modifier.weight(1f)) {
                SpeedCard("دانلود", speed.downloadMbps, Icons.Outlined.Download)
            }
            Box(Modifier.weight(1f)) {
                SpeedCard("آپلود", speed.uploadMbps, Icons.Outlined.Upload)
            }
        }
        if (subscription != null) QuickPlanCard(subscription)
        MadarCard(padding = 16.dp) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Box(
                    Modifier.size(43.dp).clip(RoundedCornerShape(15.dp))
                        .background(Brush.radialGradient(listOf(Color(0x6645E8D5), Color(0x223A77D8))))
                        .border(1.dp, Color(0x4438D8E6), RoundedCornerShape(15.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Outlined.Shield, contentDescription = null, tint = Aqua, modifier = Modifier.size(25.dp))
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("محافظت سراسری دستگاه", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    Text(
                        if (connected) "تونل امن دستگاه فعال و ترافیک تأیید شده است."
                        else "پس از تأیید اجازه اندروید، ترافیک دستگاه از تونل عبور می‌کند.",
                        color = Muted,
                        fontSize = 10.sp,
                        lineHeight = 17.sp
                    )
                }
                StatusPill(if (connected) "فعال" else "آماده", if (connected) Green else Muted)
            }
        }
        if (!canConnect && !connected) {
            MadarCard(padding = 15.dp) {
                StatusPill("نیاز به بررسی حساب", Muted, Icons.Outlined.Info)
                Text(
                    when (error) {
                        "SUBSCRIPTION_UNAVAILABLE" -> "اشتراک فعالی برای این حساب پیدا نشد یا دسترسی آن لغو شده است."
                        "SUBSCRIPTION_EXPIRED_OR_EMPTY" -> "حجم یا زمان اشتراک به پایان رسیده است."
                        "SERVER_UNAVAILABLE" -> "حساب شما تأیید شده، اما مسیر اتصال هنوز آماده یا تازه‌تأیید نشده است."
                        else -> "اطلاعات اشتراک و مسیرهای تأییدشده در حال بررسی است."
                    },
                    color = Muted,
                    fontSize = 11.sp,
                    lineHeight = 18.sp
                )
            }
        }
    }
}

@Composable
private fun ConnectOrb(
    connected: Boolean, busy: Boolean, enabled: Boolean, onClick: () -> Unit
) {
    val transition = rememberInfiniteTransition(label = "connection-orbit")
    val pulse by transition.animateFloat(
        initialValue = 0.955f,
        targetValue = 1.035f,
        animationSpec = infiniteRepeatable(
            animation = tween(if (busy) 780 else 2350, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "connection-pulse"
    )
    val rotation by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(if (busy) 5000 else 13000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "connection-rotation"
    )
    val tint = if (connected) Green else Aqua
    Box(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        contentAlignment = Alignment.Center
    ) {
        Box(Modifier.size(278.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val center = Offset(size.width / 2f, size.height / 2f)
                val radius = size.minDimension * 0.405f
                drawCircle(
                    brush = Brush.radialGradient(
                        listOf(
                            tint.copy(alpha = 0.20f),
                            Color(0x222D7DFF),
                            Color.Transparent
                        ),
                        center = center,
                        radius = size.minDimension * 0.53f * pulse
                    ),
                    radius = size.minDimension * 0.53f * pulse,
                    center = center
                )
                drawCircle(
                    color = tint.copy(alpha = 0.12f),
                    radius = radius * 1.16f * pulse,
                    style = Stroke(width = 16.dp.toPx())
                )
                drawCircle(
                    color = Color(0x444BCDF1),
                    radius = radius * 1.10f,
                    style = Stroke(width = 1.dp.toPx())
                )
                drawArc(
                    brush = Brush.sweepGradient(listOf(Cyan, Aqua, Blue, Violet, Cyan)),
                    startAngle = rotation,
                    sweepAngle = 245f,
                    useCenter = false,
                    topLeft = Offset(center.x - radius, center.y - radius),
                    size = Size(radius * 2f, radius * 2f),
                    style = Stroke(width = 5.dp.toPx(), cap = StrokeCap.Round)
                )
                drawArc(
                    color = Color(0x664FC7E8),
                    startAngle = rotation + 180f,
                    sweepAngle = 68f,
                    useCenter = false,
                    topLeft = Offset(center.x - radius * 1.13f, center.y - radius * 1.13f),
                    size = Size(radius * 2.26f, radius * 2.26f),
                    style = Stroke(width = 1.2.dp.toPx(), cap = StrokeCap.Round)
                )
                val angle = rotation * (Math.PI / 180.0)
                val orbitRadius = radius * 1.12f
                val satellite = Offset(
                    center.x + cos(angle).toFloat() * orbitRadius,
                    center.y + sin(angle).toFloat() * orbitRadius
                )
                drawCircle(Color(0x5539E9F4), radius = 8.dp.toPx(), center = satellite)
                drawCircle(Color(0xFFE8FFFF), radius = 2.7.dp.toPx(), center = satellite)
                drawCircle(
                    color = Color(0x3348D8F1),
                    radius = radius * 0.83f,
                    style = Stroke(width = 1.dp.toPx())
                )
            }
            Box(
                Modifier.size(188.dp).clip(CircleShape)
                    .background(
                        Brush.radialGradient(
                            listOf(Color(0xFF174F6D), Color(0xFF0B2A45), Color(0xFF071827))
                        )
                    )
                    .border(
                        1.dp,
                        Brush.linearGradient(listOf(Color(0xFF6EEBFF), Aqua, Blue)),
                        CircleShape
                    )
                    .clickable(enabled = enabled && !busy, onClick = onClick)
                    .semantics {
                        contentDescription = if (connected) "قطع اتصال VPN" else "اتصال VPN"
                    },
                contentAlignment = Alignment.Center
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    if (busy) {
                        CircularProgressIndicator(
                            color = Aqua,
                            trackColor = Color(0x334BC8FF),
                            strokeWidth = 3.5.dp,
                            modifier = Modifier.size(54.dp)
                        )
                    } else {
                        Icon(
                            Icons.Outlined.PowerSettingsNew,
                            contentDescription = null,
                            tint = tint,
                            modifier = Modifier.size(54.dp)
                        )
                    }
                    Text(
                        when {
                            connected -> "قطع اتصال"
                            busy -> "در حال اتصال"
                            else -> "اتصال امن"
                        },
                        color = White,
                        fontWeight = FontWeight.Black,
                        fontSize = 19.sp
                    )
                    Text(
                        if (connected) "SECURE TUNNEL ACTIVE" else "TAP TO CONNECT",
                        color = Color(0xFF91C4D7),
                        fontSize = 7.sp,
                        letterSpacing = 1.1.sp
                    )
                }
            }
        }
    }
}

@Composable
private fun SpeedCard(label: String, value: Double, icon: ImageVector) {
    MadarCard(padding = 14.dp) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp)
        ) {
            Box(
                Modifier.size(31.dp).clip(RoundedCornerShape(11.dp))
                    .background(Color(0x2238D9E9)),
                contentAlignment = Alignment.Center
            ) {
                Icon(icon, contentDescription = null, tint = Aqua, modifier = Modifier.size(17.dp))
            }
            Text(label, color = Muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(
                String.format(Locale.US, "%.1f", value),
                color = White,
                fontWeight = FontWeight.Black,
                fontSize = 23.sp
            )
            Text("Mbps", color = Aqua, fontWeight = FontWeight.Bold, fontSize = 10.sp)
        }
        Text("سرعت لحظه‌ای", color = Color(0xFF6E8FA7), fontSize = 9.sp)
    }
}

@Composable
private fun QuickPlanCard(subscription: SubscriptionSnapshot) {
    val quota = subscription.quotaBytes.coerceAtLeast(1L)
    val used = subscription.usedBytes.coerceIn(0L, quota)
    val remaining = (quota - used).coerceAtLeast(0L)
    val progress = (used.toFloat() / quota.toFloat()).coerceIn(0f, 1f)
    val animated by animateFloatAsState(
        targetValue = progress,
        animationSpec = tween(850, easing = FastOutSlowInEasing),
        label = "quick-plan-progress"
    )
    val days = max(
        0L,
        (subscription.expiresAtMs - System.currentTimeMillis() + 86399999L) / 86400000L
    )
    MadarCard(padding = 16.dp) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("اشتراک شما", color = White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                Text("وضعیت واقعی حساب مدار", color = Muted, fontSize = 9.sp)
            }
            StatusPill("فعال", Green)
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Bottom
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("حجم باقی‌مانده", color = Muted, fontSize = 10.sp)
                Text(gb(remaining) + " GB", color = Aqua, fontSize = 25.sp, fontWeight = FontWeight.Black)
            }
            Text(days.toString() + " روز اعتبار", color = White, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
        Canvas(Modifier.fillMaxWidth().height(7.dp)) {
            drawRoundRect(
                color = Color(0xFF24465F),
                cornerRadius = CornerRadius(size.height / 2f)
            )
            drawRoundRect(
                brush = Brush.horizontalGradient(listOf(Aqua, Cyan, Blue)),
                size = Size(size.width * animated, size.height),
                cornerRadius = CornerRadius(size.height / 2f)
            )
        }
    }
}

@Composable
private fun UsagePage(subscription: SubscriptionSnapshot?, error: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ScreenHeading(
            "ACCOUNT INSIGHTS",
            "اشتراک و مصرف",
            "وضعیت حجم و اعتبار اشتراک را با اطلاعات واقعی سرور ببینید."
        )
        if (subscription == null) {
            MadarCard(padding = 20.dp) {
                StatusPill("در انتظار دریافت اطلاعات", Muted, Icons.Outlined.DataUsage)
                Text(
                    if (error == "SUBSCRIPTION_UNAVAILABLE")
                        "اشتراک فعالی برای این حساب پیدا نشد."
                    else "در حال دریافت اطلاعات ثبت‌شده در سرور مدار…",
                    color = Muted,
                    fontSize = 12.sp,
                    lineHeight = 21.sp
                )
            }
            return
        }
        val quota = subscription.quotaBytes.coerceAtLeast(1L)
        val used = subscription.usedBytes.coerceIn(0L, quota)
        val remaining = (quota - used).coerceAtLeast(0L)
        val progress = (used.toFloat() / quota.toFloat()).coerceIn(0f, 1f)
        val animatedProgress by animateFloatAsState(
            targetValue = progress,
            animationSpec = tween(1000, easing = FastOutSlowInEasing),
            label = "usage-ring-progress"
        )
        val days = max(
            0L,
            (subscription.expiresAtMs - System.currentTimeMillis() + 86399999L) / 86400000L
        )
        MadarCard(padding = 19.dp) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("مدار پرمیوم", color = White, fontWeight = FontWeight.Black, fontSize = 17.sp)
                    Text("گزارش زنده اشتراک", color = Muted, fontSize = 10.sp)
                }
                StatusPill("اشتراک فعال", Green)
            }
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Box(Modifier.size(224.dp), contentAlignment = Alignment.Center) {
                    Canvas(Modifier.fillMaxSize()) {
                        val stroke = 15.dp.toPx()
                        val topLeft = Offset(stroke / 2f, stroke / 2f)
                        val arcSize = Size(size.width - stroke, size.height - stroke)
                        drawCircle(
                            brush = Brush.radialGradient(
                                listOf(Color(0x223CE7E1), Color.Transparent)
                            ),
                            radius = size.minDimension * 0.48f
                        )
                        drawArc(
                            color = Color(0xFF24465F),
                            startAngle = -90f,
                            sweepAngle = 360f,
                            useCenter = false,
                            topLeft = topLeft,
                            size = arcSize,
                            style = Stroke(width = stroke, cap = StrokeCap.Round)
                        )
                        drawArc(
                            brush = Brush.sweepGradient(listOf(Aqua, Cyan, Blue, Violet, Aqua)),
                            startAngle = -90f,
                            sweepAngle = 360f * animatedProgress,
                            useCenter = false,
                            topLeft = topLeft,
                            size = arcSize,
                            style = Stroke(width = stroke, cap = StrokeCap.Round)
                        )
                    }
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Text(
                            String.format(Locale.US, "%.0f%%", progress * 100f),
                            fontSize = 39.sp,
                            fontWeight = FontWeight.Black,
                            color = White
                        )
                        Text("مصرف‌شده", color = Muted, fontSize = 11.sp)
                    }
                }
            }
            Text(
                "حجم باقی‌مانده: " + gb(remaining) + " گیگابایت",
                color = Green,
                fontWeight = FontWeight.Black,
                fontSize = 16.sp
            )
            Canvas(Modifier.fillMaxWidth().height(7.dp)) {
                drawRoundRect(Color(0xFF24465F), cornerRadius = CornerRadius(size.height / 2f))
                drawRoundRect(
                    brush = Brush.horizontalGradient(listOf(Aqua, Cyan, Blue)),
                    size = Size(size.width * animatedProgress, size.height),
                    cornerRadius = CornerRadius(size.height / 2f)
                )
            }
            HorizontalDivider(color = Color(0xFF244965))
            UsageInfoRow("حجم کل اشتراک", gb(subscription.quotaBytes) + " گیگابایت", Icons.Outlined.DataUsage)
            UsageInfoRow("حجم مصرف‌شده", gb(used) + " گیگابایت", Icons.Outlined.BarChart)
            UsageInfoRow("زمان باقی‌مانده", days.toString() + " روز", Icons.Outlined.CalendarMonth)
        }
        MadarCard(padding = 15.dp) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = Aqua, modifier = Modifier.size(22.dp))
                Text(
                    "مقادیر مصرف و زمان فقط از سرور مدار دریافت می‌شوند؛ هیچ عدد نمایشی یا تخمینی جایگزین داده واقعی نیست.",
                    color = Muted,
                    fontSize = 10.sp,
                    lineHeight = 17.sp
                )
            }
        }
    }
}

private fun gb(value: Long): String =
    String.format(Locale.US, "%.1f", value / 1073741824.0)

@Composable
private fun UsageInfoRow(label: String, value: String, icon: ImageVector) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            Icon(icon, contentDescription = null, tint = Muted, modifier = Modifier.size(17.dp))
            Text(label, color = Muted, fontSize = 11.sp)
        }
        Text(value, color = White, fontWeight = FontWeight.Bold, fontSize = 12.sp)
    }
}

@Composable
private fun ProfilePage(
    subscription: SubscriptionSnapshot?, subscriptionError: String?,
    onSupport: () -> Unit, onLogout: () -> Unit
) {
    var guide by rememberSaveable { mutableStateOf(false) }
    var faq by rememberSaveable { mutableStateOf(false) }
    var about by rememberSaveable { mutableStateOf(false) }
    val active = subscription?.hasUsablePlan(System.currentTimeMillis()) == true
    Column(verticalArrangement = Arrangement.spacedBy(15.dp)) {
        ScreenHeading(
            "YOUR MADAR ID",
            "پروفایل و پشتیبانی",
            "مدیریت حساب، راهنما و ارتباط با تیم مدار."
        )
        MadarCard(padding = 20.dp) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                Box(
                    Modifier.size(64.dp).clip(RoundedCornerShape(21.dp))
                        .background(Brush.linearGradient(listOf(Color(0x5549E4ED), Color(0x334B76FF), Color(0x228D6AFF))))
                        .border(1.dp, Color(0x6646D9E9), RoundedCornerShape(21.dp)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        Icons.Outlined.AccountCircle,
                        contentDescription = null,
                        tint = Aqua,
                        modifier = Modifier.size(42.dp)
                    )
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text("حساب تلگرام شما", fontSize = 16.sp, fontWeight = FontWeight.Black)
                    Text("هویت تأییدشده در شبکه مدار", color = Muted, fontSize = 10.sp)
                    StatusPill("ورود امن فعال", Green)
                }
            }
        }
        MadarCard(padding = 16.dp) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("وضعیت اشتراک", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                    Text(
                        when {
                            active -> "فعال · " + gb(max(0L, subscription!!.quotaBytes - subscription.usedBytes)) + " گیگابایت باقی‌مانده"
                            subscriptionError == "SUBSCRIPTION_UNAVAILABLE" -> "اشتراک فعال نیست یا دسترسی لغو شده است"
                            subscriptionError == "SUBSCRIPTION_EXPIRED_OR_EMPTY" -> "حجم یا اعتبار اشتراک به پایان رسیده است"
                            else -> "در حال بررسی اشتراک"
                        },
                        color = if (active) Green else Muted,
                        fontSize = 10.sp,
                        lineHeight = 17.sp
                    )
                }
                StatusPill(if (active) "ACTIVE" else "CHECK", if (active) Green else Muted)
            }
        }
        ActionRow(
            Icons.Outlined.SupportAgent,
            "پشتیبانی آنلاین",
            "ارتباط مستقیم با تیم پشتیبانی مدار",
            onSupport
        )
        ActionRow(
            Icons.Outlined.HelpOutline,
            "سؤالات متداول",
            "پاسخ به پرسش‌های رایج",
            { faq = !faq },
            expanded = faq
        )
        if (faq) MadarCard {
            Text("آیا باید سرور انتخاب کنم؟", fontWeight = FontWeight.Bold)
            Text("خیر، مدار مسیرهای تأییدشده را به‌صورت خودکار انتخاب می‌کند.", color = Muted, fontSize = 11.sp)
            HorizontalDivider(color = Color(0xFF244965))
            Text("آیا تمام گوشی تونل می‌شود؟", fontWeight = FontWeight.Bold)
            Text("پس از اجازه اندروید و تأیید اتصال، تونل سراسری فعال است.", color = Muted, fontSize = 11.sp)
        }
        ActionRow(
            Icons.Outlined.MenuBook,
            "راهنمای استفاده",
            "آموزش ورود و اتصال",
            { guide = !guide },
            expanded = guide
        )
        if (guide) MadarCard {
            Text("۱. با حساب تلگرام خود وارد شوید.")
            Text("۲. اجازه اتصال VPN را تأیید کنید.")
            Text("۳. دکمه اتصال امن را لمس کنید.")
            Text("۴. حجم و زمان باقی‌مانده را در بخش مصرف ببینید.")
        }
        ActionRow(
            Icons.Outlined.Info,
            "درباره مدار",
            "هویت و نسخه برنامه",
            { about = !about },
            expanded = about
        )
        if (about) MadarCard {
            Text("مدار VPN", fontWeight = FontWeight.Black, fontSize = 17.sp)
            Text(
                "اتصال امن و هوشمند با انتخاب خودکار مسیرهای تأییدشده.",
                color = Muted,
                fontSize = 11.sp,
                lineHeight = 18.sp
            )
            UsageInfoRow("نسخه اپ", BuildConfig.VERSION_NAME, Icons.Outlined.Info)
        }
        ActionRow(
            Icons.Outlined.Logout,
            "خروج از حساب",
            "پاک‌کردن نشست و لغو دسترسی این دستگاه",
            onLogout,
            danger = true
        )
    }
}

@Composable
private fun ActionRow(
    icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit,
    expanded: Boolean = false, danger: Boolean = false
) {
    Surface(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(22.dp),
        color = Color.Transparent,
        border = BorderStroke(
            1.dp,
            if (danger) Danger.copy(alpha = 0.28f) else Color(0xFF28516D)
        ),
        shadowElevation = 5.dp
    ) {
        Row(
            Modifier.background(
                Brush.linearGradient(
                    if (danger) listOf(Color(0xE51D2638), Color(0xE9111C2B))
                    else listOf(Color(0xE715344D), Color(0xE90A2034))
                )
            ).padding(horizontal = 15.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp)
        ) {
            Box(
                Modifier.size(43.dp).clip(RoundedCornerShape(15.dp))
                    .background((if (danger) Danger else Aqua).copy(alpha = 0.12f))
                    .border(
                        1.dp,
                        (if (danger) Danger else Aqua).copy(alpha = 0.20f),
                        RoundedCornerShape(15.dp)
                    ),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    icon,
                    contentDescription = null,
                    tint = if (danger) Danger else Aqua,
                    modifier = Modifier.size(22.dp)
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    title,
                    color = if (danger) Danger else White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp
                )
                Text(subtitle, color = Muted, fontSize = 9.sp, lineHeight = 15.sp)
            }
            Text(
                if (expanded) "⌄" else "‹",
                color = if (danger) Danger.copy(alpha = 0.8f) else Color(0xFF7DA3B8),
                fontSize = 22.sp
            )
        }
    }
}

@Composable
private fun MadarBottomBar(selected: Int, onSelect: (Int) -> Unit) {
    val items = listOf(
        Triple("اتصال", Icons.Outlined.Home, 0),
        Triple("مصرف", Icons.Outlined.BarChart, 1),
        Triple("پروفایل", Icons.Outlined.AccountCircle, 2)
    )
    Surface(
        modifier = Modifier.padding(horizontal = 13.dp, vertical = 8.dp),
        color = Color.Transparent,
        shape = RoundedCornerShape(26.dp),
        border = BorderStroke(
            1.dp,
            Brush.linearGradient(listOf(Color(0xFF3C728A), Color(0xFF1E405E), Color(0xFF347A82)))
        ),
        shadowElevation = 20.dp
    ) {
        Row(
            Modifier.fillMaxWidth()
                .background(
                    Brush.verticalGradient(listOf(Color(0xF51A354C), Color(0xFA071827)))
                )
                .padding(horizontal = 9.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically
        ) {
            items.forEach { item ->
                val isSelected = selected == item.third
                Column(
                    Modifier.weight(1f)
                        .clip(RoundedCornerShape(18.dp))
                        .then(
                            if (isSelected) Modifier.background(
                                Brush.verticalGradient(
                                    listOf(Color(0x443FE5E5), Color(0x1A3979C6), Color(0x083A6A9B))
                                )
                            ) else Modifier
                        )
                        .clickable { onSelect(item.third) }
                        .padding(vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Icon(
                        item.second,
                        contentDescription = item.first,
                        tint = if (isSelected) Aqua else Muted,
                        modifier = Modifier.size(if (isSelected) 25.dp else 22.dp)
                    )
                    Text(
                        item.first,
                        color = if (isSelected) White else Muted,
                        fontSize = 10.sp,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium
                    )
                    Box(
                        Modifier.width(if (isSelected) 24.dp else 5.dp)
                            .height(3.dp)
                            .clip(CircleShape)
                            .background(
                                if (isSelected) Brush.horizontalGradient(listOf(Cyan, Aqua, Violet))
                                else Brush.horizontalGradient(listOf(Color.Transparent, Color.Transparent))
                            )
                    )
                }
            }
        }
    }
}
