package io.lumen.secure.ui.theme

import android.content.res.AssetManager
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.tween
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/** The app's two typefaces (both SIL OFL), with every weight a real instance of the variable font. */
@Immutable
class LumenFonts(val sans: FontFamily, val mono: FontFamily)

/**
 * Inter and JetBrains Mono are variable fonts. They are loaded from assets because only an asset
 * (or file) font gets its `wght` axis applied; a res/font resource renders every weight as Regular.
 */
fun lumenFonts(assets: AssetManager): LumenFonts {
    fun font(path: String, weight: FontWeight, style: FontStyle = FontStyle.Normal) = Font(
        path = path,
        assetManager = assets,
        weight = weight,
        style = style,
        variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
    )
    val sansWeights = listOf(FontWeight.Normal, FontWeight.Medium, FontWeight.SemiBold, FontWeight.Bold)
    val sans = FontFamily(
        sansWeights.map { font("fonts/inter_variable.ttf", it) } +
            sansWeights.map { font("fonts/inter_variable_italic.ttf", it, FontStyle.Italic) },
    )
    val mono = FontFamily(
        font("fonts/jetbrains_mono_variable.ttf", FontWeight.Normal),
        font("fonts/jetbrains_mono_variable.ttf", FontWeight.Medium),
        font("fonts/jetbrains_mono_variable.ttf", FontWeight.SemiBold),
    )
    return LumenFonts(sans, mono)
}

private val LocalLumenColors = staticCompositionLocalOf { LumenLightColors }
private val LocalLumenFonts = staticCompositionLocalOf<LumenFonts?> { null }
private val LocalLumenDark = staticCompositionLocalOf { false }

/** The design tokens (generated from design/tokens.css) for the current theme. */
val MaterialTheme.lumenColors: LumenColors
    @Composable @ReadOnlyComposable get() = LocalLumenColors.current

/** Inter and JetBrains Mono for the current theme. */
val MaterialTheme.lumenFonts: LumenFonts
    @Composable @ReadOnlyComposable get() = LocalLumenFonts.current ?: LumenFonts(FontFamily.Default, FontFamily.Monospace)

/** True while the dark palette is in use (the system setting, or the override in [LumenTheme]). */
val MaterialTheme.isDark: Boolean
    @Composable @ReadOnlyComposable get() = LocalLumenDark.current

private fun LumenColors.scheme(dark: Boolean): ColorScheme {
    val accentContainer = accentSoft.compositeOver(surface)
    val dangerContainer = dangerSoft.compositeOver(surface)
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = accent,
        onPrimary = accentContrast,
        primaryContainer = accentContainer,
        onPrimaryContainer = text,
        inversePrimary = accentHover,
        secondary = accent2,
        onSecondary = accentContrast,
        secondaryContainer = accentContainer,
        onSecondaryContainer = text,
        tertiary = accent3,
        onTertiary = accentContrast,
        tertiaryContainer = infoSoft.compositeOver(surface),
        onTertiaryContainer = text,
        background = bg,
        onBackground = text,
        surface = surface,
        onSurface = text,
        surfaceVariant = surface2,
        onSurfaceVariant = textMuted,
        surfaceTint = Color.Transparent,
        inverseSurface = surfaceInverse,
        inverseOnSurface = textInverse,
        error = danger,
        onError = dangerContrast,
        errorContainer = dangerContainer,
        onErrorContainer = text,
        outline = borderStrong,
        outlineVariant = border,
        scrim = Color.Black.copy(alpha = if (dark) 0.6f else 0.4f),
        surfaceBright = surface,
        surfaceDim = surface2,
        // Tonal elevation without shadows: each level is one step further from the background.
        surfaceContainerLowest = bgElevated,
        surfaceContainerLow = surface,
        surfaceContainer = surface,
        surfaceContainerHigh = if (dark) surface2 else surface,
        surfaceContainerHighest = surface3,
    )
}

/** Material 3 type scale set in Inter, with Inter's tighter tracking (Material's defaults suit Roboto). */
private fun typography(sans: FontFamily): Typography {
    val t = Typography()
    fun TextStyle.inter(weight: FontWeight, size: Int, line: Int, tracking: Double = 0.0) = copy(
        fontFamily = sans, fontWeight = weight, fontSize = size.sp, lineHeight = line.sp, letterSpacing = tracking.em,
    )
    return Typography(
        displayLarge = t.displayLarge.inter(FontWeight.SemiBold, 48, 56, -0.022),
        displayMedium = t.displayMedium.inter(FontWeight.SemiBold, 40, 48, -0.022),
        displaySmall = t.displaySmall.inter(FontWeight.SemiBold, 36, 44, -0.02),
        headlineLarge = t.headlineLarge.inter(FontWeight.SemiBold, 32, 40, -0.02),
        headlineMedium = t.headlineMedium.inter(FontWeight.SemiBold, 28, 36, -0.018),
        headlineSmall = t.headlineSmall.inter(FontWeight.SemiBold, 24, 32, -0.014),
        titleLarge = t.titleLarge.inter(FontWeight.SemiBold, 20, 28, -0.01),
        titleMedium = t.titleMedium.inter(FontWeight.SemiBold, 16, 24, -0.006),
        titleSmall = t.titleSmall.inter(FontWeight.Medium, 14, 20),
        bodyLarge = t.bodyLarge.inter(FontWeight.Normal, 16, 24, -0.006),
        bodyMedium = t.bodyMedium.inter(FontWeight.Normal, 14, 20),
        bodySmall = t.bodySmall.inter(FontWeight.Normal, 12, 16, 0.004),
        labelLarge = t.labelLarge.inter(FontWeight.SemiBold, 14, 20),
        labelMedium = t.labelMedium.inter(FontWeight.Medium, 12, 16, 0.004),
        labelSmall = t.labelSmall.inter(FontWeight.Medium, 11, 16, 0.01),
    )
}

private val shapes = Shapes(
    extraSmall = RoundedCornerShape(LumenDimens.radiusSm / 2),
    small = RoundedCornerShape(LumenDimens.radiusSm),
    medium = RoundedCornerShape(LumenDimens.radiusMd),
    large = RoundedCornerShape(LumenDimens.radiusLg),
    extraLarge = RoundedCornerShape(LumenDimens.radiusXl),
)

/** Motion tokens from design/tokens.css (--ease-out, --ease-spring, --dur-*). */
object LumenEase {
    val Out: Easing = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)

    /** A gentle overshoot, only for small moments of delight (sent, verified, joined). */
    val Spring: Easing = CubicBezierEasing(0.34f, 1.4f, 0.64f, 1f)

    fun <T> fast(): FiniteAnimationSpec<T> = tween(LumenMotion.durFastMillis, easing = Out)
    fun <T> med(): FiniteAnimationSpec<T> = tween(LumenMotion.durMedMillis, easing = Out)
    fun <T> slow(): FiniteAnimationSpec<T> = tween(LumenMotion.durSlowMillis, easing = Out)
}

/**
 * The brand gradients from design/tokens.css, re-expressed for Compose. Peach is decorative only:
 * it appears in background glows, never behind or as text.
 */
object LumenBrand {
    /** --brand-gradient (135deg cyan → teal 45% → violet): rings, accents and illustrations. */
    val gradient: Brush
        get() = Brush.linearGradient(
            0f to LumenPalette.cyan400, 0.45f to LumenPalette.teal400, 1f to LumenPalette.violet400,
            start = Offset.Zero, end = Offset.Infinite,
        )

    /**
     * The same gradient in deeper tones for filled primary actions: white text on it meets WCAG AA
     * in light mode; in dark mode the token gradient carries the dark accent-contrast text.
     */
    fun action(dark: Boolean): Brush = if (dark) {
        gradient
    } else {
        Brush.linearGradient(
            0f to LumenPalette.cyan700, 0.45f to LumenPalette.teal700, 1f to LumenPalette.violet700,
            start = Offset.Zero, end = Offset.Infinite,
        )
    }

    /** Text and icon colour on [action]. */
    fun onAction(dark: Boolean): Color = if (dark) LumenDarkColors.accentContrast else Color.White
}

private class Glow(val x: Float, val y: Float, val rx: Dp, val ry: Dp, val color: Color, val stop: Float)

private fun DrawScope.glow(g: Glow) {
    val center = Offset(size.width * g.x, size.height * g.y)
    val rx = g.rx.toPx()
    val ry = g.ry.toPx()
    clipRect {
        withTransform({ scale(scaleX = rx / ry, scaleY = 1f, pivot = center) }) {
            drawRect(
                Brush.radialGradient(0f to g.color, g.stop to g.color.copy(alpha = 0f), center = center, radius = ry),
                topLeft = Offset(center.x - ry * 2, center.y - ry * 2),
                size = Size(ry * 4, ry * 4),
            )
        }
    }
}

// --brand-wash: cyan from the top-left corner, peach from the bottom-right (sizes scaled for phones).
private val washGlows = listOf(
    Glow(0f, 0f, 420.dp, 240.dp, Color(0x1A5CD0E6), 0.6f),
    Glow(1f, 1f, 380.dp, 220.dp, Color(0x1AFFB391), 0.6f),
)

// --brand-hero: cyan, violet and a peach sunrise over midnight.
private val heroGlows = listOf(
    Glow(0.1f, -0.1f, 620.dp, 380.dp, Color(0x385CD0E6), 0.6f),
    Glow(0.95f, 0.1f, 480.dp, 320.dp, Color(0x338676F4), 0.6f),
    Glow(0.7f, 1.15f, 480.dp, 280.dp, Color(0x29FFB391), 0.65f),
)

/** The light, optimistic --brand-wash behind empty states and welcome screens. */
fun Modifier.brandWash(strength: Float = 1f): Modifier = drawBehind {
    washGlows.forEach { g -> glow(Glow(g.x, g.y, g.rx, g.ry, g.color.copy(alpha = g.color.alpha * strength), g.stop)) }
}

/** --brand-hero: the midnight gradient with its three glows (dark surfaces only). */
fun Modifier.brandHero(): Modifier = drawBehind {
    drawRect(Brush.verticalGradient(listOf(LumenPalette.midnight950, LumenPalette.midnight900)))
    heroGlows.forEach { glow(it) }
}

/**
 * Lumen brand theme. Dynamic colour is deliberately off: the brand palette from design/tokens.css
 * is used in light and dark mode.
 */
@Composable
fun LumenTheme(darkOverride: Boolean? = null, content: @Composable () -> Unit) {
    val dark = darkOverride ?: isSystemInDarkTheme()
    val colors = if (dark) LumenDarkColors else LumenLightColors
    val assets = LocalContext.current.assets
    val fonts = remember(assets) { lumenFonts(assets) }
    val typography = remember(fonts) { typography(fonts.sans) }
    CompositionLocalProvider(LocalLumenColors provides colors, LocalLumenFonts provides fonts, LocalLumenDark provides dark) {
        MaterialTheme(colorScheme = colors.scheme(dark), typography = typography, shapes = shapes, content = content)
    }
}
