import type { Room } from "matrix-js-sdk";
import { useClient } from "../../matrix/context";
import { useTypingMembers } from "../../hooks/matrix";

export function TypingIndicator({ room }: { room: Room }) {
  const client = useClient();
  const names = useTypingMembers(client, room);
  let text = "";
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else if (names.length > 2) text = `${names[0]} and ${names.length - 1} others are typing…`;
  return (
    <div className="typing" aria-live="polite">
      {text ? (
        <>
          <span className="typing-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>{text}</span>
        </>
      ) : null}
    </div>
  );
}
