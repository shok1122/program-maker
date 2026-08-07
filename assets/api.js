"use strict";

/* 参加登録データへのアクセス層。
   同じ画面をサーバー版とデモ版の両方で動かすため、起動時に api/config へ
   到達できるかを見て実装を切り替える。

     server : Node サーバー（本番／Docker）。データはサーバーの JSON ファイル。
     demo   : GitHub Pages などの静的ホスティング。データは localStorage、
              管理画面のパスワードは不要。

   fetch がネットワークエラーになる（file:// や API 未搭載）か 404 が返る場合に
   デモ版へ落とす。5xx はサーバーの異常なのでエラーとして扱い、
   デモ版に落として編集内容が迷子になることを防ぐ。 */

window.TM = (function () {

  const DEMO_STORAGE_KEY = "tm-demo-v3";
  /* 読み替えずに捨てる古い版のデモデータ。デモは中身が使い捨てなので、
     初期状態の作りを変えたときはキーを上げて作り直す。
     取り残しがブラウザに残り続けないよう、seed のときに消しておく。 */
  const DEMO_OLD_KEYS = ["tm-demo-v1", "tm-demo-v2"];
  let MODE = null;

  /* ---------------- 共通ユーティリティ ---------------- */

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  }
  function fail(message, status) {
    const err = new Error(message);
    err.status = status || 400;
    return err;
  }
  const LIMITS = { title: 300, speaker: 200, affiliation: 200, key: 200,
                   eventName: 120, venue: 200, notice: 2000, typeName: 60 };

  function oneLine(v, max) {
    return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
  }
  function multiLine(v, max) {
    return String(v == null ? "" : v).replace(/\r\n?/g, "\n").trim().slice(0, max);
  }

  /* ---------------- 日付（会期・発表日） ----------------
     サーバー側 server/store.js と同じ規則。画面からも TM.isoDate / TM.eventDates /
     TM.dateLabel として使う。 */
  const MAX_EVENT_DAYS = 60;
  const DAY_MS = 86400000;
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  function isoDate(v) {
    const s = String(v == null ? "" : v).trim();
    if (!ISO_DATE_RE.test(s)) return "";
    const t = Date.parse(s + "T00:00:00Z");
    if (!isFinite(t)) return "";
    return new Date(t).toISOString().slice(0, 10) === s ? s : "";
  }
  function normalizePeriod(startRaw, endRaw) {
    const eventStart = isoDate(startRaw);
    if (!eventStart) return { eventStart: "", eventEnd: "" };
    let eventEnd = isoDate(endRaw) || eventStart;
    if (eventEnd < eventStart) eventEnd = eventStart;
    return { eventStart, eventEnd };
  }
  function daySpan(start, end) {
    return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / DAY_MS) + 1;
  }
  /* 会期を1日ずつの配列に展開する。未設定なら空配列。 */
  function eventDates(settings) {
    const p = normalizePeriod(settings && settings.eventStart, settings && settings.eventEnd);
    if (!p.eventStart) return [];
    const out = [];
    const last = Date.parse(p.eventEnd + "T00:00:00Z");
    for (let t = Date.parse(p.eventStart + "T00:00:00Z"); t <= last && out.length < MAX_EVENT_DAYS; t += DAY_MS)
      out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }
  /* "4/10（金）" ／ long=true なら "2026/04/10（金）" */
  function dateLabel(iso, long) {
    const d = isoDate(iso);
    if (!d) return "";
    const t = new Date(d + "T00:00:00Z");
    const mm = t.getUTCMonth() + 1, dd = t.getUTCDate(), w = WEEKDAYS[t.getUTCDay()];
    return long
      ? `${t.getUTCFullYear()}/${String(mm).padStart(2, "0")}/${String(dd).padStart(2, "0")}（${w}）`
      : `${mm}/${dd}（${w}）`;
  }

  /* サーバー側と同じ検証。デモ版でも同じ手応えになるようにする。 */
  function buildRegistration(settings, input, existing) {
    const type = (settings.types || []).find(t => t.id === String(input.typeId || ""));
    if (!type) throw fail("種別を選択してください。");
    const title = oneLine(input.title, LIMITS.title);
    const speaker = oneLine(input.speaker, LIMITS.speaker);
    const affiliation = oneLine(input.affiliation, LIMITS.affiliation);
    if (!title) throw fail("タイトルを入力してください。");
    if (!speaker) throw fail("発表者を入力してください。");
    if (!affiliation) throw fail("所属を入力してください。");
    // 発表日は会期の中の日付だけ。date を送ってこない場合は既存の値を保つ
    let date = existing ? isoDate(existing.date) : "";
    if ("date" in input) date = isoDate(input.date);
    if (!eventDates(settings).includes(date)) date = "";
    const now = new Date().toISOString();
    return {
      id: existing ? existing.id : uid(),
      typeId: type.id, typeName: type.name,
      title, speaker, affiliation, date,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };
  }

  function publicConfig(settings, mode) {
    return {
      mode,
      eventName: settings.eventName,
      venue: settings.venue || "",
      notice: settings.notice,
      registrationOpen: settings.registrationOpen,
      keyRequired: !!settings.registrationKey,
      timetablePublic: !!settings.publicTimetable,
      types: (settings.types || []).map(t => ({ id: t.id, name: t.name, talk: t.talk, qa: t.qa }))
    };
  }

  /* 一般公開ページに渡す内容（サーバー版の /api/program と同じ形）。
     公開フラグが立っていないあいだはタイムテーブルの中身を渡さない。
     下書きを持つ発表日の登録は渡さない（下書きから外した発表を見せないため）。 */
  function programPayload(data) {
    const s = data.settings;
    if (!s.publicTimetable) return { published: false };
    const tt = data.timetable;
    const drafted = new Set();
    if (tt && typeof tt === "object") {
      if (tt.days && typeof tt.days === "object" && !Array.isArray(tt.days))
        Object.keys(tt.days).forEach(k => drafted.add(String(k)));
      else if (Array.isArray(tt.talkList) || tt.start)
        drafted.add(eventDates(s)[0] || "");   // 発表日を持たなかったころの下書き
    }
    return {
      published: true,
      eventName: s.eventName,
      venue: s.venue || "",
      eventStart: s.eventStart || "",
      eventEnd: s.eventEnd || "",
      types: (s.types || []).map(t => ({ id: t.id, name: t.name, talk: t.talk, qa: t.qa,
                                         emphasis: t.emphasis === true })),
      timetable: data.timetable,
      registrations: (data.registrations || [])
        .filter(r => !drafted.has(isoDate(r.date)))
        .map(r => ({
          typeId: r.typeId, typeName: r.typeName, title: r.title,
          speaker: r.speaker, affiliation: r.affiliation, date: r.date
        }))
    };
  }

  /* ---------------- server 実装 ---------------- */

  /* 編集ロックはログイン単位ではなく画面単位で持つので、開いている画面を識別する値を
     すべてのリクエストに付ける。開き直すと変わるので、同じログインの別タブとも区別できる。 */
  const PAGE_ID = uid();

  /* extra はページを離れるときの解放（keepalive）のような fetch のオプション。 */
  async function http(path, method, body, extra) {
    const opts = Object.assign({
      method: method || "GET",
      credentials: "same-origin",
      headers: { "Accept": "application/json", "X-TM-Request": "1", "X-TM-Page": PAGE_ID }
    }, extra || {});
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (_) {
      throw fail("サーバーに接続できませんでした。通信状況をご確認ください。", 0);
    }
    let data = null;
    if (res.status !== 204) {
      const txt = await res.text();
      if (txt) { try { data = JSON.parse(txt); } catch (_) { data = null; } }
    }
    if (!res.ok) throw fail((data && data.error) || `エラーが発生しました（${res.status}）。`, res.status);
    return data || {};
  }

  const serverApi = {
    getConfig: () => http("api/config"),
    getProgram: () => http("api/program"),
    register: input => http("api/registrations", "POST", input),
    session: () => http("api/admin/session"),
    login: password => http("api/admin/login", "POST", { password }),
    logout: () => http("api/admin/logout", "POST"),
    getData: () => http("api/admin/data"),
    /* 編集ロック。acquireLock は取得と心拍を兼ねる（force で他の人から引き継ぐ）。
       どの画面のものかは X-TM-Page（上の PAGE_ID）で判別する。 */
    getLock: () => http("api/admin/lock"),
    acquireLock: (name, force) =>
      http("api/admin/lock", "POST", { name: name || "", force: !!force }),
    releaseLock: extra => http("api/admin/lock", "DELETE", undefined, extra),
    saveSettings: settings => http("api/admin/settings", "PUT", { settings }),
    addRegistration: input => http("api/admin/registrations", "POST", input),
    updateRegistration: (id, input) =>
      http("api/admin/registrations/" + encodeURIComponent(id), "PUT", input),
    deleteRegistration: id =>
      http("api/admin/registrations/" + encodeURIComponent(id), "DELETE"),
    saveTimetable: timetable => http("api/admin/timetable", "PUT", { timetable })
  };

  /* ---------------- demo 実装（localStorage） ---------------- */

  /* デモの初期状態。設定（種別・会期・参加登録キー）だけを用意し、登録は空にしておく。
     中身は参加登録ページから申し込むか、管理画面のデモ用の一括生成（bulkDemo）で作る。
     タイムテーブルの下書きも持たせない（下書きの無い発表日は、タイムテーブルタブを
     開いたときにその日の登録一覧から組み立てられる）。 */
  function demoSeed() {
    const days = ["2026-04-10", "2026-04-11"];
    return {
      version: 1,
      settings: {
        eventName: "第12回 サンプル研究発表会",
        venue: "サンプル大学 大ホール",
        notice: "発表申込は下記フォームからお願いします。1件ずつ登録してください。\n"
              + "内容の修正・取り消しは事務局までご連絡ください。",
        registrationOpen: true,
        registrationKey: "demo",
        eventStart: days[0],
        eventEnd: days[days.length - 1],
        publicTimetable: true,      // デモでは公開ページも見られるようにしておく
        types: [
          { id: uid(), name: "発表A", talk: 20, qa: 5 },
          { id: uid(), name: "発表B", talk: 10, qa: 5 },
          { id: uid(), name: "ポスター発表", talk: 0, qa: 0 }
        ]
      },
      registrations: [],
      timetable: null
    };
  }

  /* デモ用の連番データ。件数の多いタイムテーブルの見え方をその場で試せるように、
     タイトル・発表者を連番、所属を数種類の使い回しで作る。
     種別は typeId で指定でき、指定が無ければ定義順に一巡ずつ割り当てる。
     発表日は会期を日ごとのまとまりで均等に（会期が未設定なら「未定」のまま）。 */
  const DEMO_BULK_MAX = 500;
  const DEMO_AFFILIATIONS = ["XXX大学", "YYY大学", "ZZZ大学", "○○工科大学", "△△研究所"];

  function demoBulkMake(settings, count, startNo, typeId) {
    const types = settings.types || [];
    if (!types.length) throw fail("種別が定義されていません。");
    const wanted = String(typeId == null ? "" : typeId);
    const only = wanted ? types.find(t => t.id === wanted) : null;
    if (wanted && !only) throw fail("種別を選択してください。");
    const days = eventDates(settings);
    const t0 = Date.now();
    const out = [];
    for (let i = 0; i < count; i++) {
      const type = only || types[i % types.length];
      const no = startNo + i;
      const stamp = new Date(t0 + i * 1000).toISOString();
      out.push({
        id: uid(),
        typeId: type.id, typeName: type.name,
        title: "Title " + no,
        speaker: "Name " + no,
        affiliation: DEMO_AFFILIATIONS[i % DEMO_AFFILIATIONS.length],
        date: days.length ? days[Math.floor(i * days.length / count)] : "",
        createdAt: stamp, updatedAt: stamp
      });
    }
    return out;
  }
  /* 追加のときに連番が重ならないよう、既存の "Title 12" から次の番号を決める。 */
  const DEMO_NO_RE = /^Title\s+(\d+)$/;
  function demoNextNo(registrations) {
    let max = 0;
    for (const r of registrations || []) {
      const m = DEMO_NO_RE.exec(String(r.title == null ? "" : r.title).trim());
      if (m) max = Math.max(max, +m[1]);
    }
    return max + 1;
  }

  function demoRead() {
    let raw = null;
    try { raw = localStorage.getItem(DEMO_STORAGE_KEY); } catch (_) { /* 非対応/無効 */ }
    if (raw) {
      try {
        const d = JSON.parse(raw);
        if (d && d.settings && Array.isArray(d.registrations)) return d;
      } catch (_) { /* 壊れていれば作り直す */ }
    }
    demoForget(DEMO_OLD_KEYS);
    const seeded = demoSeed();
    demoWrite(seeded);
    return seeded;
  }
  function demoForget(keys) {
    for (const k of keys) {
      try { localStorage.removeItem(k); } catch (_) { /* 無視 */ }
    }
  }
  function demoWrite(data) {
    try { localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(data)); } catch (_) { /* 無視 */ }
  }
  function demoMutate(fn) {
    const data = demoRead();
    const result = fn(data);
    demoWrite(data);
    return result;
  }
  const later = value => new Promise(r => setTimeout(() => r(value), 80));   // 通信っぽい間

  /* 編集ロック。デモ版はこのブラウザ1つしか使わないので、同じ形を返すだけで足りる。 */
  const DEMO_LEASE_MS = 120e3;
  let demoLock = null;
  function demoLockView() {
    if (demoLock && demoLock.expiresAt <= Date.now()) demoLock = null;
    return {
      held: !!demoLock, mine: !!demoLock, sameSession: false,
      pageId: demoLock ? PAGE_ID : "",
      name: demoLock ? demoLock.name : "",
      since: demoLock ? new Date(demoLock.since).toISOString() : "",
      expiresAt: demoLock ? new Date(demoLock.expiresAt).toISOString() : "",
      leaseMs: DEMO_LEASE_MS
    };
  }

  const demoApi = {
    getConfig: () => later(publicConfig(demoRead().settings, "demo")),
    getProgram: () => later(programPayload(demoRead())),
    register: input => later(demoMutate(data => {
      const s = data.settings;
      if (!s.registrationOpen) throw fail("現在、参加登録を受け付けていません。", 409);
      if (s.registrationKey && oneLine(input.key, LIMITS.key) !== s.registrationKey)
        throw fail("参加登録キーが正しくありません。", 403);
      const rec = buildRegistration(s, input, null);
      data.registrations.push(rec);
      return { ok: true, id: rec.id };
    })),
    session: () => later({ authenticated: true }),          // デモはパスワード不要
    login: () => later({ ok: true }),
    logout: () => later({ ok: true }),
    getData: () => later((d => ({
      settings: d.settings, registrations: d.registrations, timetable: d.timetable,
      lock: demoLockView()
    }))(demoRead())),
    getLock: () => later(demoLockView()),
    acquireLock: name => later((() => {
      const now = Date.now();
      demoLock = {
        name: oneLine(name, 40) || (demoLock ? demoLock.name : ""),
        since: demoLock ? demoLock.since : now,
        expiresAt: now + DEMO_LEASE_MS
      };
      return Object.assign({ ok: true, tookOver: false }, demoLockView());
    })()),
    releaseLock: () => later((() => {
      demoLock = null;
      return Object.assign({ ok: true }, demoLockView());
    })()),
    saveSettings: settings => later(demoMutate(data => {
      const s = data.settings;
      if ("eventName" in settings) s.eventName = oneLine(settings.eventName, LIMITS.eventName) || "研究発表会";
      if ("venue" in settings) s.venue = oneLine(settings.venue, LIMITS.venue);
      if ("notice" in settings) s.notice = multiLine(settings.notice, LIMITS.notice);
      if ("registrationOpen" in settings) s.registrationOpen = !!settings.registrationOpen;
      if ("registrationKey" in settings) s.registrationKey = oneLine(settings.registrationKey, LIMITS.key);
      if ("publicTimetable" in settings) s.publicTimetable = !!settings.publicTimetable;
      if ("eventStart" in settings || "eventEnd" in settings) {
        const p = normalizePeriod("eventStart" in settings ? settings.eventStart : s.eventStart,
                                  "eventEnd" in settings ? settings.eventEnd : s.eventEnd);
        if (p.eventStart && daySpan(p.eventStart, p.eventEnd) > MAX_EVENT_DAYS)
          throw fail(`会期は最大${MAX_EVENT_DAYS}日までです。`);
        s.eventStart = p.eventStart; s.eventEnd = p.eventEnd;
      }
      if (Array.isArray(settings.types)) {
        const seen = new Set();
        const next = settings.types.map((t, i) => {
          let id = typeof t.id === "string" && t.id && !seen.has(t.id) ? t.id : uid();
          seen.add(id);
          return {
            id,
            name: oneLine(t.name, LIMITS.typeName) || ("種別" + (i + 1)),
            talk: Math.min(600, Math.max(0, Math.round(+t.talk) || 0)),
            qa: Math.min(600, Math.max(0, Math.round(+t.qa) || 0)),
            emphasis: t.emphasis === true
          };
        });
        if (!next.length) throw fail("種別は1つ以上必要です。");
        s.types = next;
        const byId = new Map(next.map(t => [t.id, t]));
        for (const r of data.registrations) {
          const t = byId.get(r.typeId);
          if (t) r.typeName = t.name;
        }
      }
      // 会期の外に出てしまった発表日は未定に戻す
      const days = new Set(eventDates(s));
      let cleared = 0;
      for (const r of data.registrations) {
        const d = isoDate(r.date);
        if (d && !days.has(d)) cleared++;
        r.date = days.has(d) ? d : "";
      }
      return { ok: true, settings: s, cleared };
    })),
    addRegistration: input => later(demoMutate(data => {
      const rec = buildRegistration(data.settings, input, null);
      data.registrations.push(rec);
      return { ok: true, registration: rec };
    })),
    updateRegistration: (id, input) => later(demoMutate(data => {
      const i = data.registrations.findIndex(r => r.id === id);
      if (i < 0) throw fail("該当する登録が見つかりません。", 404);
      const next = buildRegistration(data.settings, input, data.registrations[i]);
      data.registrations[i] = next;
      return { ok: true, registration: next };
    })),
    deleteRegistration: id => later(demoMutate(data => {
      const i = data.registrations.findIndex(r => r.id === id);
      if (i < 0) throw fail("該当する登録が見つかりません。", 404);
      data.registrations.splice(i, 1);
      return { ok: true };
    })),
    saveTimetable: timetable => later(demoMutate(data => {
      data.timetable = timetable && typeof timetable === "object" ? timetable : null;
      return { ok: true };
    })),
    resetDemo: () => {
      demoForget([DEMO_STORAGE_KEY]);
      return later({ ok: true });
    },
    /* 連番の登録データを一覧の後ろに足す。typeId が空なら種別は順番に割り当てる。 */
    bulkDemo: (count, typeId) => later(demoMutate(data => {
      const n = Math.min(DEMO_BULK_MAX, Math.max(1, Math.round(+count) || 0));
      const made = demoBulkMake(data.settings, n, demoNextNo(data.registrations), typeId);
      data.registrations = data.registrations.concat(made);
      return { ok: true, added: made.length, total: data.registrations.length };
    })),
    /* 登録だけを空にする（設定とタイムテーブルの下書きは残す。
       下書きの扱いは、登録を1件ずつ削除したときと同じ）。 */
    clearDemo: () => later(demoMutate(data => {
      const removed = data.registrations.length;
      data.registrations = [];
      return { ok: true, removed };
    }))
  };

  /* ---------------- モード判定 ---------------- */

  let impl = null;

  async function init() {
    if (MODE) return impl.getConfig();

    let res = null;
    try {
      res = await fetch("api/config", { headers: { "Accept": "application/json" }, credentials: "same-origin" });
    } catch (_) {
      res = null;                       // 通信できない = 静的ホスティング
    }

    if (res && res.ok) {
      let cfg = null;
      try { cfg = await res.json(); } catch (_) { cfg = null; }
      if (cfg && cfg.mode === "server") {
        MODE = "server"; impl = serverApi;
        return cfg;
      }
    } else if (res && res.status >= 500) {
      throw fail(`サーバーが応答しませんでした（${res.status}）。しばらくしてから再読み込みしてください。`, res.status);
    }

    MODE = "demo"; impl = demoApi;
    return impl.getConfig();
  }

  const api = {
    init,
    isoDate, eventDates, dateLabel,
    pageId: () => PAGE_ID,
    mode: () => MODE,
    isDemo: () => MODE === "demo",
    resetDemo: () => (MODE === "demo" ? demoApi.resetDemo() : Promise.resolve({ ok: false })),
    /* デモ版だけの機能。サーバー版には対応するAPIが無いので呼ばれたら断る。 */
    bulkDemo: (count, typeId) => (MODE === "demo"
      ? demoApi.bulkDemo(count, typeId)
      : Promise.reject(fail("デモモードでのみ使えます。", 400))),
    clearDemo: () => (MODE === "demo"
      ? demoApi.clearDemo()
      : Promise.reject(fail("デモモードでのみ使えます。", 400))),
    bulkDemoMax: () => DEMO_BULK_MAX
  };
  for (const name of ["getConfig", "getProgram", "register", "session", "login", "logout", "getData",
                      "getLock", "acquireLock", "releaseLock",
                      "saveSettings", "addRegistration", "updateRegistration",
                      "deleteRegistration", "saveTimetable"]) {
    api[name] = function () {
      if (!impl) return Promise.reject(fail("初期化が完了していません。", 500));
      return impl[name].apply(impl, arguments);
    };
  }
  return api;
})();
