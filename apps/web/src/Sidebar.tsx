import { useEffect, useState, type FormEvent } from "react";
import type { State } from "./useTelegraph";

interface Props {
  state: State;
  online: boolean;
  open: string | null;
  onOpen: (contact: string) => void;
  onAddContact: (name: string) => boolean;
  onClearContactError: () => void;
  onLogout: () => void;
}

export function Sidebar({ state, online, open, onOpen, onAddContact, onClearContactError, onLogout }: Props) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // The add succeeded once the name shows up in the list; jump straight into that chat.
  useEffect(() => {
    if (pending && state.contacts.includes(pending)) {
      onOpen(pending);
      setPending(null);
      setName("");
    }
  }, [pending, state.contacts, onOpen]);

  useEffect(() => {
    if (state.contactError) setPending(null);
  }, [state.contactError]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (state.contacts.includes(trimmed)) {
      onOpen(trimmed);
      setName("");
    } else if (onAddContact(trimmed)) {
      setPending(trimmed);
    }
  };

  const lastMessage = (contact: string) => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.from === contact || (m.from === state.me && m.to === contact)) return m;
    }
    return undefined;
  };

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        {/*<span className={"dot" + (online ? " on" : "")} title={online ? "connected" : "offline"} />*/}
        <h1>Telegraph</h1>
        <span className="me">{state.me}</span>
        <button className="link" onClick={onLogout}>
          Log out
        </button>
      </header>

      <form className="add-contact" onSubmit={submit}>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (state.contactError) onClearContactError();
          }}
          placeholder="Add contact by name"
          aria-label="Contact name"
          disabled={!!pending}
          autoComplete="off"
        />
        <button disabled={!!pending || !name.trim()}>{pending ? "…" : "Add"}</button>
      </form>
      {state.contactError && <div className="field-error">{state.contactError}</div>}

      <ul className="contacts">
        {state.contacts.length === 0 && <li className="contacts-empty">No contacts yet.</li>}
        {state.contacts.map((contact) => {
          const last = lastMessage(contact);
          const unread = state.unread[contact] ?? 0;
          return (
            <li key={contact}>
              <button
                className={"contact" + (contact === open ? " active" : "")}
                onClick={() => onOpen(contact)}
              >
                <span className="avatar">
                  {contact[0].toUpperCase()}
                  {state.peers.includes(contact) && <span className="presence" title="online" />}
                </span>
                <span className="contact-text">
                  <span className="contact-name">{contact}</span>
                  <span className="contact-preview">
                    {last ? (last.from === state.me ? "You: " : "") + last.body : "No messages yet"}
                  </span>
                </span>
                {unread > 0 && <span className="badge">{unread}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
