// k6 load test
//
//   npx tsx loadtest/seed.ts 1000
//   ulimit -n 65535
//   k6 run -e SERVER=https://your-server loadtest/chat.js

import http from "k6/http";
import encoding from "k6/encoding";
import exec from "k6/execution";
import { SharedArray } from "k6/data";
import { Counter, Rate, Trend } from "k6/metrics";
import { setInterval, clearInterval, setTimeout, clearTimeout } from "k6/timers";
import { sleep } from "k6";
import { WebSocket } from "k6/websockets";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const SERVER = (__ENV.SERVER || "").replace(/\/+$/, "");
if (!SERVER) throw new Error("pass the server URL: k6 run -e SERVER=https://… loadtest/chat.js");
const LEVELS = (__ENV.LEVELS || "50,100,200,400,800").split(",").map(Number);
const RAMP_S = seconds(__ENV.RAMP || "30s");
const HOLD_S = seconds(__ENV.HOLD || "60s");
const SEND_EVERY_MS = Number(__ENV.SEND_EVERY || 5) * 1000;
const P95_MS = Number(__ENV.P95_MS || 500);
const P99_MS = Number(__ENV.P99_MS || 1000);
const LOST_AFTER_MS = 15_000; // a message not back by then counts as lost

const users = new SharedArray("users", () => JSON.parse(open("./users.json")));


const stages = [];
const holds = [];
let t = 0;
for (const level of LEVELS) {
  stages.push({ duration: `${RAMP_S}s`, target: level });
  stages.push({ duration: `${HOLD_S}s`, target: level });
  holds.push([t + RAMP_S, t + RAMP_S + HOLD_S, level]);
  t += RAMP_S + HOLD_S;
}
const END_S = t;
stages.push({ duration: "10s", target: 0 });

const metricsPerLevel = (level) => ({
  [`http_req_duration{name:send,level:${level}}`]: [`p(95)<${P95_MS}`, `p(99)<${P99_MS}`],
  [`delivery_ms{level:${level}}`]: [`p(95)<${P95_MS}`, `p(99)<${P99_MS}`],
  [`ws_connect_ms{level:${level}}`]: [`p(95)<${P95_MS * 4}`],
  [`send_ok{level:${level}}`]: ["rate>0.99"],
  [`messages_lost{level:${level}}`]: ["count<1"],
  [`ws_drops{level:${level}}`]: ["count>=0"],
  [`presence_bytes{level:${level}}`]: ["count>=0"],
});

export const options = {
  scenarios: {
    chat: { executor: "ramping-vus", startVUs: 0, stages, gracefulRampDown: "10s", gracefulStop: "15s" },
  },
  thresholds: Object.assign({}, ...LEVELS.map(metricsPerLevel)),
  summaryTrendStats: ["count", "avg", "med", "p(95)", "p(99)", "max"],
};

const sendLatency = new Trend("delivery_ms", true);
const connectLatency = new Trend("ws_connect_ms", true);
const sendOk = new Rate("send_ok");
const messagesLost = new Counter("messages_lost");
const wsDrops = new Counter("ws_drops");
const presenceBytes = new Counter("presence_bytes");

export function setup() {
  const most = Math.max(...LEVELS);
  if (users.length < most) throw new Error(`users.json has ${users.length} users but LEVELS goes to ${most}; seed more`);
  const res = http.get(`${SERVER}/health`);
  if (res.status !== 200) throw new Error(`${SERVER}/health returned ${res.status}`);
}


let me, seed;
const payload = encoding.b64encode(randomBytes(256));
const enc = new TextEncoder();
let seq = 0;
let failedLastTime = false;

export default async function () {
  if (!me) {
    me = users[(exec.vu.idInTest - 1) % users.length];
    seed = new Uint8Array(encoding.b64decode(me.seed));
  }
  if (elapsedS() >= END_S) return void sleep(1);
  if (failedLastTime) sleep(1 + Math.random());

  const auth = await signedHeaders("GET", "/ws", "");
  const query = Object.entries(auth).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const started = Date.now();
  const ws = new WebSocket(`${SERVER.replace(/^http/, "ws")}/ws?${query}`);
  const pending = new Map();
  let opened = false;
  let ending = false;
  let sender, reaper, stopper;

  ws.onopen = () => {
    opened = true;
    failedLastTime = false;
    connectLatency.add(Date.now() - started, { level: levelNow() });
    ws.send(JSON.stringify({ type: "watch", name: users[exec.vu.idInTest % users.length].name }));
    sender = setTimeout(() => {
      void send(ws, pending);
      sender = setInterval(() => void send(ws, pending), SEND_EVERY_MS);
    }, Math.random() * SEND_EVERY_MS);
    reaper = setInterval(() => {
      const now = Date.now();
      for (const [id, sent] of pending) {
        if (now - sent < LOST_AFTER_MS) continue;
        pending.delete(id);
        messagesLost.add(1, { level: levelNow() });
      }
    }, 1000);
    stopper = setTimeout(() => {
      ending = true;
      ws.close();
    }, Math.max(0, (END_S - elapsedS()) * 1000));
  };

  ws.onmessage = (e) => {
    const frame = JSON.parse(e.data);
    if (frame.type === "presence") return void presenceBytes.add(e.data.length, { level: levelNow() });
    if (frame.type !== "envelope") return;
    const id = frame.envelope.id;
    const sent = pending.get(id);
    if (sent !== undefined) {
      pending.delete(id);
      sendLatency.add(Date.now() - sent, { level: levelNow() });
    }
    ws.send(JSON.stringify({ type: "ack", ids: [id] }));
  };

  ws.onclose = () => {
    clearTimeout(sender);
    clearInterval(sender);
    clearInterval(reaper);
    clearTimeout(stopper);
    if (!opened) failedLastTime = true;
    else if (!ending) wsDrops.add(1, { level: levelNow() });
  };
  ws.onerror = () => {};
}

async function send(ws, pending) {
  if (ws.readyState !== 1) return;
  const id = `${me.name}-${exec.vu.iterationInScenario}-${seq++}`;
  const body = JSON.stringify({
    id,
    from: me.name,
    to: me.name,
    toKey: me.boxPub,
    epk: payload.slice(0, 44),
    iv: payload.slice(0, 16),
    ciphertext: payload,
    tag: payload.slice(0, 24),
  });
  const level = levelNow();
  pending.set(id, Date.now());
  const headers = { "Content-Type": "application/json", ...(await signedHeaders("POST", "/envelopes", body)) };
  const res = await http.asyncRequest("POST", `${SERVER}/envelopes`, body, { headers, tags: { name: "send", level }, timeout: "10s" });
  const ok = res.status === 201;
  sendOk.add(ok, { level, status: String(res.status) });
  if (!ok) pending.delete(id);
}

async function signedHeaders(method, path, body) {
  const ts = String(Date.now());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(body)));
  const bodyHash = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  const sig = await ed.signAsync(enc.encode(`${method.toUpperCase()}\n${path}\n${ts}\n${bodyHash}`), seed);
  return {
    "x-telegraph-name": me.name,
    "x-telegraph-timestamp": ts,
    "x-telegraph-signature": encoding.b64encode(sig.slice().buffer),
  };
}

// ---- Helpers ----

function elapsedS() {
  return (Date.now() - exec.scenario.startTime) / 1000;
}

function levelNow() {
  const s = elapsedS();
  for (const [start, end, level] of holds) if (s >= start && s < end) return String(level);
  return "ramp";
}

function seconds(d) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(d).trim());
  if (!m) throw new Error(`bad duration "${d}"`);
  const n = Number(m[1]);
  return m[2] === "ms" ? n / 1000 : m[2] === "m" ? n * 60 : n;
}

function randomBytes(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes.buffer;
}

export function handleSummary(data) {
  const m = (name) => data.metrics[name]?.values ?? {};
  const ms = (v) => (v === undefined ? "-" : `${Math.round(v)}`);
  const rows = [];
  let best = null;
  for (const level of LEVELS) {
    const send = m(`http_req_duration{name:send,level:${level}}`);
    const delivery = m(`delivery_ms{level:${level}}`);
    const connect = m(`ws_connect_ms{level:${level}}`);
    const ok = m(`send_ok{level:${level}}`);
    const lost = m(`messages_lost{level:${level}}`).count ?? 0;
    const drops = m(`ws_drops{level:${level}}`).count ?? 0;
    const presence = m(`presence_bytes{level:${level}}`).count ?? 0;
    const delivered = delivery.count ?? 0;
    const errors = ok.rate === undefined ? undefined : 1 - ok.rate;
    const pass =
      delivered > 0 &&
      delivery["p(95)"] < P95_MS &&
      delivery["p(99)"] < P99_MS &&
      send["p(95)"] < P95_MS &&
      send["p(99)"] < P99_MS &&
      errors < 0.01 &&
      lost === 0;
    if (pass) best = Math.max(best ?? 0, level);
    rows.push([
      level,
      (delivered / HOLD_S).toFixed(1),
      ms(send["p(95)"]),
      ms(send["p(99)"]),
      ms(delivery["p(95)"]),
      ms(delivery["p(99)"]),
      ms(connect["p(95)"]),
      errors === undefined ? "-" : `${(errors * 100).toFixed(2)}%`,
      lost,
      drops,
      `${(presence / HOLD_S / 1024).toFixed(1)}`,
      pass ? "ok" : "FAIL",
    ]);
  }
  const header = ["users", "msg/s", "send p95", "send p99", "deliv p95", "deliv p99", "conn p95", "errors", "lost", "drops", "presence KB/s", ""];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padStart(widths[i])).join("  ");
  const text = [
    "",
    `Telegraph load test against ${SERVER}  (latencies in ms; limits p95 < ${P95_MS}, p99 < ${P99_MS})`,
    "",
    line(header),
    ...rows.map(line),
    "",
    best === null
      ? "No level stayed within the limits."
      : `Highest level within the limits: ${best} concurrent users (sending every ${SEND_EVERY_MS / 1000}s).`,
    "",
  ].join("\n");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return { stdout: text, [`loadtest/results/${stamp}.json`]: JSON.stringify(data, null, 2) };
}
