import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
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
  typing: boolean;
  messages: StoredMessage[];
  onSend: (body: string) => boolean;
  onTyping: (typing: boolean) => void;
  onBack: () => void;
}

export function Chat({ me, contact, online, typing, messages, onSend, onTyping, onBack }: Props) {
  const [body, setBody] = useState("");
  const { keystroke, stopTyping } = useTypingSignal(onTyping);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages.length]);

  useEffect(() => input.current?.focus(), []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    if (onSend(body)) {
      setBody("");
      stopTyping();
    }
  };

  return (
    <section className="chat">
      <header className="chat-header">
        <button className="icon-button back" aria-label="Back to contacts" onClick={onBack}>
          ‹
        </button>
        <h2>{contact}</h2>
        <span className={"chat-presence" + (typing ? " typing" : "")}>
          {typing ? "typing…" : online ? "online" : "offline"}
        </span>
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
          onChange={(e) => {
            setBody(e.target.value);
            if (e.target.value.trim()) keystroke();
            else stopTyping();
          }}
          placeholder={`Message ${contact}`}
          autoComplete="off"
        />
        <button disabled={!body.trim()}>Send</button>
      </form>
    </section>
  );
}

const TYPING_REPEAT_MS = 3_000; // resend `true` this often while typing
const TYPING_IDLE_MS = 5_000; // no keys pressed for this long counts as stopped

// Tells the contact we're typing.
function useTypingSignal(onTyping: (typing: boolean) => void) {
  const send = useRef(onTyping);
  send.current = onTyping;
  const lastSent = useRef(0); // 0 = not typing
  const idle = useRef<ReturnType<typeof setTimeout>>(undefined);

  const stopTyping = useCallback(() => {
    clearTimeout(idle.current);
    if (lastSent.current) send.current(false);
    lastSent.current = 0;
  }, []);

  const keystroke = useCallback(() => {
    clearTimeout(idle.current);
    idle.current = setTimeout(stopTyping, TYPING_IDLE_MS);
    if (Date.now() - lastSent.current < TYPING_REPEAT_MS) return;
    lastSent.current = Date.now();
    send.current(true);
  }, [stopTyping]);

  useEffect(() => stopTyping, [stopTyping]);

  return { keystroke, stopTyping };
}
