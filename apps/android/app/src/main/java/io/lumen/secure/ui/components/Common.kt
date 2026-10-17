package io.lumen.secure.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalDensity
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
import io.lumen.secure.ui.theme.LumenBrand
import io.lumen.secure.ui.theme.LumenDimens
import io.lumen.secure.ui.theme.LumenPalette
import io.lumen.secure.ui.theme.isDark
import io.lumen.secure.ui.theme.lumenColors

// Deep tones only, so the white initial meets WCAG AA (at least 5.7:1) on every one of them.
private val avatarTones = listOf(
    LumenPalette.cyan700, LumenPalette.teal700, LumenPalette.violet700,
    LumenPalette.midnight600, LumenPalette.amber700, LumenPalette.green700,
)

/**
 * Initials avatar (no remote avatar images are fetched: fewer requests, no tracking pixels).
 * [ring] adds the brand-gradient ring used for the room in focus and for your own profile.
 */
@Composable
fun Avatar(name: String, modifier: Modifier = Modifier, size: Dp = 40.dp, ring: Boolean = false) {
    val letter = name.trim().removePrefix("@").removePrefix("#").firstOrNull()?.uppercaseChar()?.toString() ?: "?"
    val tone = avatarTones[(name.hashCode() and 0x7fffffff) % avatarTones.size]
    val fill = Brush.linearGradient(listOf(tone, lerp(tone, LumenPalette.midnight950, 0.22f)), start = Offset.Zero, end = Offset.Infinite)
    val inner = if (ring) size - 6.dp else size
    // The initial scales with the avatar, not with the font size setting (the name beside it does).
    val fontSize = with(LocalDensity.current) { (inner * 0.42f).toSp() }
    Box(modifier.size(size).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        if (ring) Box(Modifier.matchParentSize().border(2.dp, LumenBrand.gradient, CircleShape))
        Box(Modifier.size(inner).clip(CircleShape).background(fill), contentAlignment = Alignment.Center) {
            Text(letter, color = Color.White, style = MaterialTheme.typography.titleMedium.copy(fontSize = fontSize, lineHeight = fontSize))
        }
    }
}

enum class BannerKind { INFO, WARNING, DANGER, SUCCESS }

/**
 * A calm, rounded notice card. The text says what happened and what to do; the actions sit below it
 * so long text never gets squeezed on small screens or with large fonts.
 */
@Suppress("ModifierParameter") // positional call sites pass the actions; modifier stays last
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun Banner(
    text: String,
    kind: BannerKind = BannerKind.INFO,
    @DrawableRes icon: Int = R.drawable.ic_lucide_info,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    secondaryLabel: String? = null,
    onSecondary: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val c = MaterialTheme.lumenColors
    val (fg, soft) = when (kind) {
        BannerKind.INFO -> c.accent to c.accentSoft
        BannerKind.WARNING -> c.warning to c.warningSoft
        BannerKind.DANGER -> c.danger to c.dangerSoft
        BannerKind.SUCCESS -> c.success to c.successSoft
    }
    val hasActions = (actionLabel != null && onAction != null) || (secondaryLabel != null && onSecondary != null)
    Surface(
        color = soft.compositeOver(c.surface),
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Column(Modifier.padding(start = 14.dp, end = 6.dp, top = 12.dp, bottom = if (hasActions) 2.dp else 12.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Icon(painterResource(icon), null, tint = fg, modifier = Modifier.padding(top = 1.dp).size(20.dp))
                Spacer(Modifier.width(12.dp))
                Text(text, style = MaterialTheme.typography.bodyMedium, color = c.text, modifier = Modifier.weight(1f).padding(end = 8.dp))
            }
            if (hasActions) {
                FlowRow(Modifier.align(Alignment.End), horizontalArrangement = Arrangement.End) {
                    if (secondaryLabel != null && onSecondary != null) {
                        TextButton(onClick = onSecondary) { Text(secondaryLabel, color = c.textMuted) }
                    }
                    if (actionLabel != null && onAction != null) {
                        TextButton(onClick = onAction) { Text(actionLabel, color = fg) }
                    }
                }
            }
        }
    }
}

/** A small icon on a soft brand glow: the illustration for empty, waiting and success states. */
@Composable
fun Illustration(@DrawableRes icon: Int, modifier: Modifier = Modifier, size: Dp = 104.dp, tint: Color = MaterialTheme.lumenColors.accent) {
    val c = MaterialTheme.lumenColors
    val dark = MaterialTheme.isDark
    Box(modifier.size(size).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.matchParentSize()) {
            val r = this.size.minDimension / 2
            drawCircle(Brush.radialGradient(listOf(LumenPalette.cyan400.copy(alpha = if (dark) 0.22f else 0.20f), Color.Transparent), center = Offset(r * 0.8f, r * 0.8f), radius = r))
            drawCircle(Brush.radialGradient(listOf(LumenPalette.peach400.copy(alpha = if (dark) 0.16f else 0.22f), Color.Transparent), center = Offset(r * 1.3f, r * 1.25f), radius = r * 0.8f))
            drawCircle(Brush.radialGradient(listOf(LumenPalette.violet400.copy(alpha = 0.14f), Color.Transparent), center = Offset(r * 1.35f, r * 0.6f), radius = r * 0.6f))
        }
        Box(
            Modifier.size(size * 0.6f).clip(CircleShape).background(c.surface).border(1.5.dp, LumenBrand.gradient, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(painterResource(icon), null, tint = tint, modifier = Modifier.size(size * 0.26f))
        }
    }
}

/**
 * Empty, error and waiting states: one friendly sentence, an optional clear action, an illustration.
 * Scrolls when large text does not fit.
 */
@Composable
fun CenteredState(
    title: String,
    body: String? = null,
    @DrawableRes icon: Int? = null,
    loading: Boolean = false,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    iconTint: Color = MaterialTheme.lumenColors.accent,
) {
    val c = MaterialTheme.lumenColors
    val scroll = rememberScrollState()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        // Inside an already scrolling screen the height is unbounded: then it simply takes its natural size.
        val bounded = constraints.hasBoundedHeight
        Column(
            Modifier.then(if (bounded) Modifier.verticalScroll(scroll).heightIn(min = maxHeight) else Modifier)
                .fillMaxWidth().padding(horizontal = 32.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (loading) {
                CircularProgressIndicator(color = c.accent, strokeWidth = 3.dp, modifier = Modifier.size(36.dp))
                Spacer(Modifier.height(20.dp))
            } else if (icon != null) {
                Illustration(icon, tint = iconTint)
                Spacer(Modifier.height(16.dp))
            }
            Text(title, style = MaterialTheme.typography.titleLarge, color = c.text, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 360.dp))
            if (body != null) {
                Spacer(Modifier.height(8.dp))
                Text(body, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 340.dp))
            }
            if (actionLabel != null && onAction != null) {
                Spacer(Modifier.height(24.dp))
                PrimaryButton(actionLabel, onAction, modifier = Modifier.widthIn(min = 200.dp))
            }
        }
    }
}

/**
 * The main call to action: the brand gradient with an accessible label colour, a 52dp target,
 * a ripple, a disabled state and an inline progress state.
 */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    @DrawableRes icon: Int? = null,
) {
    val c = MaterialTheme.lumenColors
    val dark = MaterialTheme.isDark
    val shape = RoundedCornerShape(LumenDimens.radiusMd)
    val fg = if (enabled) LumenBrand.onAction(dark) else c.textSubtle
    Box(
        modifier
            .heightIn(min = 52.dp)
            .clip(shape)
            .background(if (enabled) LumenBrand.action(dark) else SolidColor(c.surface3))
            .clickable(enabled = enabled && !loading, role = Role.Button, onClick = onClick)
            .then(if (loading) Modifier.semantics { contentDescription = text } else Modifier)
            .padding(horizontal = 20.dp, vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(22.dp), color = fg, strokeWidth = 2.5.dp)
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (icon != null) {
                    Icon(painterResource(icon), null, tint = fg, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(text, style = MaterialTheme.typography.labelLarge, color = fg, textAlign = TextAlign.Center)
            }
        }
    }
}

/** A small capsule label, such as "New · Built on Matrix" on the welcome screen. */
@Composable
fun Pill(text: String, modifier: Modifier = Modifier, @DrawableRes icon: Int? = null) {
    val c = MaterialTheme.lumenColors
    Row(
        modifier
            .clip(CircleShape)
            .background(c.surface.copy(alpha = 0.85f))
            .border(1.dp, LumenBrand.gradient, CircleShape)
            .padding(horizontal = 12.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(painterResource(icon), null, tint = c.accent, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(text, style = MaterialTheme.typography.labelMedium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A soft pulse for skeleton placeholders (Compose scales it with the system animator setting). */
@Composable
fun SkeletonBox(modifier: Modifier, shape: Shape = RoundedCornerShape(6.dp)) {
    val c = MaterialTheme.lumenColors
    val pulse by rememberInfiniteTransition(label = "skeleton").animateFloat(
        initialValue = 0.55f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "pulse",
    )
    Box(modifier.clip(shape).graphicsLayer { alpha = pulse }.background(c.surface3))
}

/** Placeholder rows while the room list loads (announced as loading to screen readers). */
@Composable
fun RoomListSkeleton(label: String) {
    Column(Modifier.fillMaxSize().semantics(mergeDescendants = true) { contentDescription = label }) {
        val widths = listOf(0.55f, 0.4f, 0.7f, 0.5f, 0.62f, 0.45f, 0.58f, 0.36f)
        widths.forEach { w ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                SkeletonBox(Modifier.size(52.dp), CircleShape)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    SkeletonBox(Modifier.fillMaxWidth(w).height(14.dp))
                    Spacer(Modifier.height(10.dp))
                    SkeletonBox(Modifier.fillMaxWidth(w + 0.25f).height(12.dp))
                }
            }
        }
    }
}

/** Placeholder bubbles while a chat opens. */
@Composable
fun TimelineSkeleton(label: String) {
    Column(
        Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 16.dp).semantics(mergeDescendants = true) { contentDescription = label },
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.Bottom),
    ) {
        listOf(0.6f to false, 0.45f to false, 0.5f to true, 0.7f to false, 0.38f to true, 0.55f to true).forEach { (w, own) ->
            Box(Modifier.fillMaxWidth(), contentAlignment = if (own) Alignment.CenterEnd else Alignment.CenterStart) {
                SkeletonBox(Modifier.fillMaxWidth(w).height(44.dp), RoundedCornerShape(18.dp))
            }
        }
    }
}

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.lumenColors.accent,
        modifier = modifier.padding(start = 16.dp, end = 16.dp, top = 24.dp, bottom = 8.dp).semantics { heading() },
    )
}

/** A titled group of rows on a rounded card: airy in light mode, a calm tonal step in dark mode. */
@Suppress("ModifierParameter") // the title is passed positionally
@Composable
fun SettingsGroup(title: String? = null, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.lumenColors
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        if (title != null) SectionHeader(title, Modifier.padding(start = 0.dp)) else Spacer(Modifier.height(16.dp))
        Surface(
            shape = MaterialTheme.shapes.large,
            color = c.surface,
            border = if (MaterialTheme.isDark) null else BorderStroke(1.dp, c.border),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(vertical = 4.dp), content = content)
        }
    }
}

/** A tinted rounded square behind a row icon. */
@Composable
fun IconTile(@DrawableRes icon: Int, tint: Color = MaterialTheme.lumenColors.accent, container: Color = MaterialTheme.lumenColors.accentSoft) {
    Box(Modifier.size(36.dp).clip(RoundedCornerShape(LumenDimens.radiusSm)).background(container), contentAlignment = Alignment.Center) {
        Icon(painterResource(icon), null, tint = tint, modifier = Modifier.size(20.dp))
    }
}

enum class RowEnd { NONE, CHEVRON, EXTERNAL }

@Suppress("ModifierParameter") // long-standing positional call sites
@Composable
fun SettingRow(
    title: String,
    subtitle: String? = null,
    @DrawableRes icon: Int? = null,
    onClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    tint: Color? = null,
    end: RowEnd = if (onClick != null) RowEnd.CHEVRON else RowEnd.NONE,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = MaterialTheme.lumenColors
    val color = tint ?: c.accent
    Row(
        modifier.fillMaxWidth()
            .heightIn(min = 56.dp)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            IconTile(icon, tint = color, container = if (tint != null) tint.copy(alpha = 0.12f) else c.accentSoft)
            Spacer(Modifier.width(14.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = if (tint != null && tint == c.danger) c.danger else c.text)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
        }
        when {
            trailing != null -> {
                Spacer(Modifier.width(12.dp))
                trailing()
            }
            end == RowEnd.CHEVRON -> {
                Spacer(Modifier.width(8.dp))
                Icon(painterResource(R.drawable.ic_lucide_chevron_right), null, tint = c.textSubtle, modifier = Modifier.size(18.dp))
            }
            end == RowEnd.EXTERNAL -> {
                Spacer(Modifier.width(8.dp))
                Icon(painterResource(R.drawable.ic_lucide_external_link), null, tint = c.textSubtle, modifier = Modifier.size(16.dp))
            }
            else -> Unit
        }
    }
}

@Composable
fun SwitchRow(title: String, subtitle: String?, checked: Boolean, enabled: Boolean = true, @DrawableRes icon: Int? = null, onChange: (Boolean) -> Unit) {
    val c = MaterialTheme.lumenColors
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(enabled = enabled, role = Role.Switch) { onChange(!checked) }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            IconTile(icon)
            Spacer(Modifier.width(14.dp))
        }
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
    val desc = pluralStringResource(R.plurals.cd_unread, count.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(), count) +
        if (mention) ", " + stringResource(R.string.cd_mentioned) else ""
    Row(Modifier.clearAndSetSemantics { contentDescription = desc }, verticalAlignment = Alignment.CenterVertically) {
        if (mention) {
            Box(Modifier.size(20.dp).clip(CircleShape).background(c.accent), contentAlignment = Alignment.Center) {
                Text("@", color = c.accentContrast, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            }
            Spacer(Modifier.width(4.dp))
        }
        Box(
            Modifier.heightIn(min = 20.dp).widthIn(min = 20.dp).clip(CircleShape).background(c.accent).padding(horizontal = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(label, color = c.accentContrast, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Clip)
        }
    }
}

/** The Lumen mark; [glow] adds the soft brand light behind it (welcome and lock screens). */
@Composable
fun LogoMark(size: Dp = 56.dp, glow: Boolean = false) {
    Box(contentAlignment = Alignment.Center, modifier = Modifier.size(if (glow) size * 1.8f else size)) {
        if (glow) {
            Canvas(Modifier.matchParentSize()) {
                val r = this.size.minDimension / 2
                drawCircle(Brush.radialGradient(listOf(LumenPalette.cyan400.copy(alpha = 0.28f), Color.Transparent), center = Offset(r * 0.85f, r * 0.9f), radius = r))
                drawCircle(Brush.radialGradient(listOf(LumenPalette.violet400.copy(alpha = 0.20f), Color.Transparent), center = Offset(r * 1.2f, r * 0.85f), radius = r * 0.8f))
                drawCircle(Brush.radialGradient(listOf(LumenPalette.peach400.copy(alpha = 0.18f), Color.Transparent), center = Offset(r, r * 1.3f), radius = r * 0.7f))
            }
        }
        Icon(
            painterResource(R.drawable.lumen_logo),
            contentDescription = null,
            tint = Color.Unspecified,
            modifier = Modifier.size(size).clip(RoundedCornerShape(LumenDimens.radiusLg)),
        )
    }
}

/** A rounded search field (48dp), with a clear button once something is typed. */
@Composable
fun SearchField(value: String, onValueChange: (String) -> Unit, placeholder: String, modifier: Modifier = Modifier) {
    val c = MaterialTheme.lumenColors
    androidx.compose.foundation.text.BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.text),
        cursorBrush = SolidColor(c.accent),
        modifier = modifier.heightIn(min = 48.dp),
        decorationBox = { field ->
            Row(
                Modifier.clip(CircleShape).background(c.surface2).heightIn(min = 48.dp).padding(start = 14.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(painterResource(R.drawable.ic_lucide_search), null, tint = c.textMuted, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Box(Modifier.weight(1f).padding(vertical = 12.dp)) {
                    if (value.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    field()
                }
                if (value.isNotEmpty()) {
                    androidx.compose.material3.IconButton(onClick = { onValueChange("") }) {
                        Icon(painterResource(R.drawable.ic_lucide_x), stringResource(R.string.action_clear), tint = c.textMuted, modifier = Modifier.size(18.dp))
                    }
                } else {
                    Spacer(Modifier.width(10.dp))
                }
            }
        },
    )
}
