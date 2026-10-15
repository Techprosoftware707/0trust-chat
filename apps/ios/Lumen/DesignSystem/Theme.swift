import SwiftUI

// Theme glue for the generated tokens (LumenTokens.swift, from
// design/tokens.css). Text uses the system font so Dynamic Type works; the
// token sizes are used for spacing and radii.

private struct LumenColorsKey: EnvironmentKey {
    static let defaultValue = LumenColors.light
}

extension EnvironmentValues {
    var lumen: LumenColors {
        get { self[LumenColorsKey.self] }
        set { self[LumenColorsKey.self] = newValue }
    }
}

private struct LumenThemeModifier: ViewModifier {
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        let colors = scheme == .dark ? LumenColors.dark : LumenColors.light
        content
            .environment(\.lumen, colors)
            .tint(colors.accent)
    }
}

extension View {
    func lumenTheme() -> some View { modifier(LumenThemeModifier()) }

    /// A card surface with the token radius and border.
    func lumenCard() -> some View { modifier(CardModifier()) }
}

private struct CardModifier: ViewModifier {
    @Environment(\.lumen) private var c
    func body(content: Content) -> some View {
        content
            .padding(LumenDimens.space4)
            .background(c.surface, in: RoundedRectangle(cornerRadius: LumenDimens.radiusLg, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: LumenDimens.radiusLg, style: .continuous).strokeBorder(c.border))
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.lumen) private var c
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, LumenDimens.space4)
            .foregroundStyle(c.accentContrast)
            .background(
                RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous)
                    .fill(configuration.isPressed ? c.accentHover : c.accent)
            )
            .opacity(enabled ? 1 : 0.5)
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.lumen) private var c
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 46)
            .padding(.horizontal, LumenDimens.space4)
            .foregroundStyle(c.text)
            .background(
                RoundedRectangle(cornerRadius: LumenDimens.radiusMd, style: .continuous)
                    .fill(configuration.isPressed ? c.surface3 : c.surface2)
            )
    }
}

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
