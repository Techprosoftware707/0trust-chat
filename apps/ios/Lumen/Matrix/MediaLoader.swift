import Foundation
import MatrixRustSDK

/// Loads attachment media for the timeline. The app uses `SDKMediaLoader`;
/// DEBUG screenshot previews use canned images.
@MainActor
protocol MediaLoading {
    /// Image bytes for display: the attachment's thumbnail when it has one,
    /// otherwise a server-side thumbnail of at most `maxWidth` x `maxHeight`.
    func imageData(for attachment: Attachment, maxWidth: UInt64, maxHeight: UInt64) async throws -> Data
    /// A local copy for Quick Look. `keepAlive` keeps the temporary file
    /// alive; hold it while the file is shown.
    func file(for attachment: Attachment) async throws -> (url: URL, keepAlive: AnyObject)
}

/// Fetches media through the Rust SDK, which decrypts encrypted attachments.
struct SDKMediaLoader: MediaLoading {
    let client: Client

    func imageData(for attachment: Attachment, maxWidth: UInt64, maxHeight: UInt64) async throws -> Data {
        if let thumb = attachment.thumbnailSource {
            return try await client.getMediaContent(mediaSource: thumb)
        }
        return try await client.getMediaThumbnail(mediaSource: attachment.source, width: maxWidth, height: maxHeight)
    }

    func file(for attachment: Attachment) async throws -> (url: URL, keepAlive: AnyObject) {
        let handle = try await client.getMediaFile(mediaSource: attachment.source, filename: attachment.filename, mimeType: attachment.mimeType ?? "application/octet-stream", useCache: true, tempDir: nil)
        return (URL(fileURLWithPath: try handle.path()), handle)
    }
}
