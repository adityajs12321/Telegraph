// Runs the app's Session in this tab and keeps chat state in sync with it.

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { LoginStep, StoredMessage, UiCommand, UiEvent } from "@telegraph/shared";
import { Session } from "./engine/session";

export interface Notice {
  id: number;
  text: string;
}

export interface State {
  auth: "unknown" | "logged-out" | "logged-in";
  login: { step: LoginStep; reason?: string; seq: number } | null;
  me: string;
  otherTab: boolean; // Telegraph is running in another tab of this browser
  serverConnected: boolean;
  peers: string[];
  typing: string[];
  contacts: string[];
  messages: StoredMessage[];
  unread: Record<string, number>;
  notices: Notice[];
  contactError: string | null;
}

type Action =
  | { type: "event"; event: UiEvent; open: string | null }
  | { type: "other-tab"; otherTab: boolean }
  | { type: "read"; contact: string }
  | { type: "dismiss"; id: number }
  | { type: "clear-contact-error" };

const initialState: State = {
  auth: "unknown",
  login: null,
  me: "",
  otherTab: false,
  serverConnected: false,
  peers: [],
  typing: [],
  contacts: [],
  messages: [],
  unread: {},
  notices: [],
  contactError: null,
};

let nextNoticeId = 1;
const SERVER_DOWN = "Reconnecting…";

const withNotice = (state: State, text: string): State => ({
  ...state,
  notices: [...state.notices, { id: nextNoticeId++, text }],
});

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "other-tab":
      return { ...state, otherTab: action.otherTab };
    case "read":
      return { ...state, unread: { ...state.unread, [action.contact]: 0 } };
    case "dismiss":
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
    case "clear-contact-error":
      return { ...state, contactError: null };
    case "event":
      return applyEvent(state, action.event, action.open);
  }
}

let nextLoginSeq = 1;

function applyEvent(state: State, e: UiEvent, open: string | null): State {
  switch (e.type) {
    case "logged-out":
      return { ...initialState, auth: "logged-out" };
    case "login":
      return { ...state, login: { step: e.step, reason: e.reason, seq: nextLoginSeq++ } };
    case "init":
      return {
        ...state,
        auth: "logged-in",
        login: null,
        notices: [],
        unread: {},
        me: e.me,
        serverConnected: e.connected,
        peers: e.peers,
        typing: [],
        contacts: e.contacts,
        messages: e.history,
      };
    case "message": {
      if (state.messages.some((m) => m.id === e.id)) return state;
      const incoming = e.from !== state.me;
      const unread =
        incoming && e.from !== open ? { ...state.unread, [e.from]: (state.unread[e.from] ?? 0) + 1 } : state.unread;
      const typing = state.typing.filter((name) => name !== e.from);
      return { ...state, messages: [...state.messages, e], unread, typing };
    }
    case "status": {
      const next = {
        ...state,
        messages: state.messages.map((m) => (m.id === e.id ? { ...m, status: e.status } : m)),
      };
      return e.reason ? withNotice(next, e.reason) : next;
    }
    case "peers":
      return { ...state, peers: e.peers, typing: state.typing.filter((name) => e.peers.includes(name)) };
    case "typing": {
      const others = state.typing.filter((name) => name !== e.from);
      return { ...state, typing: e.typing ? [...others, e.from] : others };
    }
    case "contacts":
      return { ...state, contacts: e.contacts, contactError: null };
    case "contact-error":
      return { ...state, contactError: e.reason };
    case "connection": {
      const next = { ...state, serverConnected: e.connected, typing: e.connected ? state.typing : [] };
      if (e.connected) return { ...next, notices: next.notices.filter((n) => n.text !== SERVER_DOWN) };
      return state.serverConnected ? withNotice(next, SERVER_DOWN) : next;
    }
    case "notice":
      return withNotice(state, e.reason);
  }
}

// typping timeout
const TYPING_EXPIRE_MS = 6_000;

// Held by the tab that runs the Session. The server keeps one connection per account, so two tabs
// would keep replacing each other's; later tabs wait until the first one closes.
const TAB_LOCK = "telegraph-session";

// only count inactive chats as unread
export function useTelegraph(open: string | null) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const session = useRef<Session | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const abort = new AbortController();
    let release: () => void = () => {};

    const expireTyping = (from: string, typing: boolean) => {
      clearTimeout(typingTimers.current.get(from));
      typingTimers.current.delete(from);
      if (!typing) return;
      const timer = setTimeout(() => {
        typingTimers.current.delete(from);
        dispatch({ type: "event", event: { type: "typing", from, typing: false }, open: openRef.current });
      }, TYPING_EXPIRE_MS);
      typingTimers.current.set(from, timer);
    };

    const emit = (event: UiEvent) => {
      if (event.type === "typing") expireTyping(event.from, event.typing);
      dispatch({ type: "event", event, open: openRef.current });
    };

    // Runs the session until this tab closes or unmounts.
    const run = () => {
      if (abort.signal.aborted) return;
      dispatch({ type: "other-tab", otherTab: false });
      session.current = new Session(emit);
      void session.current.start();
      return new Promise<void>((resolve) => (release = resolve));
    };

    navigator.locks
      .request(TAB_LOCK, { ifAvailable: true }, (lock) => {
        if (lock) return run();
        dispatch({ type: "other-tab", otherTab: true });
        return navigator.locks.request(TAB_LOCK, { signal: abort.signal }, run);
      })
      .catch(() => {
        // aborted while waiting for the other tab
      });

    return () => {
      abort.abort();
      session.current?.shutdown();
      session.current = null;
      release();
      for (const timer of typingTimers.current.values()) clearTimeout(timer);
      typingTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    if (open) dispatch({ type: "read", contact: open });
  }, [open]);

  const command = useCallback((cmd: UiCommand) => {
    if (!session.current) return false;
    session.current.command(cmd);
    return true;
  }, []);
  return {
    state,
    send: (to: string, body: string) => command({ type: "send", to, body }),
    typing: (to: string, typing: boolean) => command({ type: "typing", to, typing }),
    addContact: (name: string) => command({ type: "add-contact", name }),
    loginStart: (email: string) => command({ type: "login-start", email }),
    loginVerify: (email: string, code: string, name?: string) => command({ type: "login-verify", email, code, name }),
    logout: () => command({ type: "logout" }),
    dismissNotice: (id: number) => dispatch({ type: "dismiss", id }),
    clearContactError: () => dispatch({ type: "clear-contact-error" }),
  };
}
