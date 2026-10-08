import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MessageStatus, StoredMessage } from "@telegraph/shared";

const STATUS_LABELS: Record<MessageStatus, string> = {
  pending: "sending…",
  sent: "sent",
  delivered: "delivered",
  failed: "failed",
  received: "",
};

interface Props {
  me: string;
  contact: string;
  online: boolean;
  messages: StoredMessage[];
  onSend: (body: string) => boolean;
  onBack: () => void;
}

export function Chat({ me, contact, online, messages, onSend, onBack }: Props) {
  const [body, setBody] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages.length]);

  useEffect(() => input.current?.focus(), []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    if (onSend(body)) setBody("");
  };

  return (
    <section className="chat">
      <header className="chat-header">
        <button className="icon-button back" aria-label="Back to contacts" onClick={onBack}>
          ‹
        </button>
        <h2>{contact}</h2>
        <span className="chat-presence">{online ? "online" : "offline"}</span>
      </header>

      <div className="log" ref={log}>
        {messages.length === 0 && <div className="log-empty">No messages with {contact} yet.</div>}
        {messages.map((m) => {
          const mine = m.from === me;
          return (
            <div key={m.id} className={"msg" + (mine ? " mine" : "") + (m.status === "failed" ? " failed" : "")}>
              <div className="text">{m.body}</div>
              <div className="meta">
                {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {mine && ` · ${STATUS_LABELS[m.status]}`}
              </div>
            </div>
          );
        })}
      </div>

      <form className="compose" onSubmit={submit}>
        <input
          ref={input}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`Message ${contact}`}
          autoComplete="off"
        />
        <button disabled={!body.trim()}>Send</button>
      </form>
    </section>
  );
}
