package io.lumen.secure.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.lumen.secure.R
import io.lumen.secure.ui.theme.LumenDimens
import io.lumen.secure.ui.theme.LumenPalette
import io.lumen.secure.ui.theme.lumenColors

/** Initials avatar (no remote avatar images are fetched: fewer requests, no tracking pixels). */
@Composable
fun Avatar(name: String, modifier: Modifier = Modifier, size: Dp = 40.dp) {
    val palette = listOf(LumenPalette.cyan600, LumenPalette.teal600, LumenPalette.violet600, LumenPalette.midnight600, LumenPalette.amber600)
    val letter = name.trim().removePrefix("@").removePrefix("#").firstOrNull()?.uppercaseChar()?.toString() ?: "?"
    val color = palette[(name.hashCode() and 0x7fffffff) % palette.size]
    Box(
        modifier.size(size).clip(CircleShape).background(color).clearAndSetSemantics { },
        contentAlignment = Alignment.Center,
    ) {
        Text(letter, color = Color.White, style = MaterialTheme.typography.titleMedium)
    }
}

enum class BannerKind { INFO, WARNING, DANGER, SUCCESS }

@Composable
fun Banner(
    text: String,
    kind: BannerKind = BannerKind.INFO,
    @DrawableRes icon: Int = R.drawable.ic_lucide_info,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    secondaryLabel: String? = null,
    onSecondary: (() -> Unit)? = null,
) {
    val c = MaterialTheme.lumenColors
    val (bg, fg) = when (kind) {
        BannerKind.INFO -> c.infoSoft to c.info
        BannerKind.WARNING -> c.warningSoft to c.warning
        BannerKind.DANGER -> c.dangerSoft to c.danger
        BannerKind.SUCCESS -> c.successSoft to c.success
    }
    Surface(color = bg, modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = false) { }) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(icon), null, tint = fg, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium, color = c.text, modifier = Modifier.weight(1f))
            if (secondaryLabel != null && onSecondary != null) TextButton(onClick = onSecondary) { Text(secondaryLabel) }
            if (actionLabel != null && onAction != null) TextButton(onClick = onAction) { Text(actionLabel) }
        }
    }
}

@Composable
fun CenteredState(
    title: String,
    body: String? = null,
    @DrawableRes icon: Int? = null,
    loading: Boolean = false,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val c = MaterialTheme.lumenColors
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(color = c.accent)
            Spacer(Modifier.height(16.dp))
        } else if (icon != null) {
            Icon(painterResource(icon), null, tint = c.textSubtle, modifier = Modifier.size(40.dp))
            Spacer(Modifier.height(16.dp))
        }
        Text(title, style = MaterialTheme.typography.titleMedium, color = c.text, textAlign = TextAlign.Center)
        if (body != null) {
            Spacer(Modifier.height(6.dp))
            Text(body, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, textAlign = TextAlign.Center)
        }
        if (actionLabel != null && onAction != null) {
            Spacer(Modifier.height(16.dp))
            TextButton(onClick = onAction) { Text(actionLabel) }
        }
    }
}

@Composable
fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.lumenColors.accent,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 6.dp).semantics { heading() },
    )
}

@Composable
fun SettingRow(
    title: String,
    subtitle: String? = null,
    @DrawableRes icon: Int? = null,
    onClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = MaterialTheme.lumenColors
    Row(
        modifier.fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(painterResource(icon), null, tint = c.textMuted, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(16.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = c.text)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
        }
        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            trailing()
        }
    }
}

@Composable
fun SwitchRow(title: String, subtitle: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val c = MaterialTheme.lumenColors
    Row(
        Modifier.fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Switch) { onChange(!checked) }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = if (enabled) c.text else c.textSubtle)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

@Composable
fun UnreadBadge(count: Long, mention: Boolean) {
    val c = MaterialTheme.lumenColors
    val label = if (count > 99) "99+" else count.toString()
    val desc = pluralStringResource(R.plurals.cd_unread, count.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(), count)
    Box(
        Modifier.clip(CircleShape).background(if (mention) c.danger else c.accent).padding(horizontal = 7.dp, vertical = 2.dp)
            .semantics { contentDescription = desc },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = c.accentContrast, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Clip)
    }
}

@Composable
fun LogoMark(size: Dp = 56.dp) {
    Icon(
        painterResource(R.drawable.lumen_logo),
        contentDescription = null,
        tint = Color.Unspecified,
        modifier = Modifier.size(size).clip(androidx.compose.foundation.shape.RoundedCornerShape(LumenDimens.radiusLg)),
    )
}
