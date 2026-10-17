#if DEBUG
import SwiftUI
import UIKit

/// Draws stand-in pictures for image attachments in screenshot mode (no
/// media server). Files can't be opened.
@MainActor
struct PreviewMediaLoader: MediaLoading {
    func imageData(for attachment: Attachment, maxWidth: UInt64, maxHeight: UInt64) async throws -> Data {
        let w = CGFloat(attachment.width ?? 1200)
        let h = CGFloat(attachment.height ?? 900)
        let size = CGSize(width: 600, height: (600 * h / max(w, 1)).rounded())
        let warm = attachment.filename.hasPrefix("Harbour")
        let top = warm ? UIColor(red: 1.0, green: 0.70, blue: 0.57, alpha: 1) : UIColor(red: 0.36, green: 0.82, blue: 0.90, alpha: 1)
        let bottom = warm ? UIColor(red: 0.33, green: 0.26, blue: 0.79, alpha: 1) : UIColor(red: 0.07, green: 0.57, blue: 0.50, alpha: 1)
        let image = UIGraphicsImageRenderer(size: size).image { ctx in
            let cg = ctx.cgContext
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [top.cgColor, bottom.cgColor] as CFArray, locations: [0, 1]) {
                cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width * 0.4, y: size.height), options: [])
            }
            UIColor.white.withAlphaComponent(0.35).setFill()
            cg.fillEllipse(in: CGRect(x: size.width * 0.62, y: size.height * 0.14, width: size.width * 0.22, height: size.width * 0.22))
            let hills = UIBezierPath()
            hills.move(to: CGPoint(x: 0, y: size.height * 0.78))
            hills.addCurve(to: CGPoint(x: size.width, y: size.height * 0.70),
                           controlPoint1: CGPoint(x: size.width * 0.35, y: size.height * 0.55),
                           controlPoint2: CGPoint(x: size.width * 0.65, y: size.height * 0.92))
            hills.addLine(to: CGPoint(x: size.width, y: size.height))
            hills.addLine(to: CGPoint(x: 0, y: size.height))
            hills.close()
            UIColor.black.withAlphaComponent(0.18).setFill()
            hills.fill()
        }
        guard let data = image.pngData() else { throw SDKUnavailableError() }
        return data
    }

    func file(for attachment: Attachment) async throws -> (url: URL, keepAlive: AnyObject) {
        throw SDKUnavailableError()
    }
}
#endif
