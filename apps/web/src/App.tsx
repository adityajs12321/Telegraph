import { useEffect, useState } from "react";
import { Chat } from "./Chat";
import { Login } from "./Login";
import { Sidebar } from "./Sidebar";
import { useTelegraph, type State } from "./useTelegraph";

export function App() {
  const [open, setOpen] = useState<string | null>(null);
  const { state, send, typing, addContact, loginStart, loginVerify, logout, dismissNotice, clearContactError } =
    useTelegraph(open);
  const online = state.serverConnected;

  useEffect(() => {
    if (state.auth !== "logged-in") setOpen(null);
  }, [state.auth]);

  const status = (
    <>
      <Notices notices={state.notices} onDismiss={dismissNotice} />
      {state.otherTab && <div className="banner">Telegraph is open in another tab. Close it to use Telegraph here.</div>}
    </>
  );

  if (state.auth !== "logged-in") {
    return (
      <div className="app login-page">
        {status}
        {state.auth === "logged-out" && <Login login={state.login} onStart={loginStart} onVerify={loginVerify} />}
      </div>
    );
  }

  return (
    <div className={"app" + (open ? " chat-open" : "")}>
      <Sidebar
        state={state}
        online={online}
        open={open}
        onOpen={setOpen}
        onAddContact={addContact}
        onClearContactError={clearContactError}
        onLogout={logout}
      />
      <main className="main">
        {status}
        {open ? (
          <Chat
            key={open}
            me={state.me}
            contact={open}
            online={state.peers.includes(open)}
            typing={state.typing.includes(open)}
            messages={state.messages.filter((m) => (m.from === state.me ? m.to === open : m.from === open))}
            onSend={(body) => send(open, body)}
            onTyping={(on) => typing(open, on)}
            onBack={() => setOpen(null)}
          />
        ) : (
          <div className="empty">
            {state.contacts.length ? "Pick a contact to start chatting." : "Add a contact to start chatting."}
          </div>
        )}
      </main>
    </div>
  );
}

function Notices({ notices, onDismiss }: { notices: State["notices"]; onDismiss: (id: number) => void }) {
  if (notices.length === 0) return null;
  return (
    <div className="notices">
      {notices.map((n) => (
        <div key={n.id} className="notice">
          <span>{n.text}</span>
          <button className="icon-button" aria-label="Dismiss" onClick={() => onDismiss(n.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
