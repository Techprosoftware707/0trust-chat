/**
 * Attachments and avatars.
 *
 * Encrypted rooms: files are encrypted in the browser with the spec'd
 * AES-CTR scheme (matrix-encrypt-attachment, WebCrypto) before upload; the
 * key, IV and SHA-256 travel inside the end-to-end encrypted event.
 * Downloads always use authenticated media (Authorization header) and are
 * decrypted locally; previews use short-lived blob: URLs.
 */
import type { MatrixClient } from "matrix-js-sdk";
import { decryptAttachment, encryptAttachment, type IEncryptedFile } from "matrix-encrypt-attachment";

export interface EncryptedFile extends IEncryptedFile {
  url: string;
}

export interface MediaInfo {
  mimetype?: string;
  size?: number;
  w?: number;
  h?: number;
  duration?: number;
}

export interface AttachmentContent {
  msgtype: "m.image" | "m.file" | "m.video" | "m.audio";
  body: string;
  filename: string;
  info: MediaInfo;
  url?: string;
  file?: EncryptedFile;
}

/** Raster image types we preview inline (never SVG or HTML). */
const INLINE_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const INLINE_VIDEO = new Set(["video/mp4", "video/webm", "video/ogg"]);
const INLINE_AUDIO = new Set(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm", "audio/wav", "audio/aac", "audio/flac"]);

export function inlineKind(mime: string | undefined): "image" | "video" | "audio" | null {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  if (INLINE_IMAGE.has(m)) return "image";
  if (INLINE_VIDEO.has(m)) return "video";
  if (INLINE_AUDIO.has(m)) return "audio";
  return null;
}

export function msgtypeFor(mime: string): AttachmentContent["msgtype"] {
  const kind = inlineKind(mime);
  return kind === "image" ? "m.image" : kind === "video" ? "m.video" : kind === "audio" ? "m.audio" : "m.file";
}

export class UploadTooLargeError extends Error {
  override name = "UploadTooLargeError";
  constructor(readonly limit: number) {
    super("File too large");
  }
}

let uploadLimit: { client: MatrixClient; value: Promise<number | null> } | null = null;

/** The server's upload size limit (`m.upload.size` from /_matrix/client/v1/media/config). */
export function getUploadLimit(client: MatrixClient): Promise<number | null> {
  if (!uploadLimit || uploadLimit.client !== client) {
    const value = client
      .getMediaConfig(true)
      .then((c) => (typeof c["m.upload.size"] === "number" ? c["m.upload.size"] : null))
      .catch(() => {
        uploadLimit = null; // retry next time
        return null;
      });
    uploadLimit = { client, value };
  }
  return uploadLimit.value;
}

async function imageDimensions(file: Blob): Promise<{ w: number; h: number } | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bmp = await createImageBitmap(file);
    const d = { w: bmp.width, h: bmp.height };
    bmp.close();
    return d;
  } catch {
    return null;
  }
}

export interface UploadHandle {
  promise: Promise<AttachmentContent>;
  cancel: () => void;
}

/**
 * Prepares and uploads an attachment. Returns the event content to send.
 * `encrypt` must be true for rooms with encryption enabled.
 */
export function uploadAttachment(
  client: MatrixClient,
  file: File,
  encrypt: boolean,
  onProgress: (loaded: number, total: number) => void,
): UploadHandle {
  let cancelled = false;
  let upload: ReturnType<MatrixClient["uploadContent"]> | null = null;
  const promise = (async (): Promise<AttachmentContent> => {
    const limit = await getUploadLimit(client);
    if (limit !== null && file.size > limit) throw new UploadTooLargeError(limit);
    const mimetype = file.type || "application/octet-stream";
    const info: MediaInfo = { mimetype, size: file.size };
    const msgtype = msgtypeFor(mimetype);
    if (msgtype === "m.image") {
      const dims = await imageDimensions(file);
      if (dims) Object.assign(info, dims);
    }
    const name = file.name || "file";
    if (cancelled) throw new DOMException("Upload cancelled", "AbortError");
    const progressHandler = ({ loaded, total }: { loaded: number; total: number }) => onProgress(loaded, total);
    if (encrypt) {
      const { data, info: keyInfo } = await encryptAttachment(await file.arrayBuffer());
      if (cancelled) throw new DOMException("Upload cancelled", "AbortError");
      upload = client.uploadContent(new Blob([data], { type: "application/octet-stream" }), {
        type: "application/octet-stream",
        includeFilename: false,
        progressHandler,
      });
      const { content_uri } = await upload;
      return { msgtype, body: name, filename: name, info, file: { ...keyInfo, url: content_uri } };
    }
    upload = client.uploadContent(file, { type: mimetype, name, progressHandler });
    const { content_uri } = await upload;
    return { msgtype, body: name, filename: name, info, url: content_uri };
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (upload) client.cancelUpload(upload);
    },
  };
}

function authHeaders(client: MatrixClient): HeadersInit {
  const token = client.getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Authenticated media URL (/_matrix/client/v1/media/...). */
export function mediaUrl(client: MatrixClient, mxc: string, thumb?: { w: number; h: number; method?: "crop" | "scale" }): string | null {
  if (!mxc.startsWith("mxc://")) return null;
  return client.mxcUrlToHttp(mxc, thumb?.w, thumb?.h, thumb?.method, false, true, true);
}

export class MediaError extends Error {
  override name = "MediaError";
}

/**
 * Downloads media with the access token and, for encrypted attachments,
 * verifies the SHA-256 and decrypts it locally. The returned Blob carries
 * `mimetype` only if it is a type we are willing to render inline.
 */
export async function downloadMedia(
  client: MatrixClient,
  src: { url?: string; file?: EncryptedFile },
  mimetype: string | undefined,
  signal?: AbortSignal,
): Promise<Blob> {
  const mxc = src.file?.url ?? src.url;
  const url = mxc ? mediaUrl(client, mxc) : null;
  if (!url) throw new MediaError("This attachment has no valid media URL.");
  const res = await fetch(url, { headers: authHeaders(client), signal, credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new MediaError(res.status === 404 ? "This file is no longer available." : `Download failed (HTTP ${res.status}).`);
  const buf = await res.arrayBuffer();
  const safeType = inlineKind(mimetype) ? (mimetype as string).split(";")[0] : "application/octet-stream";
  if (src.file) {
    let plain: ArrayBuffer;
    try {
      plain = await decryptAttachment(buf, src.file);
    } catch {
      throw new MediaError("This file couldn't be decrypted: it may have been tampered with.");
    }
    return new Blob([plain], { type: safeType });
  }
  return new Blob([buf], { type: safeType });
}

// --- Avatar thumbnails (authenticated, cached for the session) -------------

const thumbCache = new Map<string, Promise<string | null>>();

export function avatarBlobUrl(client: MatrixClient, mxc: string, size: number): Promise<string | null> {
  const url = mediaUrl(client, mxc, { w: size, h: size, method: "crop" });
  if (!url) return Promise.resolve(null);
  let p = thumbCache.get(url);
  if (!p) {
    p = fetch(url, { headers: authHeaders(client), credentials: "omit" })
      .then(async (r) => {
        if (!r.ok) return null;
        const blob = await r.blob();
        if (!inlineKind(blob.type)) return null;
        return URL.createObjectURL(new Blob([blob], { type: blob.type }));
      })
      .catch(() => {
        thumbCache.delete(url);
        return null;
      });
    thumbCache.set(url, p);
  }
  return p;
}

export function clearMediaCache(): void {
  for (const p of thumbCache.values()) {
    void p.then((u) => u && URL.revokeObjectURL(u));
  }
  thumbCache.clear();
  uploadLimit = null;
}

/** Triggers a browser download of `blob` as `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safe = Array.from(filename, (c) => (c.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(c) ? "_" : c)).join("");
  a.download = safe.slice(0, 200) || "download";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
