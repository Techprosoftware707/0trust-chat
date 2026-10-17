import SwiftUI

// Theme glue for the generated tokens (LumenTokens.swift, from
// design/tokens.css). Text uses the system text styles so Dynamic Type and
// Bold Text work; the token sizes are used for spacing and radii. The brand
// gradients (--brand-gradient, --brand-hero, --brand-wash) are re-expressed
// here by hand.

/// The colours for the current appearance, read like `LumenColors`
/// (`c.accent`). With Increase Contrast, subtle text and hairlines are drawn
/// with their stronger tokens.
@dynamicMemberLookup
struct LumenTheme {
    let colors: LumenColors
    let isDark: Bool
    let increasedContrast: Bool

    subscript(dynamicMember key: KeyPath<LumenColors, Color>) -> Color {
        guard increasedContrast else { return colors[keyPath: key] }
        if key == \LumenColors.textSubtle { return colors.textMuted }
        if key == \LumenColors.border { return colors.borderStrong }
        return colors[keyPath: key]
    }

    static let light = LumenTheme(colors: .light, isDark: false, increasedContrast: false)

    /// Fill of primary actions: the accent with a soft shift towards the
    /// third brand colour. Labels on it keep AA contrast in both themes.
    var actionFill: LinearGradient {
        LinearGradient(colors: [colors.accent, colors.accent, colors.accent3], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    /// --brand-gradient (decorative: rings, glyph backgrounds; never behind text).
    var brandGradient: LinearGradient {
        LinearGradient(colors: [LumenPalette.cyan400, LumenPalette.teal400, LumenPalette.violet400], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    /// A soft card shadow (--shadow-sm in light mode; none in dark mode).
    var cardShadow: Color { isDark ? .clear : Color(.sRGB, red: 0.04, green: 0.09, blue: 0.19, opacity: 0.06) }
}

private struct LumenThemeKey: EnvironmentKey {
    static let defaultValue = LumenTheme.light
}

extension EnvironmentValues {
    var lumen: LumenTheme {
        get { self[LumenThemeKey.self] }
        set { self[LumenThemeKey.self] = newValue }
    }
}

private struct LumenThemeModifier: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        let dark = scheme == .dark
        let theme = LumenTheme(colors: dark ? .dark : .light, isDark: dark, increasedContrast: contrast == .increased)
        content
            .environment(\.lumen, theme)
            .tint(theme.accent)
    }
}

extension View {
    func lumenTheme() -> some View { modifier(LumenThemeModifier()) }

    /// A card surface with the token radius, a hairline and a soft shadow.
    func lumenCard(padding: CGFloat = LumenDimens.space4) -> some View { modifier(CardModifier(padding: padding)) }

    /// The screen background with the light brand wash.
    func lumenScreenBackground() -> some View { background { BrandWash().ignoresSafeArea() } }
}

private struct CardModifier: ViewModifier {
    let padding: CGFloat
    @Environment(\.lumen) private var c

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(c.surface, in: RoundedRectangle(cornerRadius: LumenDimens.radiusLg, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LumenDimens.radiusLg, style: .continuous).strokeBorder(c.border))
            .shadow(color: c.cardShadow, radius: 8, x: 0, y: 3)
    }
}

// MARK: - Backgrounds

/// --brand-wash: a light, optimistic glow (cyan at the top, warm peach at
/// the bottom) over the page background, for onboarding and empty states.
struct BrandWash: View {
    @Environment(\.lumen) private var c

    var body: some View {
        let strength = c.isDark ? 0.16 : 0.12
        ZStack {
            c.bg
            RadialGradient(colors: [LumenPalette.cyan400.opacity(strength), .clear], center: UnitPoint(x: 0, y: 0), startRadius: 0, endRadius: 480)
            RadialGradient(colors: [LumenPalette.peach400.opacity(strength), .clear], center: UnitPoint(x: 1, y: 1), startRadius: 0, endRadius: 420)
        }
        .accessibilityHidden(true)
    }
}

/// --brand-hero: midnight with cyan, violet and a warm sunrise glow. Used
/// behind the welcome and lock screens in dark mode.
struct BrandHero: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [LumenPalette.midnight950, LumenPalette.midnight900], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [LumenPalette.cyan400.opacity(0.22), .clear], center: UnitPoint(x: 0.1, y: -0.1), startRadius: 0, endRadius: 520)
            RadialGradient(colors: [LumenPalette.violet500.opacity(0.20), .clear], center: UnitPoint(x: 0.95, y: 0.1), startRadius: 0, endRadius: 420)
            RadialGradient(colors: [LumenPalette.peach400.opacity(0.16), .clear], center: UnitPoint(x: 0.7, y: 1.15), startRadius: 0, endRadius: 460)
        }
        .accessibilityHidden(true)
    }
}

/// The welcome/lock background: the airy wash in light mode, the hero in dark mode.
struct WelcomeBackground: View {
    @Environment(\.lumen) private var c
    var body: some View {
        if c.isDark { BrandHero() } else { BrandWash() }
    }
}

// MARK: - Buttons

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.lumen) private var c
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let destructive = configuration.role == .destructive
        let shape = RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous)
        return configuration.label
            .font(.body.weight(.semibold))
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, LumenDimens.space4)
            .foregroundStyle(enabled ? (destructive ? c.dangerContrast : c.accentContrast) : c.textMuted)
            .background {
                if !enabled {
                    shape.fill(c.surface3)
                } else if destructive {
                    shape.fill(c.danger)
                } else {
                    shape.fill(c.actionFill)
                }
            }
            .overlay { shape.fill(Color.black.opacity(configuration.isPressed ? 0.10 : 0)) }
            .contentShape(shape)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.easeOut(duration: LumenMotion.durFast), value: configuration.isPressed)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.lumen) private var c
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let destructive = configuration.role == .destructive
        let shape = RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous)
        return configuration.label
            .font(.body.weight(.medium))
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, LumenDimens.space4)
            .foregroundStyle(enabled ? (destructive ? c.danger : c.text) : c.textSubtle)
            .background(shape.fill(configuration.isPressed ? c.surface3 : c.surface2))
            .overlay(shape.strokeBorder(c.border))
            .contentShape(shape)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.easeOut(duration: LumenMotion.durFast), value: configuration.isPressed)
    }
}

/// A small capsule button (chips, inline actions in banners and rows).
struct ChipButtonStyle: ButtonStyle {
    var prominent = false
    @Environment(\.lumen) private var c

    func makeBody(configuration: Configuration) -> some View {
        let destructive = configuration.role == .destructive
        return configuration.label
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, LumenDimens.space3)
            .frame(minHeight: 36)
            .foregroundStyle(prominent ? c.accentContrast : (destructive ? c.danger : c.accent))
            .background(Capsule().fill(prominent ? c.accent : (destructive ? c.dangerSoft : c.accentSoft)))
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(Capsule())
    }
}

// MARK: - Brand mark

/// The Lumen mark (branding/logo.svg), drawn as vectors.
struct BrandMark: View {
    var size: CGFloat = 44

    var body: some View {
        Canvas { ctx, sz in
            let s = sz.width / 64
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }
            let gradient = Gradient(stops: [
                .init(color: LumenPalette.cyan400, location: 0),
                .init(color: LumenPalette.teal400, location: 0.55),
                .init(color: LumenPalette.violet500, location: 1),
            ])
            ctx.fill(Path(roundedRect: CGRect(x: 2 * s, y: 2 * s, width: 60 * s, height: 60 * s), cornerRadius: 18 * s, style: .continuous),
                     with: .color(LumenPalette.midnight900))
            ctx.fill(Path(ellipseIn: CGRect(x: 26 * s, y: 6 * s, width: 32 * s, height: 32 * s)),
                     with: .radialGradient(Gradient(colors: [LumenPalette.cyan300.opacity(0.55), LumenPalette.cyan300.opacity(0)]),
                                           center: p(42, 22), startRadius: 0, endRadius: 16 * s))
            var path = Path()
            path.move(to: p(21, 16))
            path.addLine(to: p(21, 38.5))
            path.addArc(tangent1End: p(21, 48), tangent2End: p(46, 48), radius: 9.5 * s)
            path.addLine(to: p(46, 48))
            let shading = GraphicsContext.Shading.linearGradient(gradient, startPoint: p(10, 8), endPoint: p(56, 58))
            ctx.stroke(path, with: shading, style: StrokeStyle(lineWidth: 7 * s, lineCap: .round, lineJoin: .round))
            ctx.fill(Path(ellipseIn: CGRect(x: 36.5 * s, y: 16.5 * s, width: 11 * s, height: 11 * s)), with: shading)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The mark with a soft glow, for welcome, launch and lock screens.
struct BrandMarkHero: View {
    var size: CGFloat = 76

    var body: some View {
        BrandMark(size: size)
            .shadow(color: LumenPalette.cyan400.opacity(0.35), radius: size * 0.28, x: 0, y: size * 0.08)
            .shadow(color: LumenPalette.peach400.opacity(0.18), radius: size * 0.4, x: size * 0.15, y: size * 0.25)
    }
}

// MARK: - Motion

extension Animation {
    /// Ease-out for state changes (--ease-out, --dur-med).
    static var lumenEaseOut: Animation { .easeOut(duration: LumenMotion.durMed) }
    /// A gentle spring for small moments of delight (sent, verified, joined).
    static var lumenSpring: Animation { .spring(response: LumenMotion.durSlow, dampingFraction: 0.72) }
}
