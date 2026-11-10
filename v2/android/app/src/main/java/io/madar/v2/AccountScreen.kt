package io.madar.v2

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.PasswordVisualTransformation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun AccountScreen(onConnect: () -> Unit, onDisconnect: () -> Unit) {
    val context = LocalContext.current
    val store = remember(context) { SubscriptionTokenStore(context) }
    val scope = rememberCoroutineScope()
    val vpnState by VpnStatus.state.collectAsState()
    var tokenInput by remember { mutableStateOf("") }
    var hasToken by remember { mutableStateOf(store.read() != null) }
    var checking by remember { mutableStateOf(false) }
    var statusCode by remember { mutableStateOf<String?>(null) }
    var snapshot by remember { mutableStateOf<SubscriptionSnapshot?>(null) }

    Text(stringResource(R.string.account_title), style = MaterialTheme.typography.headlineSmall)
    Text(stringResource(R.string.account_preview_details))
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(
            value = tokenInput,
            onValueChange = { tokenInput = it.take(128) },
            singleLine = true,
            label = { Text(stringResource(R.string.token_label)) },
            placeholder = { Text(stringResource(R.string.token_placeholder)) },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false, keyboardType = KeyboardType.Password
            ),
            modifier = Modifier.fillMaxWidth()
        )
        Button(
            enabled = SubscriptionTokenFormat.isValid(tokenInput.trim()) && !checking,
            onClick = {
                val saved = store.save(tokenInput.trim())
                if (saved) {
                    tokenInput = ""
                    hasToken = true
                    snapshot = null
                }
                statusCode = if (saved) "TOKEN_SAVED" else "STORE_ERROR"
            },
            modifier = Modifier.fillMaxWidth()
        ) { Text(stringResource(R.string.save_token)) }

        if (hasToken) {
            Button(
                enabled = !checking,
                onClick = {
                    checking = true
                    scope.launch {
                        val result = withContext(Dispatchers.IO) {
                            val key = store.read()
                            val origin = BuildConfig.SUBSCRIPTION_API_ORIGIN
                            if (key == null) SubscriptionResult.Unavailable("INVALID_TOKEN")
                            else if (origin.isBlank()) SubscriptionResult.Unavailable("NOT_CONFIGURED")
                            else SubscriptionApi(origin).fetch(key)
                        }
                        when (result) {
                            is SubscriptionResult.Available -> {
                                snapshot = result.snapshot
                                statusCode = "AVAILABLE"
                            }
                            is SubscriptionResult.Unavailable -> {
                                snapshot = null
                                statusCode = result.code
                            }
                        }
                        checking = false
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.verify_subscription)) }
            OutlinedButton(
                onClick = {
                    store.clear()
                    hasToken = false
                    tokenInput = ""
                    statusCode = "TOKEN_REMOVED"
                    snapshot = null
                },
                enabled = !checking && vpnState !is ConnectionState.Connected,
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.remove_token)) }
        }
        if (checking) CircularProgressIndicator()
        statusCode?.let { code ->
            Text(
                when (code) {
                    "AVAILABLE" -> stringResource(R.string.account_verified)
                    "TOKEN_SAVED" -> stringResource(R.string.token_saved)
                    "TOKEN_REMOVED" -> stringResource(R.string.token_removed)
                    "INVALID_TOKEN" -> stringResource(R.string.token_invalid)
                    "SUBSCRIPTION_UNAVAILABLE", "SUBSCRIPTION_EXPIRED_OR_EMPTY" ->
                        stringResource(R.string.subscription_not_ready)
                    "SERVER_UNAVAILABLE", "NOT_CONFIGURED" ->
                        stringResource(R.string.server_not_ready)
                    else -> stringResource(R.string.subscription_check_failed)
                },
                style = MaterialTheme.typography.bodyMedium
            )
        }
        snapshot?.let { sub ->
            Text(stringResource(R.string.usage_summary,
                sub.usedBytes / 1073741824.0, sub.quotaBytes / 1073741824.0))
            Text(stringResource(R.string.routes_summary, sub.routes.size))
            when (vpnState) {
                is ConnectionState.Connected -> OutlinedButton(
                    onClick = onDisconnect, modifier = Modifier.fillMaxWidth()
                ) { Text(stringResource(R.string.disconnect_button)) }
                is ConnectionState.Dialing, is ConnectionState.TestingTraffic -> OutlinedButton(
                    onClick = onDisconnect, modifier = Modifier.fillMaxWidth()
                ) { Text(stringResource(R.string.cancel_connection)) }
                else -> Button(
                    enabled = !checking, onClick = onConnect, modifier = Modifier.fillMaxWidth()
                ) { Text(stringResource(R.string.connect_button)) }
            }
        }
        Text(
            when (vpnState) {
                ConnectionState.Idle -> stringResource(R.string.vpn_disconnected)
                is ConnectionState.Dialing -> stringResource(R.string.vpn_connecting)
                is ConnectionState.TestingTraffic -> stringResource(R.string.vpn_testing)
                is ConnectionState.Connected -> stringResource(R.string.vpn_connected)
                is ConnectionState.Failed -> stringResource(R.string.vpn_failed)
            },
            style = MaterialTheme.typography.bodyMedium
        )
        Text(stringResource(R.string.account_disclaimer), style = MaterialTheme.typography.bodySmall)
    }
}
