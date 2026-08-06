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

  const DEMO_STORAGE_KEY = "tm-demo-v1";
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
                   eventName: 120, notice: 2000, typeName: 60 };

  function oneLine(v, max) {
    return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
  }
  function multiLine(v, max) {
    return String(v == null ? "" : v).replace(/\r\n?/g, "\n").trim().slice(0, max);
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
    const now = new Date().toISOString();
    return {
      id: existing ? existing.id : uid(),
      typeId: type.id, typeName: type.name,
      title, speaker, affiliation,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };
  }

  function publicConfig(settings, mode) {
    return {
      mode,
      eventName: settings.eventName,
      notice: settings.notice,
      registrationOpen: settings.registrationOpen,
      keyRequired: !!settings.registrationKey,
      types: (settings.types || []).map(t => ({ id: t.id, name: t.name, talk: t.talk, qa: t.qa }))
    };
  }

  /* ---------------- server 実装 ---------------- */

  async function http(path, method, body) {
    const opts = {
      method: method || "GET",
      credentials: "same-origin",
      headers: { "Accept": "application/json", "X-TM-Request": "1" }
    };
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
    register: input => http("api/registrations", "POST", input),
    session: () => http("api/admin/session"),
    login: password => http("api/admin/login", "POST", { password }),
    logout: () => http("api/admin/logout", "POST"),
    getData: () => http("api/admin/data"),
    saveSettings: settings => http("api/admin/settings", "PUT", { settings }),
    addRegistration: input => http("api/admin/registrations", "POST", input),
    updateRegistration: (id, input) =>
      http("api/admin/registrations/" + encodeURIComponent(id), "PUT", input),
    deleteRegistration: id =>
      http("api/admin/registrations/" + encodeURIComponent(id), "DELETE"),
    saveTimetable: timetable => http("api/admin/timetable", "PUT", { timetable })
  };

  /* ---------------- demo 実装（localStorage） ---------------- */

  function demoSeed() {
    const types = [
      { id: uid(), name: "一般講演", talk: 12, qa: 3 },
      { id: uid(), name: "学生講演", talk: 10, qa: 5 },
      { id: uid(), name: "招待講演", talk: 30, qa: 10 },
      { id: uid(), name: "ポスター発表", talk: 3, qa: 0 }
    ];
    const samples = [
      [0, "深層学習による異常検知の高速化", "山田 太郎", "神戸大学 工学研究科"],
      [1, "分散合意アルゴリズムの実装と評価", "佐藤 花子", "神戸大学 システム情報学研究科"],
      [0, "無線センサネットワークの省電力設計", "鈴木 次郎", "株式会社サンプル研究所"],
      [1, "自然言語処理を用いた議事録要約", "高橋 三郎", "神戸大学 工学研究科"],
      [2, "これからの計算機システムを考える", "田中 教授", "サンプル大学"],
      [3, "軽量コンテナ基盤の運用事例", "伊藤 四郎", "サンプル情報システム部"]
    ];
    const t0 = Date.UTC(2026, 3, 10, 1, 0, 0);
    return {
      version: 1,
      settings: {
        eventName: "第12回 サンプル研究発表会",
        notice: "発表申込は下記フォームからお願いします。1件ずつ登録してください。\n"
              + "内容の修正・取り消しは事務局までご連絡ください。",
        registrationOpen: true,
        registrationKey: "demo2026",
        types
      },
      registrations: samples.map((s, i) => ({
        id: uid(),
        typeId: types[s[0]].id,
        typeName: types[s[0]].name,
        title: s[1], speaker: s[2], affiliation: s[3],
        createdAt: new Date(t0 + i * 3600e3).toISOString(),
        updatedAt: new Date(t0 + i * 3600e3).toISOString()
      })),
      timetable: null
    };
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
    const seeded = demoSeed();
    demoWrite(seeded);
    return seeded;
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

  const demoApi = {
    getConfig: () => later(publicConfig(demoRead().settings, "demo")),
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
      settings: d.settings, registrations: d.registrations, timetable: d.timetable
    }))(demoRead())),
    saveSettings: settings => later(demoMutate(data => {
      const s = data.settings;
      if ("eventName" in settings) s.eventName = oneLine(settings.eventName, LIMITS.eventName) || "研究発表会";
      if ("notice" in settings) s.notice = multiLine(settings.notice, LIMITS.notice);
      if ("registrationOpen" in settings) s.registrationOpen = !!settings.registrationOpen;
      if ("registrationKey" in settings) s.registrationKey = oneLine(settings.registrationKey, LIMITS.key);
      if (Array.isArray(settings.types)) {
        const seen = new Set();
        const next = settings.types.map((t, i) => {
          let id = typeof t.id === "string" && t.id && !seen.has(t.id) ? t.id : uid();
          seen.add(id);
          return {
            id,
            name: oneLine(t.name, LIMITS.typeName) || ("種別" + (i + 1)),
            talk: Math.min(600, Math.max(0, Math.round(+t.talk) || 0)),
            qa: Math.min(600, Math.max(0, Math.round(+t.qa) || 0))
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
      return { ok: true, settings: s };
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
      try { localStorage.removeItem(DEMO_STORAGE_KEY); } catch (_) { /* 無視 */ }
      return later({ ok: true });
    }
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
    mode: () => MODE,
    isDemo: () => MODE === "demo",
    resetDemo: () => (MODE === "demo" ? demoApi.resetDemo() : Promise.resolve({ ok: false }))
  };
  for (const name of ["getConfig", "register", "session", "login", "logout", "getData",
                      "saveSettings", "addRegistration", "updateRegistration",
                      "deleteRegistration", "saveTimetable"]) {
    api[name] = function () {
      if (!impl) return Promise.reject(fail("初期化が完了していません。", 500));
      return impl[name].apply(impl, arguments);
    };
  }
  return api;
})();
