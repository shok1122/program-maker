"use strict";

/* 参加登録 + タイムテーブル作成ツールのサーバー。
   Node.js の標準ライブラリだけで動く（npm install 不要）。

   環境変数
     PORT              待ち受けポート                    既定 8080
     HOST              待ち受けアドレス                  既定 0.0.0.0
     DATA_DIR          JSON の保存先ディレクトリ         既定 ./data
     ADMIN_PASSWORD_HASH  管理者パスワードのハッシュ値（server/hash-password.js で作る）
     ADMIN_PASSWORD    管理者パスワードの平文（旧方式。ハッシュ値が無いときだけ使う）
                       どちらも未設定なら起動時に自動生成してログに出す
     REGISTRATION_KEY  参加登録キーの初期値（初回起動時のみ。以後は管理画面で変更）
     EVENT_NAME        イベント名の初期値（初回起動時のみ）
     TYPES_FILE        発表種別の定義ファイル             既定 ./config/types.json
     COOKIE_SECURE     1 なら Secure 付きの Cookie を発行（HTTPS 経由で公開する場合）
     SESSION_HOURS     ログインの有効時間（時間）        既定 12
     TRUST_PROXY       1 なら X-Forwarded-For を接続元として扱う（リバースプロキシ配下） */

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Store, isoDate, eventDates, normalizePeriod, daySpan, MAX_EVENT_DAYS } =
  require("./store.js");
const password = require("./password.js");

const ROOT = path.resolve(__dirname, "..");

const PORT = +(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SESSION_MS = Math.max(1, +(process.env.SESSION_HOURS || 12)) * 3600e3;

const COOKIE_NAME = "tm_session";
const MAX_BODY = 1024 * 1024;          // 1MB（タイムテーブル下書きの保存に足る）
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60e3;

const LIMITS = { title: 300, speaker: 200, affiliation: 200, key: 200,
                 eventName: 120, notice: 2000, typeName: 60 };

/* 管理者パスワードは平文では持たず、ハッシュ値だけを持つ（.htpasswd と同じ考え方）。
   ADMIN_PASSWORD_HASH … 設定に置くのはこれ。server/hash-password.js で作る。
   ADMIN_PASSWORD      … 旧方式。起動時にハッシュ化して使い、警告を出す。
   どちらも無ければ、その場限りのパスワードを自動生成してログに出す。 */
let ADMIN_HASH = "";
let adminPasswordGenerated = "";      /* 自動生成したときだけ平文を持つ（ログに出すため） */
let adminPasswordFromPlaintext = false;

async function initAdminPassword() {
  const configured = String(process.env.ADMIN_PASSWORD_HASH || "").trim();
  if (configured) {
    if (!password.isHash(configured))
      throw Object.assign(
        new Error("ADMIN_PASSWORD_HASH の形式が正しくありません。"
          + "`node server/hash-password.js` で作り直してください。"), { friendly: true });
    ADMIN_HASH = configured;
    return;
  }
  const plain = process.env.ADMIN_PASSWORD || "";
  if (plain) {
    adminPasswordFromPlaintext = true;
  } else {
    adminPasswordGenerated = crypto.randomBytes(9).toString("base64url");
  }
  ADMIN_HASH = await password.hash(plain || adminPasswordGenerated);
}

const store = new Store(DATA_DIR, {
  registrationKey: process.env.REGISTRATION_KEY || "",
  eventName: process.env.EVENT_NAME || ""
});

/* ---------------- sessions ---------------- */
const sessions = new Map();   // token -> expiresAt(ms)

function newSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}
function validSession(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp <= Date.now()) { sessions.delete(token); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp <= now) sessions.delete(t);
}, 10 * 60e3).unref();

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookieHeader(token, maxAgeSec) {
  const bits = [`${COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict",
                `Max-Age=${maxAgeSec}`];
  if (COOKIE_SECURE) bits.push("Secure");
  return bits.join("; ");
}
const isAuthed = req => validSession(parseCookies(req.headers.cookie)[COOKIE_NAME]);

/* ---------------- login throttle ---------------- */
const attempts = new Map();   // ip -> {count, resetAt}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || "?";
}
function throttled(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt <= now) return false;
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}
function noteFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt <= now) attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else rec.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (rec.resetAt <= now) attempts.delete(ip);
}, LOGIN_WINDOW_MS).unref();

/* ---------------- http helpers ---------------- */
function send(res, status, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? "" : String(body), "utf8");
  res.writeHead(status, Object.assign({
    "Content-Length": buf.length,
    "X-Content-Type-Options": "nosniff"
  }, headers || {}));
  if (res.req && res.req.method === "HEAD") res.end();
  else res.end(buf);
}
function sendJson(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign(
    { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    headers || {}));
}
/* 上限を超えた本文は捨てながら読み切る。途中で接続を切ってしまうと 413 を返せないため。
   ただし読み捨てにも上限を設け、際限なく送りつけられたら接続を切る。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const HARD_LIMIT = MAX_BODY * 4;
    let size = 0, over = false;
    let chunks = [];
    const bail = (msg, status) => {
      if (over) return;
      over = true; chunks = [];
      reject(Object.assign(new Error(msg), { status }));
    };
    req.on("data", c => {
      size += c.length;
      if (size > HARD_LIMIT) { bail("送信データが大きすぎます。", 413); req.destroy(); return; }
      if (size > MAX_BODY) { bail("送信データが大きすぎます。", 413); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("aborted", () => bail("通信が中断されました。", 400));
    req.on("error", err => { if (!over) reject(err); });
  });
}
async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch (_) {
    throw Object.assign(new Error("JSONの形式が不正です。"), { status: 400 });
  }
}

/* 状態を変える管理APIは、独自ヘッダ（クロスオリジンでは付けられない）と
   Origin の一致を要求して CSRF を防ぐ。SameSite=Strict と二重の防御。 */
function crossSite(req) {
  if (req.headers["x-tm-request"] !== "1") return true;
  const origin = req.headers.origin;
  if (!origin) return false;                     // 非ブラウザのクライアント
  try {
    return new URL(origin).host !== req.headers.host;
  } catch (_) {
    return true;
  }
}

/* control chars are stripped and the value length-capped (single-line fields). */
const str = (v, max) => String(v == null ? "" : v)
  .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/* the notice is the only field allowed to keep line breaks. */
const text = (v, max) => String(v == null ? "" : v)
  .replace(/\r\n?/g, "\n")
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
  .trim().slice(0, max);
const int = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

/* ---------------- registration ---------------- */
function publicConfig(settings) {
  return {
    mode: "server",
    eventName: settings.eventName,
    notice: settings.notice,
    registrationOpen: settings.registrationOpen,
    keyRequired: !!settings.registrationKey,
    types: settings.types.map(t => ({ id: t.id, name: t.name, talk: t.talk, qa: t.qa }))
  };
}

function buildRegistration(settings, input, existing) {
  const type = settings.types.find(t => t.id === String(input.typeId || ""));
  if (!type) throw Object.assign(new Error("種別を選択してください。"), { status: 400 });

  // 発表日は会期の中の日付だけを受け付ける（会期未設定なら常に未定）。
  // date を送ってこないクライアント（参加登録ページなど）では既存の値を保つ。
  let date = existing ? isoDate(existing.date) : "";
  if ("date" in input) date = isoDate(input.date);
  if (!eventDates(settings).includes(date)) date = "";

  const title = str(input.title, LIMITS.title);
  const speaker = str(input.speaker, LIMITS.speaker);
  const affiliation = str(input.affiliation, LIMITS.affiliation);
  if (!title) throw Object.assign(new Error("タイトルを入力してください。"), { status: 400 });
  if (!speaker) throw Object.assign(new Error("発表者を入力してください。"), { status: 400 });
  if (!affiliation) throw Object.assign(new Error("所属を入力してください。"), { status: 400 });

  const now = new Date().toISOString();
  return {
    id: existing ? existing.id : crypto.randomUUID(),
    typeId: type.id,
    typeName: type.name,
    title, speaker, affiliation, date,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };
}

/* ---------------- api ---------------- */
async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const m = req.method;
  const top = seg[0] || "";

  /* --- public --- */
  if (top === "config" && seg.length === 1) {
    if (m !== "GET" && m !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
    return sendJson(res, 200, publicConfig(store.data.settings));
  }

  if (top === "registrations" && seg.length === 1 && m === "POST") {
    const body = await readJson(req);
    const result = await store.mutate(data => {
      const s = data.settings;
      if (!s.registrationOpen)
        throw Object.assign(new Error("現在、参加登録を受け付けていません。"), { status: 409 });
      if (s.registrationKey) {
        const given = str(body.key, LIMITS.key);
        const a = crypto.createHash("sha256").update(given).digest();
        const b = crypto.createHash("sha256").update(s.registrationKey).digest();
        if (!crypto.timingSafeEqual(a, b))
          throw Object.assign(new Error("参加登録キーが正しくありません。"), { status: 403 });
      }
      const rec = buildRegistration(s, body, null);
      data.registrations.push(rec);
      return rec;
    });
    return sendJson(res, 201, { ok: true, id: result.id });
  }

  /* --- admin --- */
  if (top !== "admin") return sendJson(res, 404, { error: "not found" });

  const sub = seg[1] || "";

  if (sub === "login" && m === "POST") {
    if (crossSite(req)) return sendJson(res, 403, { error: "リクエストの発行元を確認できませんでした。" });
    const ip = clientIp(req);
    if (throttled(ip))
      return sendJson(res, 429, { error: "ログインの試行が多すぎます。しばらく待ってからお試しください。" });
    const body = await readJson(req);
    if (!await password.verify(body.password, ADMIN_HASH)) {
      noteFailure(ip);
      return sendJson(res, 401, { error: "パスワードが正しくありません。" });
    }
    attempts.delete(ip);
    return sendJson(res, 200, { ok: true },
      { "Set-Cookie": cookieHeader(newSession(), Math.floor(SESSION_MS / 1000)) });
  }

  if (sub === "session" && (m === "GET" || m === "HEAD"))
    return sendJson(res, 200, { authenticated: isAuthed(req) });

  if (sub === "logout" && m === "POST") {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) sessions.delete(token);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": cookieHeader("", 0) });
  }

  if (!isAuthed(req)) return sendJson(res, 401, { error: "unauthorized" });
  if (m !== "GET" && m !== "HEAD" && crossSite(req))
    return sendJson(res, 403, { error: "リクエストの発行元を確認できませんでした。" });

  if (sub === "data" && (m === "GET" || m === "HEAD")) {
    const d = store.data;
    return sendJson(res, 200, {
      settings: d.settings,
      registrations: d.registrations,
      timetable: d.timetable
    });
  }

  if (sub === "settings" && m === "PUT") {
    const body = await readJson(req);
    const result = await store.mutate(data => {
      const s = data.settings;
      const inc = body.settings && typeof body.settings === "object" ? body.settings : body;

      if ("eventName" in inc) s.eventName = str(inc.eventName, LIMITS.eventName) || "研究発表会";
      if ("notice" in inc) s.notice = text(inc.notice, LIMITS.notice);
      if ("registrationOpen" in inc) s.registrationOpen = !!inc.registrationOpen;
      if ("registrationKey" in inc) s.registrationKey = str(inc.registrationKey, LIMITS.key);

      if ("eventStart" in inc || "eventEnd" in inc) {
        const p = normalizePeriod("eventStart" in inc ? inc.eventStart : s.eventStart,
                                  "eventEnd" in inc ? inc.eventEnd : s.eventEnd);
        if (p.eventStart && daySpan(p.eventStart, p.eventEnd) > MAX_EVENT_DAYS)
          throw Object.assign(new Error(`会期は最大${MAX_EVENT_DAYS}日までです。`), { status: 400 });
        s.eventStart = p.eventStart;
        s.eventEnd = p.eventEnd;
      }

      if (Array.isArray(inc.types)) {
        const seen = new Set();
        const next = [];
        inc.types.forEach((t, i) => {
          if (!t || typeof t !== "object") return;
          const name = str(t.name, LIMITS.typeName) || `種別${i + 1}`;
          const id = typeof t.id === "string" && /^[\w-]{1,64}$/.test(t.id) && !seen.has(t.id)
            ? t.id : crypto.randomUUID();
          seen.add(id);
          next.push({ id, name, talk: int(t.talk, 0, 600, 0), qa: int(t.qa, 0, 600, 0),
                      emphasis: t.emphasis === true });
        });
        if (!next.length)
          throw Object.assign(new Error("種別は1つ以上必要です。"), { status: 400 });
        s.types = next;
        // 種別名を変えたら既存の登録の表示名も追随させる
        const byId = new Map(next.map(t => [t.id, t]));
        for (const r of data.registrations) {
          const t = byId.get(r.typeId);
          if (t) r.typeName = t.name;
        }
      }

      // 会期の外に出てしまった発表日は未定に戻す（発表日は必ず会期の中の日付か未定）
      const days = new Set(eventDates(s));
      let cleared = 0;
      for (const r of data.registrations) {
        const d = isoDate(r.date);
        if (d && !days.has(d)) cleared++;
        r.date = days.has(d) ? d : "";
      }
      return { settings: s, cleared };
    });
    return sendJson(res, 200, { ok: true, settings: result.settings, cleared: result.cleared });
  }

  if (sub === "registrations" && seg.length === 2 && m === "POST") {
    const body = await readJson(req);
    const rec = await store.mutate(data => {
      const r = buildRegistration(data.settings, body, null);
      data.registrations.push(r);
      return r;
    });
    return sendJson(res, 201, { ok: true, registration: rec });
  }

  if (sub === "registrations" && seg.length === 3) {
    const id = decodeURIComponent(seg[2]);
    if (m === "PUT") {
      const body = await readJson(req);
      const rec = await store.mutate(data => {
        const i = data.registrations.findIndex(r => r.id === id);
        if (i < 0) throw Object.assign(new Error("該当する登録が見つかりません。"), { status: 404 });
        const next = buildRegistration(data.settings, body, data.registrations[i]);
        data.registrations[i] = next;
        return next;
      });
      return sendJson(res, 200, { ok: true, registration: rec });
    }
    if (m === "DELETE") {
      await store.mutate(data => {
        const i = data.registrations.findIndex(r => r.id === id);
        if (i < 0) throw Object.assign(new Error("該当する登録が見つかりません。"), { status: 404 });
        data.registrations.splice(i, 1);
      });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (sub === "timetable" && m === "PUT") {
    const body = await readJson(req);
    await store.mutate(data => {
      data.timetable = body.timetable && typeof body.timetable === "object" ? body.timetable : null;
    });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "not found" });
}

/* ---------------- static files ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};
const PUBLIC_FILES = new Set(["/index.html", "/admin.html", "/login.html", "/favicon.ico"]);

/* URL を公開対象のファイルパスに変換する。対象外なら null。 */
function resolveStatic(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }
  if (p.includes("\0")) return null;
  if (p === "/") p = "/index.html";
  p = path.posix.normalize(p);
  if (!p.startsWith("/") || p.includes("..")) return null;

  const allowed = PUBLIC_FILES.has(p) || p.startsWith("/assets/");
  if (!allowed) return null;
  if (!MIME[path.extname(p).toLowerCase()]) return null;

  const abs = path.join(ROOT, p);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return abs;
}

async function serveFile(req, res, abs, status) {
  let st;
  try {
    st = await fsp.stat(abs);
    if (!st.isFile()) return send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
  } catch (_) {
    return send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
  }
  const etag = `W/"${st.size}-${st.mtimeMs.toString(36)}"`;
  const headers = {
    "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "ETag": etag
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { "Cache-Control": headers["Cache-Control"], "ETag": etag });
    return res.end();
  }
  return send(res, status || 200, await fsp.readFile(abs), headers);
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  res.req = req;
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch (_) {
    return send(res, 400, "Bad Request", { "Content-Type": "text/plain; charset=utf-8" });
  }

  try {
    if (url.pathname === "/healthz")
      return sendJson(res, 200, { ok: true });

    if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
      return await handleApi(req, res, url);

    // 管理画面はログインしていないとページ自体を返さない
    if (url.pathname === "/admin" || url.pathname === "/admin.html") {
      if (!isAuthed(req))
        return await serveFile(req, res, path.join(ROOT, "login.html"), 200);
      return await serveFile(req, res, path.join(ROOT, "admin.html"), 200);
    }

    if (req.method !== "GET" && req.method !== "HEAD")
      return send(res, 405, "Method Not Allowed", { "Content-Type": "text/plain; charset=utf-8", "Allow": "GET, HEAD" });

    const abs = resolveStatic(url.pathname);
    if (!abs) return send(res, 404, "Not Found", { "Content-Type": "text/plain; charset=utf-8" });
    return await serveFile(req, res, abs);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status >= 500) console.error("[error]", req.method, url.pathname, err);
    if (res.headersSent || res.writableEnded) return;   // 応答済み（本文の読み捨て中など）
    const msg = status >= 500 ? "サーバー内部でエラーが発生しました。" : String(err.message || "エラー");
    const extra = status === 413 ? { "Connection": "close" } : {};
    if (url.pathname.startsWith("/api/")) return sendJson(res, status, { error: msg }, extra);
    return send(res, status, msg, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, extra));
  }
});

Promise.all([store.init(), initAdminPassword()]).then(([info]) => {
  server.listen(PORT, HOST, () => {
    console.log(`[program-maker] listening on http://${HOST}:${PORT}`);
    console.log(`[program-maker] data file: ${store.file}${info.created ? " (新規作成)" : ""}`);
    if (info.typesFile)
      console.log(`[program-maker] 発表種別: ${store.data.settings.types.length}件`
        + ` ← ${info.typesFile}${info.typesUpdated ? "（変更を反映しました）" : ""}`);
    else
      console.log("[program-maker] 発表種別の定義ファイルはありません（管理画面の「設定」で編集できます）。");
    if (info.recoveredFrom)
      console.warn(`[program-maker] 既存のデータファイルを読み込めなかったため ${info.recoveredFrom} に退避しました`);
    console.log(`[program-maker] 参加登録: /    管理画面: /admin`);
    if (adminPasswordGenerated) {
      console.warn("[program-maker] ADMIN_PASSWORD_HASH が未設定です。今回のパスワードを自動生成しました:");
      console.warn(`[program-maker]   ${adminPasswordGenerated}`);
      console.warn("[program-maker] 再起動すると変わります。本番では ADMIN_PASSWORD_HASH を設定してください");
      console.warn("[program-maker] （ハッシュ値は node server/hash-password.js で作れます）。");
    } else if (adminPasswordFromPlaintext) {
      console.warn("[program-maker] ADMIN_PASSWORD（平文）でログインします。ハッシュ値での設定に移行してください:");
      console.warn("[program-maker]   node server/hash-password.js の出力を .env の ADMIN_PASSWORD_HASH に置き、"
        + "ADMIN_PASSWORD は削除してください。");
    }
    if (!store.data.settings.registrationKey)
      console.log("[program-maker] 参加登録キーは未設定です（誰でも登録できます）。管理画面の「設定」で指定できます。");
  });
}).catch(err => {
  console.error("[program-maker] 起動に失敗しました:", err && err.friendly ? err.message : err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[program-maker] ${sig} を受け取りました。終了します。`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
