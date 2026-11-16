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

private val Navy = Color(0xFF041326)
private val Panel = Color(0xFF0D2943)
private val Aqua = Color(0xFF00E5D4)
private val Cyan = Color(0xFF08BFF5)
private val Blue = Color(0xFF286CFF)
private val Muted = Color(0xFF9CB7CE)
private val Green = Color(0xFF35E3B0)
private val White = Color(0xFFF3FAFF)
private val Danger = Color(0xFFFF8295)

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
                        loginError = "هنوز کدی دریافت نشده است. در تلگرام روی «Start» بزنید و سپس دوباره تلاش کنید."
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
                                        animationSpec = tween(260, easing = FastOutSlowInEasing),
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
    val transition = rememberInfiniteTransition(label = "backdrop-motion")
    val drift by transition.animateFloat(
        initialValue = 0f, targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(9000, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "backdrop-drift"
    )
    Canvas(Modifier.fillMaxSize()) {
        drawRect(Brush.verticalGradient(
            listOf(Color(0xFF020C19), Color(0xFF061B32), Color(0xFF031326))
        ))
        val upper = Offset(size.width * (0.86f - drift * 0.10f), size.height * 0.12f)
        drawCircle(
            brush = Brush.radialGradient(
                listOf(Color(0x44217DFF), Color(0x1621CFFF), Color.Transparent),
                center = upper, radius = size.width * 0.82f
            ),
            radius = size.width * 0.82f, center = upper
        )
        val lower = Offset(size.width * (0.08f + drift * 0.12f), size.height * 0.82f)
        drawCircle(
            brush = Brush.radialGradient(
                listOf(Color(0x3021D8E8), Color(0x10226BFF), Color.Transparent),
                center = lower, radius = size.width * 0.72f
            ),
            radius = size.width * 0.72f, center = lower
        )
    }
}

@Composable
private fun Header() {
    Row(
        Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(11.dp)
        ) {
            Box(
                Modifier.size(46.dp)
                    .background(Brush.radialGradient(
                        listOf(Color(0x5531DFFF), Color.Transparent)
                    ), CircleShape)
                    .border(
                        BorderStroke(1.dp, Brush.linearGradient(listOf(Cyan, Aqua, Blue))),
                        CircleShape
                    ),
                contentAlignment = Alignment.Center
            ) { BrandMark(37.dp) }
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text("مدار VPN", fontSize = 19.sp, fontWeight = FontWeight.ExtraBold, color = White)
                Text("اتصال آزاد، امن و سریع", fontSize = 10.sp, color = Muted)
            }
        }
        StatusPill("عضو مدار", Green, Icons.Outlined.Shield)
    }
}

@Composable
private fun BrandMark(diameter: Dp) {
    // Draw the Madar mark as a native vector so it stays crisp and has no
    // opaque square bitmap background on the dark app surface.
    Canvas(Modifier.size(diameter).semantics { contentDescription = "لوگوی مدار" }) {
        val sx = size.width / 100f
        val sy = size.height / 100f
        val stroke = size.minDimension * 0.065f
        val mark = Brush.linearGradient(listOf(Cyan, Aqua, Blue))
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
            shield, mark,
            style = Stroke(width = stroke, cap = StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round)
        )
        drawLine(mark, Offset(5f * sx, 39f * sy), Offset(25f * sx, 39f * sy), stroke, StrokeCap.Round)
        drawLine(mark, Offset(1f * sx, 51f * sy), Offset(23f * sx, 51f * sy), stroke, StrokeCap.Round)
        drawLine(mark, Offset(8f * sx, 63f * sy), Offset(25f * sx, 63f * sy), stroke, StrokeCap.Round)
        drawArc(
            mark, startAngle = 180f, sweepAngle = 180f, useCenter = false,
            topLeft = Offset(45f * sx, 34f * sy),
            size = Size(21f * sx, 23f * sy),
            style = Stroke(width = stroke * 0.82f, cap = StrokeCap.Round)
        )
        drawRoundRect(
            mark, topLeft = Offset(42f * sx, 46f * sy),
            size = Size(27f * sx, 25f * sy),
            cornerRadius = CornerRadius(5f * sx, 5f * sy)
        )
        drawCircle(Color(0xFF041326), radius = 2.5f * sx, center = Offset(55.5f * sx, 55f * sy))
        drawRoundRect(
            Color(0xFF041326), topLeft = Offset(54f * sx, 56f * sy),
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
        shape = RoundedCornerShape(25.dp),
        color = Color.Transparent,
        contentColor = White,
        border = BorderStroke(
            1.dp,
            Brush.linearGradient(listOf(Color(0xFF24628B), Color(0xFF1A496C), Color(0xFF0C7892)))
        ),
        shadowElevation = 10.dp
    ) {
        Box(Modifier.background(Brush.linearGradient(
            listOf(Color(0xF2143551), Color(0xF00B263F), Color(0xF212304A))
        ))) {
            Column(
                Modifier.padding(padding),
                verticalArrangement = Arrangement.spacedBy(13.dp),
                content = content
            )
        }
    }
}

@Composable
private fun ScreenHeading(eyebrow: String, title: String, subtitle: String) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(eyebrow, color = Aqua, fontSize = 10.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 1.1.sp)
        Text(title, fontSize = 25.sp, fontWeight = FontWeight.ExtraBold, color = White)
        Text(subtitle, color = Muted, fontSize = 12.sp, lineHeight = 19.sp)
    }
}

@Composable
private fun StatusPill(label: String, tint: Color, icon: ImageVector? = null) {
    Row(
        Modifier.clip(CircleShape)
            .background(tint.copy(alpha = 0.12f))
            .border(1.dp, tint.copy(alpha = 0.32f), CircleShape)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(14.dp))
        else Box(Modifier.size(6.dp).background(tint, CircleShape))
        Text(label, color = tint, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
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
    val transition = rememberInfiniteTransition(label = "login-logo")
    val pulse by transition.animateFloat(
        initialValue = 0.94f, targetValue = 1.04f,
        animationSpec = infiniteRepeatable(
            tween(2300, easing = FastOutSlowInEasing), RepeatMode.Reverse
        ),
        label = "login-pulse"
    )
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 26.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(Modifier.size(164.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                drawCircle(
                    brush = Brush.radialGradient(listOf(Color(0x5531DFFF), Color.Transparent)),
                    radius = size.minDimension * 0.48f * pulse
                )
                drawCircle(
                    brush = Brush.sweepGradient(listOf(Cyan, Aqua, Blue, Cyan)),
                    radius = size.minDimension * 0.43f * pulse,
                    style = Stroke(width = 2.dp.toPx())
                )
            }
            BrandMark(126.dp)
        }
        Spacer(Modifier.height(8.dp))
        Text("مدار VPN", fontSize = 34.sp, fontWeight = FontWeight.Black, color = White)
        Text("دسترسی آزاد، امن و پایدار", color = Muted, fontSize = 14.sp)
        Spacer(Modifier.height(28.dp))
        MadarCard(padding = 22.dp) {
            Text(
                if (challenge == null) "ورود به حساب کاربری" else "تأیید شماره تلگرام",
                fontSize = 21.sp, fontWeight = FontWeight.Bold, color = White
            )
            Text(
                if (challenge == null)
                    "برای ورود، از ربات مدار یک کد یک‌بارمصرف دریافت کنید."
                else
                    "در تلگرام روی «Start» بزنید. ربات مدار کد ۶ رقمی را برای همین حساب می‌فرستد؛ سپس آن را در این قسمت وارد کنید.",
                color = Muted, fontSize = 13.sp, lineHeight = 22.sp
            )
            if (challenge == null) {
                GradientButton(
                    label = if (busy) "در حال ایجاد درخواست…" else "دریافت کد از تلگرام",
                    icon = Icons.Outlined.Send, enabled = !busy, onClick = onStart
                )
            } else {
                StatusPill("در انتظار کد یک‌بارمصرف", Aqua, Icons.Outlined.Lock)
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
                        letterSpacing = 8.sp,
                        fontSize = 23.sp,
                        fontWeight = FontWeight.Bold,
                        color = White
                    ),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedTextColor = White,
                        unfocusedTextColor = White,
                        focusedBorderColor = Aqua,
                        unfocusedBorderColor = Color(0xFF3C607D),
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
                    Text("باز کردن دوباره ربات تلگرام", color = Aqua)
                }
                TextButton(onClick = onCancel, enabled = !busy) {
                    Text("لغو و شروع مجدد", color = Muted)
                }
            }
            if (busy) CircularProgressIndicator(
                color = Aqua, strokeWidth = 2.dp,
                modifier = Modifier.align(Alignment.CenterHorizontally).size(25.dp)
            )
            if (error != null) Text(
                error, color = Danger, fontSize = 12.sp, lineHeight = 18.sp
            )
        }
        Spacer(Modifier.height(20.dp))
        Row(verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Outlined.Lock, contentDescription = null, tint = Aqua, modifier = Modifier.size(16.dp))
            Text("کد یک‌بارمصرف، بدون کپی کانفیگ و انتخاب سرور", color = Muted, fontSize = 11.sp)
        }
    }
}

@Composable
private fun GradientButton(
    label: String, icon: ImageVector, enabled: Boolean = true, onClick: () -> Unit
) {
    Row(
        Modifier.fillMaxWidth().height(58.dp).clip(RoundedCornerShape(18.dp))
            .background(
                if (enabled) Brush.horizontalGradient(listOf(Cyan, Aqua, Color(0xFF00C9B8)))
                else Brush.horizontalGradient(listOf(Color(0xFF3E6479), Color(0xFF31556B)))
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center
    ) {
        Icon(icon, contentDescription = null, tint = Navy, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(10.dp))
        Text(label, color = Navy, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp)
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
    Column(verticalArrangement = Arrangement.spacedBy(17.dp)) {
        ScreenHeading(
            "شبکه امن مدار", "اتصال با یک لمس",
            "مدار به‌صورت خودکار مسیر مناسب را انتخاب می‌کند."
        )
        ConnectOrb(
            connected, busy, canConnect || connected,
            { if (connected) onDisconnect() else onConnect() }
        )
        StatusPill(
            when (state) {
                ConnectionState.Idle -> if (canConnect) "آماده اتصال" else if (error == "SERVER_UNAVAILABLE") "در انتظار مسیر اتصال" else "اشتراک در دسترس نیست"
                is ConnectionState.Dialing -> "در حال برقراری مسیر امن"
                is ConnectionState.TestingTraffic -> "در حال بررسی عبور داده"
                is ConnectionState.Connected -> "متصل و تأییدشده"
                is ConnectionState.Failed -> "اتصال برقرار نشد"
            },
            if (connected || (state == ConnectionState.Idle && canConnect)) Green else Muted
        )
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.weight(1f)) { SpeedCard("سرعت دانلود", speed.downloadMbps, Icons.Outlined.Download) }
            Box(Modifier.weight(1f)) { SpeedCard("سرعت آپلود", speed.uploadMbps, Icons.Outlined.Upload) }
        }
        MadarCard {
            Row(
                Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("مسیر هوشمند", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Text("بدون انتخاب دستی سرور یا اپراتور", color = Muted, fontSize = 11.sp)
                }
                Box(
                    Modifier.size(46.dp).background(
                        Brush.radialGradient(listOf(Color(0x6632DFFF), Color(0x2225A8D9))),
                        CircleShape
                    ), contentAlignment = Alignment.Center
                ) { Icon(Icons.Outlined.Bolt, contentDescription = null, tint = Aqua, modifier = Modifier.size(27.dp)) }
            }
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                StatusPill("انتخاب خودکار", Aqua, Icons.Outlined.Layers)
                Text("بهترین مسیر بر اساس وضعیت شبکه", color = Muted, fontSize = 10.sp)
            }
        }
        MadarCard {
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Outlined.Shield, contentDescription = null, tint = Aqua, modifier = Modifier.size(30.dp))
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("محافظت از کل دستگاه", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Text(
                        if (connected) "تونل سراسری دستگاه فعال است."
                        else "با تأیید اجازه اندروید، تمام ترافیک از تونل عبور می‌کند.",
                        color = Muted, fontSize = 11.sp, lineHeight = 18.sp
                    )
                }
            }
        }
        if (!canConnect && !connected) Text(
            when (error) {
                "SUBSCRIPTION_UNAVAILABLE" -> "اشتراک فعال ندارید یا دسترسی آن لغو شده است."
                "SUBSCRIPTION_EXPIRED_OR_EMPTY" -> "حجم یا زمان اشتراک به پایان رسیده است."
                "SERVER_UNAVAILABLE" -> "حساب شما تأیید شد، اما مسیر اتصال هنوز آماده یا تازه‌تأیید نشده است. بعداً دوباره تلاش کنید."
                else -> "در حال بررسی اشتراک و مسیرهای تأییدشده…"
            },
            color = Muted, fontSize = 11.sp, lineHeight = 18.sp
        )
    }
}

@Composable
private fun ConnectOrb(
    connected: Boolean, busy: Boolean, enabled: Boolean, onClick: () -> Unit
) {
    val transition = rememberInfiniteTransition(label = "connect-orb")
    val pulse by transition.animateFloat(
        initialValue = 0.94f, targetValue = 1.03f,
        animationSpec = infiniteRepeatable(
            animation = tween(if (busy) 850 else 2200, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse
        ),
        label = "orb-pulse"
    )
    val tint = if (connected) Green else Aqua
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Box(Modifier.size(274.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize()) {
                val radius = size.minDimension * 0.43f
                drawCircle(
                    brush = Brush.radialGradient(
                        listOf(Color(0x5530DFFF), Color(0x1A187EFF), Color.Transparent),
                        radius = size.minDimension * 0.52f * pulse
                    ),
                    radius = size.minDimension * 0.48f * pulse
                )
                drawCircle(
                    color = Color(0x3322C9F2), radius = radius * 1.08f * pulse,
                    style = Stroke(width = 13.dp.toPx())
                )
                drawCircle(
                    brush = Brush.sweepGradient(listOf(Cyan, Aqua, Blue, Cyan)),
                    radius = radius, style = Stroke(width = 7.dp.toPx(), cap = StrokeCap.Round)
                )
                drawCircle(
                    color = Color(0x5538CFFF), radius = radius * 0.88f,
                    style = Stroke(width = 1.dp.toPx())
                )
            }
            Box(
                Modifier.size(218.dp).clip(CircleShape)
                    .background(Brush.radialGradient(
                        listOf(Color(0xFF0E456C), Color(0xFF092A49), Color(0xFF061D38))
                    ))
                    .border(1.dp, Color(0x6656CFFF), CircleShape)
                    .clickable(enabled = enabled && !busy, onClick = onClick),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    if (busy) CircularProgressIndicator(
                        color = Aqua, trackColor = Color(0x334BC8FF),
                        strokeWidth = 4.dp, modifier = Modifier.size(58.dp)
                    ) else Icon(
                        Icons.Outlined.PowerSettingsNew, contentDescription = null,
                        tint = tint, modifier = Modifier.size(62.dp)
                    )
                    Text(
                        when {
                            connected -> "قطع اتصال"
                            busy -> "در حال اتصال"
                            else -> "اتصال"
                        },
                        color = White, fontWeight = FontWeight.Bold, fontSize = 22.sp
                    )
                }
            }
        }
    }
}

@Composable
private fun SpeedCard(label: String, value: Double, icon: ImageVector) {
    Surface(
        shape = RoundedCornerShape(21.dp), color = Color.Transparent,
        border = BorderStroke(1.dp, Color(0xFF23577C)), shadowElevation = 5.dp
    ) {
        Column(
            Modifier.fillMaxWidth()
                .background(Brush.linearGradient(listOf(Color(0xE7143653), Color(0xE90B263F))))
                .padding(horizontal = 14.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(icon, contentDescription = null, tint = Aqua, modifier = Modifier.size(17.dp))
                Text(label, color = Muted, fontSize = 11.sp)
            }
            Text(
                String.format(Locale.US, "%.1f", value) + " Mbps",
                color = Aqua, fontWeight = FontWeight.ExtraBold, fontSize = 19.sp
            )
        }
    }
}

@Composable
private fun UsagePage(subscription: SubscriptionSnapshot?, error: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
        ScreenHeading(
            "اشتراک شما", "اشتراک و مصرف",
            "وضعیت حجم و اعتبار اشتراک خود را یک‌جا ببینید."
        )
        if (subscription == null) {
            MadarCard {
                StatusPill("در انتظار دریافت اطلاعات", Muted, Icons.Outlined.DataUsage)
                Text(
                    if (error == "SUBSCRIPTION_UNAVAILABLE")
                        "اشتراک فعالی برای این حساب پیدا نشد."
                    else "در حال دریافت اطلاعات ثبت‌شده در سرور مدار…",
                    color = Muted, fontSize = 13.sp, lineHeight = 21.sp
                )
            }
            return
        }
        val quota = subscription.quotaBytes.coerceAtLeast(1)
        val used = subscription.usedBytes.coerceIn(0L, quota)
        val remaining = max(0L, quota - used)
        val progress = (used.toFloat() / quota).coerceIn(0f, 1f)
        val animatedProgress by animateFloatAsState(
            targetValue = progress,
            animationSpec = tween(900, easing = FastOutSlowInEasing),
            label = "usage-progress"
        )
        val days = max(
            0L, (subscription.expiresAtMs - System.currentTimeMillis() + 86399999L) / 86400000L
        )
        MadarCard {
            Row(
                Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("اشتراک مدار", fontWeight = FontWeight.Bold, fontSize = 17.sp)
                    Text("اطلاعات به‌روز حساب شما", color = Muted, fontSize = 11.sp)
                }
                StatusPill("اشتراک فعال", Green)
            }
        }
        MadarCard(padding = 20.dp) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Box(Modifier.size(218.dp), contentAlignment = Alignment.Center) {
                    Canvas(Modifier.fillMaxSize()) {
                        val stroke = 15.dp.toPx()
                        drawArc(
                            color = Color(0xFF244B68), startAngle = -90f,
                            sweepAngle = 360f, useCenter = false,
                            style = Stroke(width = stroke, cap = StrokeCap.Round)
                        )
                        drawArc(
                            brush = Brush.sweepGradient(listOf(Aqua, Cyan, Blue, Aqua)),
                            startAngle = -90f, sweepAngle = 360f * animatedProgress,
                            useCenter = false,
                            style = Stroke(width = stroke, cap = StrokeCap.Round)
                        )
                    }
                    Column(horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text(
                            String.format(Locale.US, "%.0f%%", progress * 100f),
                            fontSize = 39.sp, fontWeight = FontWeight.Black, color = White
                        )
                        Text("مصرف‌شده", color = Muted, fontSize = 12.sp)
                    }
                }
            }
            Text(
                "حجم باقی‌مانده: " + gb(remaining) + " گیگابایت",
                color = Green, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp
            )
            HorizontalDivider(color = Color(0xFF244965))
            UsageInfoRow("حجم کل اشتراک", gb(subscription.quotaBytes) + " گیگابایت", Icons.Outlined.DataUsage)
            UsageInfoRow("حجم مصرف‌شده", gb(used) + " گیگابایت", Icons.Outlined.BarChart)
            UsageInfoRow("زمان باقی‌مانده", days.toString() + " روز", Icons.Outlined.CalendarMonth)
        }
        MadarCard {
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Icons.Outlined.Info, contentDescription = null, tint = Aqua, modifier = Modifier.size(22.dp))
                Text(
                    "مقادیر مصرف و زمان فقط از سرور مدار دریافت می‌شوند.",
                    color = Muted, fontSize = 11.sp, lineHeight = 18.sp
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
        Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Row(verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            Icon(icon, contentDescription = null, tint = Muted, modifier = Modifier.size(17.dp))
            Text(label, color = Muted, fontSize = 12.sp)
        }
        Text(value, color = White, fontWeight = FontWeight.Bold, fontSize = 13.sp)
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
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ScreenHeading(
            "حساب کاربری مدار", "پروفایل و پشتیبانی",
            "مدیریت حساب و راه‌های دریافت کمک."
        )
        MadarCard(padding = 20.dp) {
            Row(verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(
                    Modifier.size(58.dp)
                        .background(Brush.linearGradient(listOf(
                            Cyan.copy(alpha = 0.28f), Blue.copy(alpha = 0.2f)
                        )), CircleShape)
                        .border(1.dp, Color(0xFF2585A7), CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Outlined.AccountCircle, contentDescription = null,
                        tint = Aqua, modifier = Modifier.size(39.dp))
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Text("حساب تلگرام", fontSize = 17.sp, fontWeight = FontWeight.Bold)
                    Text("حساب تلگرام تأییدشده", color = Muted, fontSize = 11.sp)
                    StatusPill("ورود تأییدشده", Green)
                }
            }
        }
        MadarCard {
            Row(
                Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("اشتراک من", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                Icon(Icons.Outlined.Security, contentDescription = null, tint = Aqua, modifier = Modifier.size(24.dp))
            }
            Text(
                when {
                    active -> "فعال · " + gb(max(0L, subscription!!.quotaBytes - subscription.usedBytes)) +
                        " گیگابایت باقی‌مانده"
                    subscriptionError == "SUBSCRIPTION_UNAVAILABLE" -> "اشتراک فعال نیست یا دسترسی لغو شده است"
                    subscriptionError == "SUBSCRIPTION_EXPIRED_OR_EMPTY" -> "حجم یا اعتبار اشتراک به پایان رسیده است"
                    else -> "در حال بررسی اشتراک"
                },
                color = if (active) Green else Muted, fontSize = 12.sp, lineHeight = 19.sp
            )
        }
        ActionRow(Icons.Outlined.SupportAgent, "پشتیبانی آنلاین",
            "ارتباط مستقیم با تیم پشتیبانی مدار", onSupport)
        ActionRow(Icons.Outlined.HelpOutline, "سؤالات متداول",
            "پاسخ به پرسش‌های رایج", { faq = !faq }, expanded = faq)
        if (faq) MadarCard {
            Text("آیا باید سرور انتخاب کنم؟", fontWeight = FontWeight.Bold)
            Text("خیر، مدار مسیرهای تأییدشده را به‌صورت خودکار انتخاب می‌کند.", color = Muted, fontSize = 12.sp)
            Text("آیا تمام گوشی تونل می‌شود؟", fontWeight = FontWeight.Bold)
            Text("پس از اجازه اندروید و تأیید اتصال، تونل سراسری فعال است.", color = Muted, fontSize = 12.sp)
        }
        ActionRow(Icons.Outlined.MenuBook, "راهنمای استفاده",
            "آموزش ورود و اتصال", { guide = !guide }, expanded = guide)
        if (guide) MadarCard {
            Text("۱. با حساب تلگرام خود وارد شوید.")
            Text("۲. اجازه اتصال VPN را تأیید کنید.")
            Text("۳. دکمه اتصال را لمس کنید.")
            Text("۴. حجم و زمان باقی‌مانده را در تب مصرف ببینید.")
        }
        ActionRow(Icons.Outlined.Info, "درباره مدار",
            "VPN اختصاصی مشترکان مدار", { about = !about }, expanded = about)
        if (about) MadarCard {
            Text("مدار VPN", fontWeight = FontWeight.Bold, fontSize = 17.sp)
            Text(
                "اتصال امن و هوشمند با انتخاب خودکار مسیرهای تأییدشده.",
                color = Muted, fontSize = 12.sp, lineHeight = 19.sp
            )
            UsageInfoRow("نسخه اپ", BuildConfig.VERSION_NAME, Icons.Outlined.Info)
        }
        ActionRow(Icons.Outlined.Logout, "خروج از حساب",
            "پاک‌کردن نشست و لغو دسترسی این دستگاه", onLogout, danger = true)
    }
}

@Composable
private fun ActionRow(
    icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit,
    expanded: Boolean = false, danger: Boolean = false
) {
    Surface(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = RoundedCornerShape(21.dp), color = Color.Transparent,
        border = BorderStroke(1.dp, Color(0xFF204F70))
    ) {
        Row(
            Modifier.background(Brush.linearGradient(
                listOf(Color(0xE7133550), Color(0xE90B263F))
            )).padding(horizontal = 16.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp)
        ) {
            Box(
                Modifier.size(42.dp).clip(RoundedCornerShape(14.dp))
                    .background((if (danger) Danger else Aqua).copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    icon, contentDescription = null,
                    tint = if (danger) Danger else Aqua, modifier = Modifier.size(22.dp)
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, color = if (danger) Danger else White,
                    fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text(subtitle, color = Muted, fontSize = 10.sp, lineHeight = 16.sp)
            }
            Text(if (expanded) "⌄" else "‹", color = Muted, fontSize = 23.sp)
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
        color = Color.Transparent,
        shape = RoundedCornerShape(topStart = 25.dp, topEnd = 25.dp),
        border = BorderStroke(1.dp, Color(0xFF1D4A6A)),
        shadowElevation = 18.dp
    ) {
        Row(
            Modifier.fillMaxWidth()
                .background(Brush.verticalGradient(
                    listOf(Color(0xF4112D47), Color(0xFA061A30))
                ))
                .padding(horizontal = 10.dp, vertical = 9.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically
        ) {
            items.forEach { item ->
                val isSelected = selected == item.third
                Column(
                    Modifier.weight(1f).clip(RoundedCornerShape(17.dp))
                        .then(
                            if (isSelected) Modifier.background(Brush.verticalGradient(
                                listOf(Color(0x4430DCEB), Color(0x1A1473A7))
                            )) else Modifier
                        )
                        .clickable { onSelect(item.third) }
                        .padding(vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Icon(
                        item.second, contentDescription = item.first,
                        tint = if (isSelected) Aqua else Muted,
                        modifier = Modifier.size(if (isSelected) 25.dp else 23.dp)
                    )
                    Text(
                        item.first, color = if (isSelected) Aqua else Muted,
                        fontSize = 10.sp,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium
                    )
                    if (isSelected) Box(
                        Modifier.width(17.dp).height(2.dp)
                            .background(Brush.horizontalGradient(listOf(Cyan, Aqua)), CircleShape)
                    )
                }
            }
        }
    }
}
