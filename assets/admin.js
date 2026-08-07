"use strict";

/* 管理画面のシェル。
   - 登録一覧の閲覧・編集・削除・CSV出力
   - 受付設定（参加登録キー・受付の開始/停止・種別マスタ・案内文）
   - タイムテーブル作成タブ（assets/timetable.js）への受け渡し

   サーバー版では admin.html 自体がログイン後にしか返らない。
   セッションが切れて 401 になった場合は再読み込みしてログイン画面に戻す。
   デモ版（GitHub Pages など）はパスワード不要で、データは localStorage。 */

(function () {

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s)
    .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const state = {
    settings: null,
    registrations: [],
    timetable: null,
    editingId: null,   // 編集中の登録ID
    adding: false,     // 新規追加の行を出しているか
    /* 編集ロックの状態（サーバーの /api/admin/lock が正）。
       mine が false のあいだ、この画面は閲覧モードで一切変更できない。 */
    lock: { held: false, mine: false, sameSession: false, pageId: "",
            name: "", since: "", expiresAt: "", leaseMs: 120000 }
  };
  let ttMounted = false;

  /* ---------------- 共通 ---------------- */
  function notice(msg, kind) {
    const n = $("#notice");
    if (!msg) { n.className = "notice"; n.innerHTML = ""; return; }
    const icon = kind === "ok" ? "✓" : kind === "err" ? "✕" : "！";
    n.className = "notice show " + (kind || "info");
    n.innerHTML = `<span style="font-weight:700">${icon}</span><div class="grow">${esc(msg)}</div>`;
    if (kind === "ok") setTimeout(() => { if (n.className.indexOf("ok") >= 0) notice(""); }, 4000);
  }

  /* セッション切れならログイン画面へ戻す。それ以外は false を返して呼び出し側で扱う。 */
  function handleAuthError(err) {
    if (err && err.status === 401 && !TM.isDemo()) {
      notice("セッションが切れました。ログイン画面に戻ります。", "warn");
      setTimeout(() => location.reload(), 900);
      return true;
    }
    return false;
  }

  /* ---------------- 編集ロック ----------------
     管理画面は同時に1人しか編集できない。編集権を持っていない画面は閲覧モードで、
     #shell の中の操作（data-ro="1" を除く）をすべて止める。実際の防御はサーバー側
     （更新系APIが 423 を返す）にあり、ここはその手前で操作させないための層。 */

  const NAME_KEY = "tm-admin-name";      // 名前は次回のために覚えておく
  const FLASH_KEY = "tm-admin-flash";    // 再読み込みをまたいで出すメッセージ
  /* このタブが編集中だったときの画面ID。再読み込み（編集開始・F5）で戻ってきたときに、
     空いていれば取り直し、まだ直前の自分が持っていれば引き継ぐために使う。
     sessionStorage なのでタブを閉じれば消え、閉じた場合は取り直さない。 */
  const EDIT_KEY = "tm-admin-editing";
  const editing = () => !!state.lock.mine;
  let tick = null;                       // 心拍（編集中）／空き待ち（閲覧中）のタイマー
  let losing = false;                    // 編集権を失ったあとの多重処理を防ぐ

  function store(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key) || "";
      value === null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value);
    } catch (_) { /* 無効でも動作に影響しない */ }
    return "";
  }
  function savedName() {
    try { return localStorage.getItem(NAME_KEY) || ""; } catch (_) { return ""; }
  }
  function rememberName(name) {
    try { localStorage.setItem(NAME_KEY, name); } catch (_) { /* 無視 */ }
  }

  function setLock(view) {
    if (view && typeof view === "object")
      state.lock = {
        held: !!view.held, mine: !!view.mine, sameSession: !!view.sameSession,
        pageId: String(view.pageId || ""), name: String(view.name || ""),
        since: String(view.since || ""), expiresAt: String(view.expiresAt || ""),
        leaseMs: +view.leaseMs > 0 ? +view.leaseMs : state.lock.leaseMs
      };
    // 再読み込みで戻ってきたときに引き継げるよう、持っているあいだは印を残す
    if (state.lock.mine) store(EDIT_KEY, TM.pageId());
    renderEditBar();
    applyEditable();
    return state.lock;
  }

  function renderEditBar() {
    const bar = $("#editbar");
    const l = state.lock;
    bar.hidden = false;
    bar.className = "editbar show" + (l.mine ? " mine" : l.held ? " busy" : "");
    const since = l.since ? fmtStamp(l.since) : "";
    $("#eb-state").innerHTML = l.mine
      ? `<b>編集中</b>：あなた${l.name ? "（" + esc(l.name) + "）" : ""}
         ── ほかの管理者は閲覧のみになります。終わったら「編集を終了」を押してください。`
      : l.held
        ? (l.sameSession
            ? `<b>別のタブ（または別の端末）</b>が編集中です${since ? `（${esc(since)}から）` : ""}
               ── 同じログインでも、編集できるのは1つの画面だけです。`
            : `<b>${esc(l.name || "他の管理者")}</b>が編集中です${since ? `（${esc(since)}から）` : ""}。
               いまは閲覧のみです。`)
        : `<b>閲覧モード</b>です。変更するには「編集を開始」を押してください
           ── 同時に編集できるのは1人だけです。`;
    $("#eb-start").hidden = l.held;
    $("#eb-take").hidden = !(l.held && !l.mine);
    $("#eb-end").hidden = !l.mine;
  }

  /* 閲覧モードでは #shell の中のフォーム部品をすべて無効にする。 */
  function applyEditable() {
    const on = editing();
    document.body.classList.toggle("ro", !on);
    document.querySelectorAll("#shell button,#shell input,#shell select,#shell textarea")
      .forEach(el => { if (!el.closest("[data-ro='1']")) el.disabled = !on; });
  }

  /* タイムテーブルタブなどは自前で描き直すので、増えた部品にも無効化を掛け直す。 */
  let sweeping = false;
  new MutationObserver(() => {
    if (sweeping || editing()) return;
    sweeping = true;
    requestAnimationFrame(() => { sweeping = false; applyEditable(); });
  }).observe($("#shell"), { childList: true, subtree: true });

  /* 描き直しの隙をつかれないよう、実際のハンドラより先に捕まえて止める。 */
  for (const type of ["click", "change", "input", "submit", "dragstart", "drop"])
    document.addEventListener(type, e => {
      if (editing()) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (!t.closest("#shell")) return;          // 編集バー・ヘッダは閲覧モードでも使える
      if (t.closest("[data-ro='1']")) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

  function scheduleTick() {
    clearTimeout(tick);
    // 編集中は期限の1/3ごとに心拍を送る。閲覧中は空くのを待つだけなので10秒おき。
    const ms = editing() ? Math.max(15000, Math.round(state.lock.leaseMs / 3)) : 10000;
    tick = setTimeout(runTick, ms);
  }
  async function runTick() {
    try {
      // 編集中の POST は心拍を兼ねる。期限切れで空いていればそのまま取り直す。
      setLock(editing() ? await TM.acquireLock(state.lock.name, false) : await TM.getLock());
    } catch (err) {
      if (handleAuthError(err)) return;
      if (err.status === 409 || err.status === 423) return lostLock(err.message);
      /* 通信の一時的な失敗。次の周期で取り直す */
    }
    scheduleTick();
  }

  /* 編集権を失った（引き継がれた／期限切れのあいだに取られた）。
     手元の下書きはサーバーと食い違っている可能性があるので、読み込み直す。 */
  function lostLock(message) {
    if (losing) return;
    losing = true;
    clearTimeout(tick);
    store(EDIT_KEY, null);          // 取り直さない（自分のものではなくなった）
    state.lock.mine = false;
    state.lock.held = true;
    renderEditBar();
    applyEditable();
    notice((message || "編集権が他の管理者に引き継がれました。")
      + " 閲覧モードに戻ります。", "warn");
    setTimeout(() => location.reload(), 2000);
  }

  /* 更新系APIが編集権不足で弾かれた場合。呼び出し側は true なら後始末をしない。 */
  function handleLockError(err) {
    if (!err || err.status !== 423) return false;
    lostLock(err.message);
    return true;
  }

  function askName() {
    const v = prompt(
      "お名前を入力してください。\n他の管理者に「◯◯が編集中です」と表示されます（空欄でも構いません）。",
      savedName());
    return v === null ? null : String(v).replace(/\s+/g, " ").trim().slice(0, 40);
  }

  async function startEditing(force) {
    const l = state.lock;
    if (force && !confirm(
      `${l.sameSession ? "別のタブ（または別の端末）" : (l.name || "他の管理者")}が編集中です`
      + `${l.since ? `（${fmtStamp(l.since)}から）` : ""}。\n\n`
      + "編集権を引き継ぐと、そちらの画面は閲覧モードに切り替わり、\n"
      + "まだ保存していない変更は失われることがあります。\n\n引き継ぎますか？")) return;

    const name = askName();
    if (name === null) return;
    const btns = [$("#eb-start"), $("#eb-take")];
    btns.forEach(b => b.disabled = true);
    try {
      const res = await TM.acquireLock(name, force);
      rememberName(name);
      // 待っているあいだにサーバー側が変わっているので、手元を捨てて読み込み直す。
      // 特にタイムテーブルの下書きは、古い写しのまま編集すると相手の変更を消してしまう。
      store(EDIT_KEY, TM.pageId());
      store(FLASH_KEY, res.tookOver ? "編集権を引き継ぎました。" : "編集を開始しました。");
      location.reload();
    } catch (err) {
      btns.forEach(b => b.disabled = false);
      if (handleAuthError(err)) return;
      if (err.status === 409) {
        try { setLock(await TM.getLock()); } catch (_) { /* 表示はそのまま */ }
        notice(err.message + " 引き継ぐ場合は「編集を引き継ぐ」を押してください。", "warn");
        return;
      }
      notice(err.message || "編集を開始できませんでした。", "err");
    }
  }

  async function endEditing() {
    clearTimeout(tick);
    store(EDIT_KEY, null);
    try {
      setLock(await TM.releaseLock());
      notice("編集を終了しました。ほかの管理者が編集できます。", "ok");
    } catch (err) {
      if (handleAuthError(err)) return;
      notice(err.message || "編集を終了できませんでした。", "err");
    }
    scheduleTick();
  }

  $("#eb-start").addEventListener("click", () => startEditing(false));
  $("#eb-take").addEventListener("click", () => startEditing(true));
  $("#eb-end").addEventListener("click", endEditing);

  // タブを閉じた・別ページへ移った場合は、期限切れを待たずにその場で手放す
  // （再読み込みの場合は EDIT_KEY が残るので、戻ってきたときに取り直す）
  window.addEventListener("pagehide", () => {
    if (!editing() || TM.isDemo()) return;
    try {
      const p = TM.releaseLock({ keepalive: true });
      if (p && p.catch) p.catch(() => { /* 期限切れに任せる */ });
    } catch (_) { /* 同上 */ }
  });

  /* 会期（設定タブで指定した開始日〜終了日を1日ずつ展開したもの）。未設定なら空配列。 */
  const eventDates = () => (state.settings ? TM.eventDates(state.settings) : []);
  const ttSource = () => ({
    registrations: state.registrations, types: state.settings.types, dates: eventDates()
  });
  const dayLabel = (iso, i, n) => (n > 1 ? `${i + 1}日目 ` : "") + TM.dateLabel(iso);

  function fmtStamp(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderMasthead() {
    const s = state.settings;
    const dates = eventDates();
    $("#adm-event").textContent = s.eventName;
    document.title = s.eventName + " 管理画面";
    // class="ev" を付けた会期・会場だけが印刷にも出る（assets/timetable.css の @media print）。
    // 登録件数・受付状態などは管理用なので紙には出さない。
    $("#adm-summary").innerHTML =
      `<span>登録 <b>${state.registrations.length}</b> 件</span>` +
      (dates.length
        ? `<span class="ev">会期 <b>${TM.dateLabel(dates[0], true)}${
            dates.length > 1 ? "–" + TM.dateLabel(dates[dates.length - 1]) : ""}</b></span>`
        : "") +
      (s.venue ? `<span class="ev">会場 <b>${esc(s.venue)}</b></span>` : "") +
      `<span>受付 <b>${s.registrationOpen ? "受付中" : "停止"}</b></span>` +
      `<span>キー <b>${s.registrationKey ? "設定あり" : "なし"}</b></span>` +
      `<span>公開 <b>${s.publicTimetable ? "公開中" : "非公開"}</b></span>`;
    $("#tab-regs-n").textContent = String(state.registrations.length);
    renderPublicState();
  }

  /* タイムテーブルタブの公開状態の表示（保存済みの設定が正）。 */
  function renderPublicState() {
    const on = !!(state.settings && state.settings.publicTimetable);
    const badge = $("#tt-public-badge");
    badge.hidden = false;
    badge.className = "badge " + (on ? "on" : "off");
    badge.textContent = on ? "公開中" : "非公開";
    const link = $("#tt-public-open");
    link.hidden = !on;
    link.href = programUrl();
  }
  const programUrl = () => new URL("program.html", location.href).href;

  /* ---------------- タブ ---------------- */
  const TABS = [
    { tab: "#tab-regs", panel: "#panel-regs" },
    { tab: "#tab-tt", panel: "#panel-tt" },
    { tab: "#tab-set", panel: "#panel-set" }
  ];
  function selectTab(which) {
    TABS.forEach((t, i) => {
      const on = i === which;
      $(t.tab).setAttribute("aria-selected", on ? "true" : "false");
      $(t.panel).hidden = !on;
    });
    if (which === 1 && !ttMounted) {
      ttMounted = true;
      Timetable.mount({
        source: ttSource(),
        draft: state.timetable,
        // 閲覧モードでも発表日は切り替えて見られる。ただし保存はしない
        canSave: editing,
        saveDraft: async draft => {
          state.timetable = draft;
          if (!editing()) return;    // 閲覧モードでは自動保存しない
          try {
            await TM.saveTimetable(draft);
          } catch (err) {
            if (handleAuthError(err) || handleLockError(err)) return;
            throw err;
          }
        }
      });
    }
  }
  TABS.forEach((t, i) => $(t.tab).addEventListener("click", () => selectTab(i)));
  // タイムテーブルタブの「発表種別」は閲覧のみ。編集は設定タブへ送る
  $("#tt-goto-set").addEventListener("click", () => {
    selectTab(2);
    $("#panel-set").scrollIntoView({ block: "start" });
  });

  function syncTimetableSource() {
    if (ttMounted) Timetable.setSource(ttSource());
  }

  /* ---------------- 登録一覧 ---------------- */
  function typeOptions(selectedId) {
    return state.settings.types.map(t =>
      `<option value="${esc(t.id)}"${t.id === selectedId ? " selected" : ""}>${esc(t.name)}</option>`
    ).join("");
  }

  /* 発表日のドロップダウン。会期が未設定なら選べるものが無いので "—" を出す。 */
  function dateOptions(selected) {
    const dates = eventDates();
    const cur = dates.indexOf(selected) >= 0 ? selected : "";
    return `<option value=""${cur ? "" : " selected"}>未定</option>` +
      dates.map((d, i) =>
        `<option value="${d}"${d === cur ? " selected" : ""}>${esc(dayLabel(d, i, dates.length))}</option>`
      ).join("");
  }
  function dateCell(rec, editing) {
    if (!eventDates().length)
      return `<td class="date-cell"><span class="date-none" title="「設定」タブで会期を指定すると選べます">—</span></td>`;
    const attr = editing ? 'data-f="date"' : `class="date-sel" data-id="${esc(rec.id)}"`;
    return `<td class="date-cell"><select ${attr} aria-label="発表日">${
      dateOptions((rec && rec.date) || "")}</select></td>`;
  }

  function editorRow(rec, index) {
    const r = rec || { typeId: "", title: "", speaker: "", affiliation: "" };
    return `<tr class="editing" data-edit="${esc(r.id || "")}">
      <td class="num">${index == null ? "＋" : index + 1}</td>
      <td><select data-f="typeId">
        <option value="">選択</option>${typeOptions(r.typeId)}
      </select></td>
      ${dateCell(r, true)}
      <td><input type="text" data-f="title" maxlength="300" value="${esc(r.title)}" placeholder="発表タイトル"></td>
      <td><input type="text" data-f="speaker" maxlength="200" value="${esc(r.speaker)}" placeholder="山田 太郎"></td>
      <td><input type="text" data-f="affiliation" maxlength="200" value="${esc(r.affiliation)}" placeholder="○○大学"></td>
      <td class="stamp">${rec ? esc(fmtStamp(rec.createdAt)) : "—"}</td>
      <td class="rowacts">
        <button class="btn small" data-act="save">保存</button>
        <button class="btn ghost small" data-act="cancel">取消</button>
      </td>
    </tr>`;
  }

  function renderRegistrations() {
    const body = $("#rg-body");
    const rows = [];

    // 別の保存処理が並行して再描画すると、開いている編集行の入力が消えてしまう。
    // 入力途中の値を取っておいて描き直したあとに戻す。
    const open = body.querySelector("tr.editing");
    const keep = open ? { key: open.dataset.edit, values: collectEditor(open) } : null;

    if (state.adding) rows.push(editorRow(null, null));

    state.registrations.forEach((r, i) => {
      if (r.id === state.editingId) { rows.push(editorRow(r, i)); return; }
      rows.push(`<tr data-id="${esc(r.id)}">
        <td class="num">${i + 1}</td>
        <td><span class="badge talk">${esc(r.typeName || "—")}</span></td>
        ${dateCell(r, false)}
        <td style="font-weight:600">${esc(r.title)}</td>
        <td>${esc(r.speaker)}</td>
        <td style="color:var(--ink-soft)">${esc(r.affiliation)}</td>
        <td class="stamp">${esc(fmtStamp(r.createdAt))}</td>
        <td class="rowacts">
          <button class="btn ghost small" data-act="edit">編集</button>
          <button class="btn danger small" data-act="delete">削除</button>
        </td>
      </tr>`);
    });

    body.innerHTML = rows.join("");

    if (keep) {
      const next = body.querySelector("tr.editing");
      if (next && next.dataset.edit === keep.key) {
        for (const f of ["typeId", "date", "title", "speaker", "affiliation"]) {
          const el = next.querySelector(`[data-f="${f}"]`);
          if (el) el.value = keep.values[f];
        }
      }
    }

    $("#rg-empty").hidden = !!(rows.length);
    renderMasthead();
    applyEditable();     // 描き直した行のボタンにも閲覧モードを掛ける
  }

  function collectEditor(tr) {
    const get = f => {
      const el = tr.querySelector(`[data-f="${f}"]`);
      return el ? el.value : "";
    };
    return { typeId: get("typeId"), date: get("date"),
             title: get("title"), speaker: get("speaker"), affiliation: get("affiliation") };
  }

  async function saveEditor(tr) {
    const id = tr.dataset.edit;
    const input = collectEditor(tr);
    const btns = tr.querySelectorAll("button");
    btns.forEach(b => b.disabled = true);
    try {
      if (id) {
        const res = await TM.updateRegistration(id, input);
        const i = state.registrations.findIndex(r => r.id === id);
        if (i >= 0) state.registrations[i] = res.registration;
        state.editingId = null;
        notice("登録を更新しました。", "ok");
      } else {
        const res = await TM.addRegistration(input);
        // 並行して再読み込みが走っていた場合、すでに一覧に入っていることがある
        if (!state.registrations.some(r => r.id === res.registration.id))
          state.registrations.push(res.registration);
        state.adding = false;
        notice("登録を追加しました。", "ok");
      }
      renderRegistrations();
      syncTimetableSource();
    } catch (err) {
      if (handleAuthError(err) || handleLockError(err)) return;
      notice(err.message || "保存できませんでした。", "err");
      btns.forEach(b => b.disabled = false);
    }
  }

  async function deleteRegistration(id) {
    const rec = state.registrations.find(r => r.id === id);
    if (!rec) return;
    if (!confirm(`「${rec.title}」（${rec.speaker}）の登録を削除します。よろしいですか？`)) return;
    try {
      await TM.deleteRegistration(id);
      state.registrations = state.registrations.filter(r => r.id !== id);
      if (state.editingId === id) state.editingId = null;
      renderRegistrations();
      syncTimetableSource();
      notice("登録を削除しました。", "ok");
    } catch (err) {
      if (handleAuthError(err) || handleLockError(err)) return;
      notice(err.message || "削除できませんでした。", "err");
    }
  }

  $("#rg-body").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const tr = btn.closest("tr");
    const act = btn.dataset.act;
    if (act === "edit") { state.adding = false; state.editingId = tr.dataset.id; renderRegistrations(); return; }
    if (act === "delete") { deleteRegistration(tr.dataset.id); return; }
    if (act === "cancel") { state.editingId = null; state.adding = false; renderRegistrations(); return; }
    if (act === "save") { saveEditor(tr); return; }
  });

  /* 一覧の発表日は編集モードに入らずその場で保存する。 */
  $("#rg-body").addEventListener("change", async e => {
    const sel = e.target.closest("select.date-sel");
    if (!sel) return;
    const id = sel.dataset.id;
    const rec = state.registrations.find(r => r.id === id);
    if (!rec) return;
    const prev = rec.date || "";
    const next = sel.value;
    if (prev === next) return;
    sel.disabled = true;
    try {
      const res = await TM.updateRegistration(id, {
        typeId: rec.typeId, title: rec.title, speaker: rec.speaker,
        affiliation: rec.affiliation, date: next
      });
      const i = state.registrations.findIndex(r => r.id === id);
      if (i >= 0) state.registrations[i] = res.registration;
      sel.disabled = false;
      sel.value = res.registration.date || "";
      syncTimetableSource();
      notice(`「${rec.title}」の発表日を${
        res.registration.date ? TM.dateLabel(res.registration.date, true) : "未定"}にしました。`, "ok");
    } catch (err) {
      sel.disabled = false;
      sel.value = prev;
      if (handleAuthError(err) || handleLockError(err)) return;
      notice(err.message || "発表日を変更できませんでした。", "err");
    }
  });

  $("#rg-add").addEventListener("click", () => {
    state.adding = true;
    state.editingId = null;
    renderRegistrations();
    const first = $("#rg-body select[data-f=typeId]");
    if (first) first.focus();
  });

  $("#rg-reload").addEventListener("click", () => reload(true));

  function csvCell(v) {
    v = v == null ? "" : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  $("#rg-export").addEventListener("click", () => {
    const header = ["発表種別", "発表日", "タイトル", "発表者", "所属", "登録日時"];
    const lines = [header.map(csvCell).join(",")];
    for (const r of state.registrations)
      lines.push([r.typeName || "", (r.date || "").replace(/-/g, "/"),
                  r.title, r.speaker, r.affiliation, fmtStamp(r.createdAt)]
        .map(csvCell).join(","));
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "registrations.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    notice(`登録 ${state.registrations.length} 件をCSVにエクスポートしました。`, "ok");
  });

  /* ---------------- 設定 ---------------- */
  let draftTypes = [];   // 保存を押すまではここで編集する

  function renderSettingTypes() {
    const box = $("#st-types");
    if (!draftTypes.length) {
      box.innerHTML = `<div class="type-empty">種別がありません（1つ以上必要です）</div>`;
      return;
    }
    const counts = new Map();
    for (const r of state.registrations) counts.set(r.typeId, (counts.get(r.typeId) || 0) + 1);

    box.innerHTML = draftTypes.map((t, i) => {
      const used = counts.get(t.id) || 0;
      return `<div class="type-row" data-i="${i}">
        <div class="head">
          <input class="name" type="text" data-k="name" maxlength="60"
                 placeholder="種別名（一般講演 等）" value="${esc(t.name)}">
          <label class="emph-check" title="タイムテーブルで行に背景色を付けて強調します">
            <input type="checkbox" data-k="emphasis"${t.emphasis ? " checked" : ""}> 強調
          </label>
        </div>
        <button class="kill" data-del="${i}" title="削除"${used ? ' data-used="' + used + '"' : ""}>×</button>
        <div class="nums">
          <div>
            <span class="mini">発表(分)</span>
            <input type="number" data-k="talk" min="0" max="600" step="1" value="${t.talk}">
          </div>
          <div>
            <span class="mini">質疑(分)</span>
            <input type="number" data-k="qa" min="0" max="600" step="1" value="${t.qa}">
          </div>
          <div>
            <span class="mini">登録数</span>
            <input type="text" value="${used}" data-ro="1" disabled>
          </div>
        </div>
      </div>`;
    }).join("");
    applyEditable();
  }

  /* 会期の入力欄の下に、いま何日間になるかを出す。 */
  function renderDateHint() {
    const dates = TM.eventDates({
      eventStart: $("#st-date-start").value, eventEnd: $("#st-date-end").value
    });
    const el = $("#st-date-hint");
    if (!dates.length) {
      el.innerHTML = "未設定のままでも使えます。指定すると、登録一覧で<b>発表日</b>を選べるようになり、"
                   + "タイムテーブルを発表日ごとに作れます。";
      return;
    }
    const names = dates.length > 6
      ? [TM.dateLabel(dates[0]), TM.dateLabel(dates[1]), "…", TM.dateLabel(dates[dates.length - 1])]
      : dates.map(d => TM.dateLabel(d));
    el.innerHTML = `会期は <b>${dates.length}</b> 日間（${esc(names.join("・"))}）です。`
      + (dates.length === 1 ? "終了日を空欄にすると開始日と同じ日になります。" : "");
  }
  ["st-date-start", "st-date-end"].forEach(id =>
    $("#" + id).addEventListener("input", renderDateHint));

  function fillSettings() {
    const s = state.settings;
    $("#st-open").checked = !!s.registrationOpen;
    $("#st-key").value = s.registrationKey || "";
    $("#st-event").value = s.eventName || "";
    $("#st-date-start").value = s.eventStart || "";
    $("#st-date-end").value = s.eventEnd || "";
    renderDateHint();
    $("#st-venue").value = s.venue || "";
    $("#st-notice").value = s.notice || "";
    $("#st-url").value = new URL("index.html", location.href).href;
    $("#st-public").checked = !!s.publicTimetable;
    $("#st-public-url").value = programUrl();
    renderPublicTag();
    draftTypes = s.types.map(t => ({
      id: t.id, name: t.name, talk: t.talk, qa: t.qa, emphasis: t.emphasis === true
    }));
    renderSettingTypes();
    setSettingStatus("変更後に押してください。");
  }

  /* 「タイムテーブルの公開」パネルの見出しとリンク。
     公開されるのは保存済みの設定なので、チェックを入れただけではリンクを出さない。 */
  function renderPublicTag() {
    const saved = !!(state.settings && state.settings.publicTimetable);
    const now = $("#st-public").checked;
    $("#st-public-tag").textContent = saved
      ? (now ? "公開中" : "保存すると非公開になります")
      : (now ? "保存すると公開されます" : "非公開");
    const link = $("#st-public-open");
    link.hidden = !saved;
    link.href = programUrl();
  }
  $("#st-public").addEventListener("change", renderPublicTag);

  function setSettingStatus(text, ok) {
    const el = $("#st-status");
    el.textContent = text;
    el.className = "saved-tag" + (ok ? " on" : "");
  }

  $("#st-types").addEventListener("input", e => {
    const row = e.target.closest(".type-row"); if (!row) return;
    const t = draftTypes[+row.dataset.i]; if (!t) return;
    const k = e.target.dataset.k; if (!k) return;
    if (k === "name") t.name = e.target.value;
    else if (k === "emphasis") t.emphasis = e.target.checked;
    else t[k] = Math.min(600, Math.max(0, parseInt(e.target.value, 10) || 0));
  });
  $("#st-types").addEventListener("click", e => {
    const btn = e.target.closest("[data-del]"); if (!btn) return;
    const i = +btn.dataset.del;
    const used = +(btn.dataset.used || 0);
    if (used && !confirm(
      `この種別には ${used} 件の登録があります。削除すると、それらの登録は種別なしになります。よろしいですか？`)) return;
    draftTypes.splice(i, 1);
    renderSettingTypes();
  });
  $("#st-add-type").addEventListener("click", () => {
    const last = draftTypes[draftTypes.length - 1];
    draftTypes.push({ id: null, name: "", talk: last ? last.talk : 12, qa: last ? last.qa : 3,
                      emphasis: false });
    renderSettingTypes();
    const inputs = $("#st-types").querySelectorAll('input[data-k="name"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  $("#st-save").addEventListener("click", async () => {
    if (!draftTypes.length) { notice("種別は1つ以上必要です。", "err"); return; }
    // 会期を狭めると、そこから外れた発表日は未定に戻る。件数を見せて確認する
    const next = new Set(TM.eventDates({
      eventStart: $("#st-date-start").value, eventEnd: $("#st-date-end").value
    }));
    const losing = state.registrations.filter(r => r.date && !next.has(r.date)).length;
    if (losing && !confirm(
      `会期から外れる発表日が ${losing} 件あります。これらの発表日は「未定」に戻ります。よろしいですか？`)) return;
    // 非公開から公開に切り替えるときは、何が見えるようになるのかを確認する
    if ($("#st-public").checked && !state.settings.publicTimetable && !confirm(
      "タイムテーブルを一般公開します。発表のタイトル・発表者・所属が、"
      + "ログインなしで誰でも見られるようになります。よろしいですか？")) return;
    const wasPublic = !!state.settings.publicTimetable;
    const btn = $("#st-save");
    btn.disabled = true;
    setSettingStatus("保存中…");
    try {
      const res = await TM.saveSettings({
        eventName: $("#st-event").value,
        venue: $("#st-venue").value,
        notice: $("#st-notice").value,
        registrationOpen: $("#st-open").checked,
        registrationKey: $("#st-key").value,
        publicTimetable: $("#st-public").checked,
        eventStart: $("#st-date-start").value,
        eventEnd: $("#st-date-end").value,
        types: draftTypes.map(t => ({
          id: t.id || undefined, name: t.name, talk: t.talk, qa: t.qa, emphasis: !!t.emphasis
        }))
      });
      state.settings = res.settings;
      // 種別名の変更は既存の登録の表示名にも反映されるので、一覧を取り直す
      const data = await TM.getData();
      state.registrations = data.registrations;
      fillSettings();
      renderRegistrations();
      syncTimetableSource();
      setSettingStatus("保存しました。", true);
      const nowPublic = !!state.settings.publicTimetable;
      notice("設定を保存しました。"
        + (nowPublic !== wasPublic
            ? (nowPublic ? `タイムテーブルを公開しました（${programUrl()}）。`
                         : "タイムテーブルを非公開にしました。")
            : "")
        + (res.cleared ? `会期から外れた ${res.cleared} 件の発表日を「未定」に戻しました。` : ""),
        res.cleared ? "warn" : "ok");
    } catch (err) {
      if (handleAuthError(err) || handleLockError(err)) return;
      setSettingStatus("保存できませんでした。");
      notice(err.message || "設定を保存できませんでした。", "err");
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------------- ログアウト / デモ ---------------- */
  $("#adm-logout").addEventListener("click", async () => {
    try { await TM.logout(); } catch (_) { /* 失敗しても画面は戻す */ }
    location.href = "index.html";
  });
  $("#demo-reset").addEventListener("click", async () => {
    if (!confirm("デモデータを初期状態に戻します。よろしいですか？")) return;
    await TM.resetDemo();
    location.reload();
  });

  /* ---------------- 起動 ---------------- */
  async function reload(showMessage) {
    try {
      const data = await TM.getData();
      state.settings = data.settings;
      state.registrations = data.registrations;
      state.timetable = data.timetable;
      state.editingId = null;
      state.adding = false;
      setLock(data.lock);            // 編集権の状態も同じ応答で受け取る
      fillSettings();
      renderRegistrations();
      syncTimetableSource();
      if (showMessage) notice(`最新の状態を読み込みました（登録 ${state.registrations.length} 件）。`, "ok");
      return true;
    } catch (err) {
      if (handleAuthError(err)) return false;
      notice(err.message || "データを読み込めませんでした。", "err");
      return false;
    }
  }

  async function boot() {
    try {
      await TM.init();
    } catch (err) {
      $("#loading").hidden = true;
      notice(err.message || "サーバーに接続できませんでした。", "err");
      return;
    }
    if (TM.isDemo()) {
      $("#demo-bar").classList.add("show");
      // デモはこのブラウザ1つしか使わないので、編集権は最初から持たせておく
      try { setLock(await TM.acquireLock(savedName(), true)); } catch (_) { /* 無視 */ }
    } else {
      $("#adm-logout").hidden = false;
      try {
        const s = await TM.session();
        if (!s.authenticated) { location.reload(); return; }
      } catch (err) {
        if (handleAuthError(err)) return;
      }
    }

    const ok = await reload(false);

    /* 編集中に再読み込みしたタブは、編集権を引き継いで戻る。
       ・空いている              … そのまま取り直す（離れるときに手放せている）
       ・直前の自分がまだ持っている … 引き継ぐ（手放しが間に合わなかった場合）
       ・ほかの画面が持っている    … 閲覧モードのまま。印を消して次からは取りにいかない */
    const prev = TM.isDemo() ? "" : store(EDIT_KEY);
    if (prev && !state.lock.mine) {
      if (!state.lock.held || state.lock.pageId === prev) {
        try { setLock(await TM.acquireLock(savedName(), state.lock.held)); }
        catch (_) { /* 取れなければ閲覧のまま */ }
      } else {
        store(EDIT_KEY, null);
      }
    }

    $("#loading").hidden = true;
    if (!ok) return;
    $("#shell").hidden = false;
    selectTab(0);

    const flash = store(FLASH_KEY);
    if (flash) { store(FLASH_KEY, null); notice(flash, "ok"); }
    scheduleTick();
  }

  boot();
})();
