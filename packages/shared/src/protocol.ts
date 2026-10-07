const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function isValidName(name: unknown): name is string {
  return typeof name === "string" && NAME_PATTERN.test(name);
}

// ---- Chat message ----

export interface ChatMessage {
  type: "message";
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

// pending   -> not yet accepted by the server (offline or unreachable)
// sent      -> held by the server until the recipient picks it up
// delivered -> the recipient saved it and the server deleted its copy
// failed    -> can't be delivered (e.g. unknown recipient)
// received  -> incoming
export type MessageStatus = "pending" | "sent" | "delivered" | "failed" | "received";

export interface StoredMessage extends ChatMessage {
  status: MessageStatus;
}

export function isChatMessage(f: unknown): f is ChatMessage {
  const m = f as ChatMessage | null;
  return (
    !!m &&
    m.type === "message" &&
    typeof m.id === "string" &&
    typeof m.from === "string" &&
    typeof m.to === "string" &&
    typeof m.body === "string" &&
    typeof m.timestamp === "string"
  );
}

export function toWire(m: ChatMessage): ChatMessage {
  return { type: "message", id: m.id, from: m.from, to: m.to, body: m.body, timestamp: m.timestamp };
}

// ---- app and server comms ----

export interface PublicKeys {
  signPub: string; // Ed25519
  boxPub: string; // X25519
}

export interface Envelope {
  id: string;
  from: string;
  to: string;
  epk: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

export type ServerFrame =
  | { type: "envelope"; envelope: Envelope }
  | { type: "delivered"; id: string } // sent to client after message succesfully delivered.
  | { type: "peers"; peers: string[] }; // list of connected clients

export type ClientFrame = { type: "ack"; ids: string[] };

export const AUTH_HEADERS = {
  name: "x-telegraph-name",
  timestamp: "x-telegraph-timestamp",
  signature: "x-telegraph-signature",
} as const;

// ---- Websocket comms ----

export type UiCommand = { type: "send"; to: string; body: string };

export type UiEvent =
  | { type: "init"; me: string; connected: boolean; peers: string[]; history: StoredMessage[] }
  | StoredMessage
  | { type: "status"; id: string; status: MessageStatus; reason?: string }
  | { type: "peers"; peers: string[] }
  | { type: "connection"; connected: boolean }
  | { type: "notice"; reason: string };

// ---- Helpers ----

export function parseJson(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}
