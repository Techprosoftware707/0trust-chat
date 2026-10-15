import { useEffect, useRef, useState } from "react";
import { Download, FileText, ImageOff, LoaderCircle, Play } from "lucide-react";
import type { MatrixEvent } from "matrix-js-sdk";
import { useClient } from "../../matrix/context";
import { downloadMedia, inlineKind, saveBlob, type EncryptedFile, type MediaInfo } from "../../matrix/media";
import { formatBytes } from "../../lib/format";
import { errorMessage } from "../../lib/errors";

interface Content {
  msgtype?: string;
  body?: string;
  filename?: string;
  url?: string;
  file?: EncryptedFile;
  info?: MediaInfo;
}

const MAX_W = 360;
const MAX_H = 320;

function boxFor(info: MediaInfo | undefined): { width: number; height: number } | null {
  if (!info?.w || !info?.h || info.w <= 0 || info.h <= 0) return null;
  const scale = Math.min(1, MAX_W / info.w, MAX_H / info.h);
  return { width: Math.max(48, Math.round(info.w * scale)), height: Math.max(48, Math.round(info.h * scale)) };
}

/**
 * Image/video/audio/file attachment. Media is downloaded with the access token
 * (authenticated media), decrypted in the browser if it is encrypted, and shown
 * via a blob: URL that is revoked when the message leaves the screen.
 */
export function Attachment({ event }: { event: MatrixEvent }) {
  const client = useClient();
  const c = event.getContent() as Content;
  const name = c.filename || c.body || "file";
  const mimetype = c.info?.mimetype;
  const kind = event.getType() === "m.sticker" ? "image" : c.msgtype === "m.file" ? null : inlineKind(mimetype);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [mediaRequested, setMediaRequested] = useState(kind === "image");
  const urlRef = useRef<string | null>(null);
  const encrypted = !!c.file;

  useEffect(() => {
    if (!mediaRequested || !kind) return;
    const ctrl = new AbortController();
    setState("loading");
    downloadMedia(client, { url: c.url, file: c.file }, mimetype, ctrl.signal)
      .then((blob) => {
        const u = URL.createObjectURL(blob);
        urlRef.current = u;
        setBlobUrl(u);
        setState("idle");
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(errorMessage(e, "Couldn't load this file."));
        setState("error");
      });
    return () => {
      ctrl.abort();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      setBlobUrl(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, mediaRequested, kind, c.url, c.file?.url]);

  const download = async () => {
    setState("loading");
    try {
      const blob = await downloadMedia(client, { url: c.url, file: c.file }, mimetype);
      saveBlob(blob, name);
      setState("idle");
    } catch (e) {
      setError(errorMessage(e, "Download failed."));
      setState("error");
    }
  };

  const meta = (
    <span className="att-meta">
      {formatBytes(c.info?.size)}
      {encrypted ? " · encrypted" : ""}
    </span>
  );

  if (kind === "image") {
    const box = boxFor(c.info);
    return (
      <figure className="att att-image">
        <div className="att-image-frame" style={box ?? { width: 240, height: 160 }}>
          {blobUrl ? (
            <img src={blobUrl} alt={name} width={box?.width} height={box?.height} />
          ) : state === "error" ? (
            <span className="att-placeholder" role="img" aria-label={error ?? "Image unavailable"}>
              <ImageOff aria-hidden="true" />
            </span>
          ) : (
            <span className="att-placeholder" role="status" aria-label={encrypted ? "Decrypting image" : "Loading image"}>
              <LoaderCircle aria-hidden="true" className="spin" />
            </span>
          )}
        </div>
        <figcaption className="att-caption">
          <span className="att-name">{name}</span> {meta}
          <button type="button" className="icon-btn icon-btn-sm" onClick={download} aria-label={`Download ${name}`} title="Download">
            <Download aria-hidden="true" />
          </button>
        </figcaption>
        {state === "error" && error ? (
          <p className="att-error" role="alert">
            {error}
          </p>
        ) : null}
      </figure>
    );
  }

  if ((kind === "video" || kind === "audio") && mediaRequested && blobUrl) {
    return (
      <figure className={`att att-${kind}`}>
        {kind === "video" ? <video src={blobUrl} controls preload="metadata" /> : <audio src={blobUrl} controls preload="metadata" />}
        <figcaption className="att-caption">
          <span className="att-name">{name}</span> {meta}
        </figcaption>
      </figure>
    );
  }

  return (
    <div className="att att-file">
      <span className="att-file-icon" aria-hidden="true">
        <FileText />
      </span>
      <span className="att-file-text">
        <span className="att-name">{name}</span>
        {meta}
        {state === "error" && error ? (
          <span className="att-error" role="alert">
            {error}
          </span>
        ) : null}
      </span>
      {kind === "video" || kind === "audio" ? (
        <button type="button" className="btn btn-sm" onClick={() => setMediaRequested(true)} disabled={state === "loading"}>
          {state === "loading" ? <LoaderCircle aria-hidden="true" className="spin" /> : <Play aria-hidden="true" />} Play
        </button>
      ) : null}
      <button type="button" className="btn btn-sm" onClick={download} disabled={state === "loading"} aria-label={`Download ${name}`}>
        {state === "loading" && !(kind === "video" || kind === "audio") ? <LoaderCircle aria-hidden="true" className="spin" /> : <Download aria-hidden="true" />}
        <span className="hide-narrow">Download</span>
      </button>
    </div>
  );
}
