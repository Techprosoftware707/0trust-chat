import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { type MatrixEvent, type Room } from "matrix-js-sdk";
import { FileUp, LockKeyhole, Paperclip, Pencil, Reply, SendHorizontal, ShieldOff, X } from "lucide-react";
import { useClient } from "../../matrix/context";
import { editContent, textContent } from "../../matrix/send";
import { UploadTooLargeError, uploadAttachment, type UploadHandle } from "../../matrix/media";
import { previewText } from "../../matrix/rooms";
import { formatBytes } from "../../lib/format";
import { errorMessage } from "../../lib/errors";
import { usePrefs } from "../../lib/prefs";
import { getDraft, setDraft } from "../../lib/drafts";
import { ProgressBar } from "../primitives/Spinner";

interface Upload {
  id: number;
  name: string;
  size: number;
  loaded: number;
  total: number;
  handle: UploadHandle;
  error?: string;
}

export interface ComposerHandle {
  attach: (files: FileList | File[]) => void;
  focus: () => void;
}

let uploadSeq = 0;

export const Composer = forwardRef<ComposerHandle, {
  room: Room;
  encrypted: boolean | null;
  replyTo: MatrixEvent | null;
  editing: MatrixEvent | null;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onEditLast: () => void;
}>(function Composer({ room, encrypted, replyTo, editing, onCancelReply, onCancelEdit, onEditLast }, ref) {
  const client = useClient();
  const prefs = usePrefs();
  const [text, setText] = useState(() => getDraft(room.roomId));
  const [uploads, setUploads] = useState<Upload[]>([]);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const typingSentAt = useRef(0);
  const me = client.getUserId() ?? "";

  // Keep drafts per room for this tab session (in memory only).
  useEffect(() => {
    setDraft(room.roomId, text);
  }, [room.roomId, text]);

  useEffect(() => {
    if (editing) {
      const body = (editing.getContent() as { body?: string }).body ?? "";
      setText(body);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(body.length, body.length);
      });
    }
  }, [editing]);
  useEffect(() => {
    if (replyTo) textarea.current?.focus();
  }, [replyTo]);

  // Auto-grow the textarea (style via CSSOM, allowed by the CSP).
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const stopTyping = useCallback(() => {
    if (typingSentAt.current) {
      typingSentAt.current = 0;
      client.sendTyping(room.roomId, false, 0).catch(() => undefined);
    }
  }, [client, room.roomId]);
  useEffect(() => stopTyping, [stopTyping]);

  const onChange = (value: string) => {
    setText(value);
    if (!prefs.sendTypingNotifications || editing) return;
    if (!value.trim()) return stopTyping();
    const now = Date.now();
    if (now - typingSentAt.current > 10_000) {
      typingSentAt.current = now;
      client.sendTyping(room.roomId, true, 15_000).catch(() => undefined);
    }
  };

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    // matrix-js-sdk sends to rooms it doesn't know about without encryption: never do that.
    if (client.getRoom(room.roomId) !== room) return;
    stopTyping();
    setText("");
    try {
      if (editing) {
        const id = editing.getId();
        onCancelEdit();
        const old = (editing.getContent() as { body?: string }).body;
        if (id && body !== old) await client.sendMessage(room.roomId, editContent(id, body) as never);
      } else {
        const replyId = replyTo?.getId() ?? null;
        onCancelReply();
        await client.sendMessage(room.roomId, textContent(body, replyId) as never);
      }
    } catch {
      // The failed local echo stays in the timeline with Retry / Cancel.
    }
  };

  const attach = useCallback(
    (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        const id = ++uploadSeq;
        const roomId = room.roomId;
        const enc = (async () => {
          // Encrypt if either the room state or the crypto layer says the room is encrypted
          // (the same rule the SDK applies to the event itself).
          if (room.hasEncryptionStateEvent()) return true;
          const crypto = client.getCrypto();
          return crypto ? crypto.isEncryptionEnabledInRoom(roomId) : false;
        })();
        // Decide on encryption from the crypto layer at upload time, never from stale UI state.
        void enc.then((isEncrypted) => {
          const handle = uploadAttachment(client, file, isEncrypted, (loaded, total) =>
            setUploads((us) => us.map((u) => (u.id === id ? { ...u, loaded, total } : u))),
          );
          setUploads((us) => [...us, { id, name: file.name, size: file.size, loaded: 0, total: file.size, handle }]);
          handle.promise
            .then(async (content) => {
              setUploads((us) => us.filter((u) => u.id !== id));
              await client.sendMessage(roomId, content as never).catch(() => undefined);
            })
            .catch((e: unknown) => {
              if (e instanceof DOMException && e.name === "AbortError") {
                setUploads((us) => us.filter((u) => u.id !== id));
                return;
              }
              const msg =
                e instanceof UploadTooLargeError
                  ? `${file.name} is ${formatBytes(file.size)}, but the server accepts files up to ${formatBytes(e.limit)}.`
                  : errorMessage(e, "Upload failed.");
              setUploads((us) => us.map((u) => (u.id === id ? { ...u, error: msg } : u)));
            });
        });
      }
    },
    [client, room],
  );

  useImperativeHandle(ref, () => ({ attach, focus: () => textarea.current?.focus() }), [attach]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape") {
      if (editing) {
        onCancelEdit();
        setText("");
      } else if (replyTo) onCancelReply();
    } else if (e.key === "ArrowUp" && !text && !editing) {
      e.preventDefault();
      onEditLast();
    }
  };

  const placeholder = encrypted === false ? "Message (not encrypted)…" : encrypted ? "Write an encrypted message…" : "Write a message…";
  const replyName = replyTo ? (replyTo.getSender() === me ? "yourself" : (room.getMember(replyTo.getSender() ?? "")?.name ?? replyTo.getSender())) : "";

  return (
    <div className="composer-wrap">
      {uploads.length > 0 ? (
        <ul className="uploads list-plain" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.id} className={`upload${u.error ? " error" : ""}`}>
              <FileUp aria-hidden="true" />
              <div className="upload-main">
                <span className="upload-name">{u.name}</span>
                {u.error ? (
                  <span className="upload-error" role="alert">
                    {u.error}
                  </span>
                ) : (
                  <>
                    <ProgressBar value={u.loaded} max={u.total || u.size} label={`Uploading ${u.name}`} />
                    <span className="upload-size">
                      {formatBytes(u.loaded)} of {formatBytes(u.total || u.size)}
                      {encrypted ? " · encrypted before upload" : ""}
                    </span>
                  </>
                )}
              </div>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label={u.error ? `Dismiss ${u.name}` : `Cancel upload of ${u.name}`}
                onClick={() => {
                  if (!u.error) u.handle.cancel();
                  setUploads((us) => us.filter((x) => x.id !== u.id));
                }}
              >
                <X aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {replyTo || editing ? (
        <div className="composer-context">
          {editing ? <Pencil aria-hidden="true" /> : <Reply aria-hidden="true" />}
          <div className="composer-context-text">
            <span className="composer-context-title">{editing ? "Editing message" : `Replying to ${replyName}`}</span>
            {replyTo ? <span className="composer-context-preview">{previewText(replyTo, "")}</span> : null}
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label={editing ? "Cancel editing" : "Cancel reply"}
            onClick={() => {
              if (editing) {
                onCancelEdit();
                setText("");
              } else onCancelReply();
            }}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <button type="button" className="icon-btn" aria-label="Attach files" title="Attach files" onClick={() => fileInput.current?.click()}>
          <Paperclip aria-hidden="true" />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) attach(e.target.files);
            e.target.value = "";
          }}
        />
        <label htmlFor="composer" className="visually-hidden">
          {placeholder}
        </label>
        <textarea
          id="composer"
          ref={textarea}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={stopTyping}
          onPaste={(e) => {
            const files = e.clipboardData?.files;
            if (files && files.length > 0) {
              e.preventDefault();
              attach(files);
            }
          }}
          aria-describedby="composer-hint"
        />
        <button type="submit" className="send-btn" aria-label={editing ? "Save edit" : "Send message"} disabled={!text.trim()}>
          <SendHorizontal aria-hidden="true" />
        </button>
      </form>
      <p id="composer-hint" className="composer-hint">
        {encrypted === false ? (
          <>
            <ShieldOff aria-hidden="true" /> Not encrypted: the server can read messages in this conversation.
          </>
        ) : encrypted ? (
          <>
            <LockKeyhole aria-hidden="true" /> End-to-end encrypted · Enter to send, Shift+Enter for a new line
          </>
        ) : (
          <>Enter to send, Shift+Enter for a new line</>
        )}
      </p>
    </div>
  );
});
