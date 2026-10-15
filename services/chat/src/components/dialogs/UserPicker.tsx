import { useEffect, useId, useState } from "react";
import { Search, X } from "lucide-react";
import { useMatrix } from "../../matrix/context";
import { normaliseUserIdInput } from "../../lib/matrix-id";
import { errorMessage } from "../../lib/errors";
import { Avatar } from "../primitives/Avatar";
import { Spinner } from "../primitives/Spinner";

export interface PickedUser {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
}

/**
 * Finds people via the homeserver's user directory (/user_directory/search)
 * or by typing a full Matrix ID.
 */
export function UserPicker({
  selected,
  onChange,
  multiple,
  label = "Find people",
  autoFocus = true,
  exclude = [],
}: {
  selected: PickedUser[];
  onChange: (users: PickedUser[]) => void;
  multiple: boolean;
  label?: string;
  autoFocus?: boolean;
  exclude?: string[];
}) {
  const { client, config, userId: me } = useMatrix();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<PickedUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    const q = term.trim();
    setError(null);
    if (q.length < 1) {
      setResults([]);
      return;
    }
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      client
        .searchUserDirectory({ term: q, limit: 10 })
        .then((res) => {
          if (!alive) return;
          setResults(res.results.map((r) => ({ userId: r.user_id, displayName: r.display_name, avatarUrl: r.avatar_url })));
        })
        .catch((e: unknown) => alive && setError(errorMessage(e, "Directory search failed.")))
        .finally(() => alive && setBusy(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [client, term]);

  const typedId = normaliseUserIdInput(term, config.homeserver.serverName);
  const skip = new Set([me, ...exclude, ...selected.map((s) => s.userId)]);
  const options = results.filter((r) => !skip.has(r.userId));
  if (typedId && !skip.has(typedId) && !options.some((o) => o.userId === typedId) && term.trim().length > 1) {
    options.push({ userId: typedId });
  }

  const pick = (u: PickedUser) => {
    onChange(multiple ? [...selected, u] : [u]);
    setTerm("");
  };

  return (
    <div className="user-picker">
      {multiple && selected.length > 0 ? (
        <ul className="picked list-plain" aria-label="Selected people">
          {selected.map((u) => (
            <li key={u.userId} className="picked-chip">
              <span>{u.displayName || u.userId}</span>
              <button type="button" aria-label={`Remove ${u.displayName || u.userId}`} onClick={() => onChange(selected.filter((s) => s.userId !== u.userId))}>
                <X aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <div className="search-box">
          <Search aria-hidden="true" />
          <input
            id={id}
            type="search"
            autoFocus={autoFocus}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={`Name or Matrix ID, e.g. @alice:${config.homeserver.serverName}`}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && options[0]) {
                e.preventDefault();
                pick(options[0]);
              }
            }}
            aria-controls={`${id}-list`}
          />
          {busy ? <Spinner size="sm" /> : null}
        </div>
      </div>
      {error ? <p className="form-error small">{error}</p> : null}
      {options.length > 0 ? (
        <ul id={`${id}-list`} className="list-plain user-results" aria-label="Matching people">
          {options.map((u) => (
            <li key={u.userId}>
              <button type="button" className="user-result" onClick={() => pick(u)}>
                <Avatar name={u.displayName || u.userId} seed={u.userId} mxc={u.avatarUrl} size={34} />
                <span className="user-result-text">
                  <span className="user-result-name">{u.displayName || u.userId}</span>
                  {u.displayName ? <span className="user-result-id">{u.userId}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : term.trim() && !busy ? (
        <p className="small muted">No matches. Enter a full Matrix ID like @name:server.</p>
      ) : null}
    </div>
  );
}
