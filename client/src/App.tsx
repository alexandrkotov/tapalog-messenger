import { useEffect } from "preact/hooks";
import { match, usePath } from "./router";
import { boot, useAppState } from "./state";
import { AlreadySignedIn, Login, Register } from "./ui/Auth";
import { ChatInfo } from "./ui/ChatInfo";
import { ChatList } from "./ui/ChatList";
import { ChatView } from "./ui/ChatView";
import { useS } from "./ui/common";
import { NewChat } from "./ui/NewChat";
import { Settings } from "./ui/Settings";

export function App() {
  const s = useS();
  const st = useAppState();
  const path = usePath();
  useEffect(() => void boot(), []);

  const invite = match("/invite/:code", path);

  if (st.phase === "loading") {
    return (
      <main class="center">
        <h1>{s.title}</h1>
        <p class="hint" data-testid="connection" data-state="checking">
          {s.checking}
        </p>
      </main>
    );
  }
  if (st.phase === "unreachable") {
    return (
      <main class="center">
        <h1>{s.title}</h1>
        <p class="warn" data-testid="connection" data-state="offline" role="status">
          {s.offline}
        </p>
        <button type="button" onClick={() => void boot()}>
          {s.retry}
        </button>
      </main>
    );
  }
  if (st.phase === "signed-out") {
    return <main class="center">{invite ? <Register invite={invite.code!} /> : <Login />}</main>;
  }
  if (invite) return <main class="center">{<AlreadySignedIn />}</main>;

  // Signed in: the list on the left, the open thing on the right. On a phone only one shows.
  const chat = match("/chat/:id", path);
  const info = match("/chat/:id/info", path);
  const main = chat ? (
    <ChatView chatId={Number(chat.id)} />
  ) : info ? (
    <ChatInfo chatId={Number(info.id)} />
  ) : path === "/new" ? (
    <NewChat />
  ) : path === "/settings" ? (
    <Settings />
  ) : null;

  return (
    <>
      {st.updateReady && (
        <div class="update-banner" role="status" data-testid="update-ready">
          {s.updateReady}
          <button type="button" class="link" onClick={() => location.reload()}>
            {s.update}
          </button>
        </div>
      )}
      <main class={`layout${main ? " has-main" : ""}`}>
        <ChatList />
        {main ?? <section class="empty-main">{s.pickChat}</section>}
      </main>
    </>
  );
}
