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
    adding: false      // 新規追加の行を出しているか
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

  function fmtStamp(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderMasthead() {
    const s = state.settings;
    $("#adm-event").textContent = s.eventName;
    document.title = s.eventName + " 管理画面";
    $("#adm-summary").innerHTML =
      `<span>登録 <b>${state.registrations.length}</b> 件</span>` +
      `<span>受付 <b>${s.registrationOpen ? "受付中" : "停止"}</b></span>` +
      `<span>キー <b>${s.registrationKey ? "設定あり" : "なし"}</b></span>`;
    $("#tab-regs-n").textContent = String(state.registrations.length);
  }

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
        source: { registrations: state.registrations, types: state.settings.types },
        draft: state.timetable,
        saveDraft: async draft => {
          state.timetable = draft;
          try {
            await TM.saveTimetable(draft);
          } catch (err) {
            if (handleAuthError(err)) return;
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
    if (ttMounted) Timetable.setSource({ registrations: state.registrations, types: state.settings.types });
  }

  /* ---------------- 登録一覧 ---------------- */
  function typeOptions(selectedId) {
    return state.settings.types.map(t =>
      `<option value="${esc(t.id)}"${t.id === selectedId ? " selected" : ""}>${esc(t.name)}</option>`
    ).join("");
  }

  function editorRow(rec, index) {
    const r = rec || { typeId: "", title: "", speaker: "", affiliation: "" };
    return `<tr class="editing" data-edit="${esc(r.id || "")}">
      <td class="num">${index == null ? "＋" : index + 1}</td>
      <td><select data-f="typeId">
        <option value="">選択</option>${typeOptions(r.typeId)}
      </select></td>
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
        for (const f of ["typeId", "title", "speaker", "affiliation"]) {
          const el = next.querySelector(`[data-f="${f}"]`);
          if (el) el.value = keep.values[f];
        }
      }
    }

    $("#rg-empty").hidden = !!(rows.length);
    renderMasthead();
  }

  function collectEditor(tr) {
    const get = f => {
      const el = tr.querySelector(`[data-f="${f}"]`);
      return el ? el.value : "";
    };
    return { typeId: get("typeId"), title: get("title"), speaker: get("speaker"), affiliation: get("affiliation") };
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
      if (handleAuthError(err)) return;
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
      if (handleAuthError(err)) return;
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
    const header = ["発表種別", "タイトル", "発表者", "所属", "登録日時"];
    const lines = [header.map(csvCell).join(",")];
    for (const r of state.registrations)
      lines.push([r.typeName || "", r.title, r.speaker, r.affiliation, fmtStamp(r.createdAt)]
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
        <div class="nums" style="grid-template-columns:1fr 1fr 1fr">
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
            <input type="text" value="${used}" disabled>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  function fillSettings() {
    const s = state.settings;
    $("#st-open").checked = !!s.registrationOpen;
    $("#st-key").value = s.registrationKey || "";
    $("#st-event").value = s.eventName || "";
    $("#st-notice").value = s.notice || "";
    $("#st-url").value = new URL("index.html", location.href).href;
    draftTypes = s.types.map(t => ({
      id: t.id, name: t.name, talk: t.talk, qa: t.qa, emphasis: t.emphasis === true
    }));
    renderSettingTypes();
    setSettingStatus("変更後に押してください。");
  }

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
    const btn = $("#st-save");
    btn.disabled = true;
    setSettingStatus("保存中…");
    try {
      const res = await TM.saveSettings({
        eventName: $("#st-event").value,
        notice: $("#st-notice").value,
        registrationOpen: $("#st-open").checked,
        registrationKey: $("#st-key").value,
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
      notice("設定を保存しました。", "ok");
    } catch (err) {
      if (handleAuthError(err)) return;
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
    $("#loading").hidden = true;
    if (!ok) return;
    $("#shell").hidden = false;
    selectTab(0);
  }

  boot();
})();
