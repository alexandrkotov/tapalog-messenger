import { useRef, useState } from "preact/hooks";
import { ApiError } from "../api";
import { setAvatar } from "../state";
import { Avatar, errorText, useLang } from "./common";

/** A profile or group photo with "Change photo" and "Remove photo" under it. */
export function AvatarEditor({ name, id, photo, target, size = 96 }: { name: string; id: number; photo: string | null; target: "me" | { chat: number }; size?: number }) {
  const { s } = useLang();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const run = async (file: File | null) => {
    setBusy(true);
    setNote("");
    try {
      if ((await setAvatar(target, file)) === "unreadable") setNote(s.photoUnreadable);
    } catch (err) {
      setNote(errorText(s, err instanceof ApiError ? err.code : "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="avatar-editor">
      <Avatar name={name} id={id} photo={photo} size={size} />
      <span class="row-actions">
        <button type="button" class="link" disabled={busy} onClick={() => input.current?.click()} data-testid="change-photo">
          {s.changePhoto}
        </button>
        {photo && (
          <button type="button" class="link danger" disabled={busy} onClick={() => void run(null)} data-testid="remove-photo">
            {s.removePhoto}
          </button>
        )}
      </span>
      {note && (
        <small class="error" role="alert">
          {note}
        </small>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        data-testid="avatar-input"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) void run(file);
        }}
      />
    </div>
  );
}
