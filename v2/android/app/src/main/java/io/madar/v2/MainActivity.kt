package io.madar.v2

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MadarHome() }
    }
}

private val LightMadar = lightColorScheme(
    primary = Color(0xFF11647E),
    onPrimary = Color.White,
    background = Color(0xFFF4F8FA),
    surface = Color.White,
    surfaceVariant = Color(0xFFE6F0F4),
    onSurface = Color(0xFF142830),
)

private val DarkMadar = darkColorScheme(
    primary = Color(0xFF80D5EF),
    background = Color(0xFF09181E),
    surface = Color(0xFF152A33),
    surfaceVariant = Color(0xFF203942),
    onSurface = Color(0xFFE8F4F8),
)

private data class Tab(val label: Int, val icon: String)

@Composable
fun MadarHome() {
    val tabs = listOf(
        Tab(R.string.nav_home, "⌂"),
        Tab(R.string.nav_servers, "◈"),
        Tab(R.string.nav_account, "◯"),
        Tab(R.string.nav_help, "?"),
    )
    var selected by rememberSaveable { mutableIntStateOf(0) }

    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) DarkMadar else LightMadar) {
        Scaffold(
            bottomBar = {
                NavigationBar {
                    tabs.forEachIndexed { index, tab ->
                        NavigationBarItem(
                            selected = selected == index,
                            onClick = { selected = index },
                            icon = { Text(tab.icon, style = MaterialTheme.typography.titleMedium) },
                            label = { Text(stringResource(tab.label)) },
                            alwaysShowLabel = true,
                        )
                    }
                }
            }
        ) { padding ->
            Column(
                modifier = Modifier.fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp, vertical = 22.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp)
            ) {
                Text(
                    stringResource(R.string.app_name_short),
                    style = MaterialTheme.typography.headlineLarge,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    stringResource(R.string.preview_label),
                    color = MaterialTheme.colorScheme.primary,
                    style = MaterialTheme.typography.labelLarge,
                )
                HorizontalDivider()
                when (selected) {
                    0 -> HomeScreen(onHelp = { selected = 3 })
                    1 -> ServersScreen()
                    2 -> AccountScreen()
                    3 -> HelpScreen()
                }
                Spacer(Modifier.height(12.dp))
            }
        }
    }
}

@Composable
private fun HomeScreen(onHelp: () -> Unit) {
    Text(stringResource(R.string.home_headline), style = MaterialTheme.typography.headlineSmall)
    Text(stringResource(R.string.home_desc), style = MaterialTheme.typography.bodyLarge)
    StatusCard(stringResource(R.string.preview_status_title), stringResource(R.string.preview_status_body))
    Button(enabled = false, onClick = {}, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.connect_disabled))
    }
    Text(
        stringResource(R.string.not_connected_disclaimer),
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth()
    )
    OutlinedButton(onClick = onHelp, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.action_help))
    }
}

@Composable
private fun ServersScreen() {
    Text(stringResource(R.string.servers_title), style = MaterialTheme.typography.headlineSmall)
    Text(stringResource(R.string.servers_desc))
    StatusCard(stringResource(R.string.servers_check_title), stringResource(R.string.servers_check_details))
    Text(stringResource(R.string.servers_disclaimer), style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun AccountScreen() {
    Text(stringResource(R.string.account_title), style = MaterialTheme.typography.headlineSmall)
    StatusCard(stringResource(R.string.account_preview_title), stringResource(R.string.account_preview_details))
    Text(stringResource(R.string.account_disclaimer))
}

@Composable
private fun HelpScreen() {
    Text(stringResource(R.string.help_title), style = MaterialTheme.typography.headlineSmall)
    StatusCard(stringResource(R.string.help_connect_question), stringResource(R.string.help_connect_answer))
    StatusCard(stringResource(R.string.help_error_question), stringResource(R.string.help_error_answer))
    StatusCard(stringResource(R.string.help_privacy_question), stringResource(R.string.help_privacy_answer))
}

@Composable
private fun StatusCard(title: String, detail: String) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(detail, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
