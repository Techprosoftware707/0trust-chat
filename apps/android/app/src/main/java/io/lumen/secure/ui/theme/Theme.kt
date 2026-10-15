package io.lumen.secure.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.lumen.secure.R

/** Inter (OFL) as a variable font: each weight is an instance of the same file. */
val InterFamily = FontFamily(
    Font(R.font.inter_variable, FontWeight.Normal),
    Font(R.font.inter_variable, FontWeight.Medium),
    Font(R.font.inter_variable, FontWeight.SemiBold),
    Font(R.font.inter_variable, FontWeight.Bold),
    Font(R.font.inter_variable_italic, FontWeight.Normal, FontStyle.Italic),
)

/** JetBrains Mono (OFL), used for recovery keys and identifiers. */
val MonoFamily = FontFamily(
    Font(R.font.jetbrains_mono_variable, FontWeight.Normal),
    Font(R.font.jetbrains_mono_variable, FontWeight.SemiBold),
)

private val LocalLumenColors = staticCompositionLocalOf { LumenLightColors }

/** The design tokens (generated from design/tokens.css) for the current theme. */
val MaterialTheme.lumenColors: LumenColors
    @Composable @ReadOnlyComposable get() = LocalLumenColors.current

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
        secondaryContainer = surface3,
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
        onError = if (dark) bg else Color.White,
        errorContainer = dangerContainer,
        onErrorContainer = text,
        outline = borderStrong,
        outlineVariant = border,
        scrim = Color.Black.copy(alpha = 0.5f),
        surfaceBright = surface,
        surfaceDim = surface2,
        surfaceContainerLowest = bgElevated,
        surfaceContainerLow = surface,
        surfaceContainer = surface2,
        surfaceContainerHigh = surface2,
        surfaceContainerHighest = surface3,
    )
}

private fun typography(): Typography {
    val t = Typography()
    fun TextStyle.inter(weight: FontWeight? = null) = copy(fontFamily = InterFamily, fontWeight = weight ?: fontWeight)
    return Typography(
        displayLarge = t.displayLarge.inter(FontWeight.SemiBold).copy(letterSpacing = (-0.022).em),
        displayMedium = t.displayMedium.inter(FontWeight.SemiBold).copy(letterSpacing = (-0.022).em),
        displaySmall = t.displaySmall.inter(FontWeight.SemiBold),
        headlineLarge = t.headlineLarge.inter(FontWeight.SemiBold),
        headlineMedium = t.headlineMedium.inter(FontWeight.SemiBold).copy(fontSize = LumenDimens.text2xl),
        headlineSmall = t.headlineSmall.inter(FontWeight.SemiBold).copy(fontSize = LumenDimens.textXl),
        titleLarge = t.titleLarge.inter(FontWeight.SemiBold).copy(fontSize = LumenDimens.textXl),
        titleMedium = t.titleMedium.inter(FontWeight.SemiBold).copy(fontSize = LumenDimens.textMd),
        titleSmall = t.titleSmall.inter(FontWeight.Medium).copy(fontSize = LumenDimens.textSm),
        bodyLarge = t.bodyLarge.inter().copy(fontSize = LumenDimens.textMd, lineHeight = 24.sp),
        bodyMedium = t.bodyMedium.inter().copy(fontSize = LumenDimens.textSm, lineHeight = 21.sp),
        bodySmall = t.bodySmall.inter().copy(fontSize = LumenDimens.textXs),
        labelLarge = t.labelLarge.inter(FontWeight.Medium).copy(fontSize = LumenDimens.textSm),
        labelMedium = t.labelMedium.inter(FontWeight.Medium).copy(fontSize = LumenDimens.textXs),
        labelSmall = t.labelSmall.inter(FontWeight.Medium),
    )
}

private val shapes = Shapes(
    extraSmall = RoundedCornerShape(LumenDimens.radiusSm / 2),
    small = RoundedCornerShape(LumenDimens.radiusSm),
    medium = RoundedCornerShape(LumenDimens.radiusMd),
    large = RoundedCornerShape(LumenDimens.radiusLg),
    extraLarge = RoundedCornerShape(LumenDimens.radiusXl),
)

/**
 * Lumen brand theme. Dynamic colour is deliberately off: the brand palette from design/tokens.css
 * is used in light and dark mode.
 */
@Composable
fun LumenTheme(darkOverride: Boolean? = null, content: @Composable () -> Unit) {
    val dark = darkOverride ?: isSystemInDarkTheme()
    val colors = if (dark) LumenDarkColors else LumenLightColors
    CompositionLocalProvider(LocalLumenColors provides colors) {
        MaterialTheme(colorScheme = colors.scheme(dark), typography = typography(), shapes = shapes, content = content)
    }
}
