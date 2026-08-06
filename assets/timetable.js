"use strict";

/* タイムテーブル作成ツール（管理画面の「タイムテーブル」タブ）。
   参加登録の一覧から発表順を受け取り、開始時刻・固定枠に合わせてコマを並べる。
   CSVの入出力と手動並べ替えは従来どおり。
   編集内容は下書きとして自動保存される（サーバー版はサーバー、デモ版は localStorage）。 */

window.Timetable = (function () {

  /* ---------------- state ---------------- */
  // 発表種別。count: 件数（null = 空欄。現在の件数を維持する）
  let talkTypes = [{ id: uid(), name: "発表", talk: 12, qa: 3, count: 20 }];
  let customSlots = [{ id: uid(), start: "15:00", end: "15:15", label: "休憩", type: "break" }];
  // 発表の並び順そのもの。手動で入れ替え可能で、再生成をまたいで保持される
  // {id, typeId, title, speaker}
  let talkList = [];
  let items = [];         // rendered rows
  let refocus = null;     // 再描画後にフォーカスを戻す並べ替えボタン
  let noticeLead = null;  // 次の generate() の通知に前置するメッセージ {msgs,type}
  let absolute = false;   // CSVの時刻をそのまま使っている状態か

  let ctx = null;         // {source:{registrations,types}, saveDraft(draft)}
  let mounted = false;
  let suspendSave = false;
  let saveTimer = null;

  /* ---------------- helpers ---------------- */
  function uid() { return Math.random().toString(36).slice(2, 9); }
  function toMin(t) {
    if (!t) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  function toStr(min) {
    if (min == null || isNaN(min)) return "";
    min = Math.round(min);
    const h = Math.floor(min / 60), m = ((min % 60) + 60) % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s)
    .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* 発表種別の配色（定義順に割り当て） */
  const TYPE_COLORS = [
    { chip: "#64748b", bg: "#f1f5f9", fg: "#475569" },
    { chip: "#0ea5e9", bg: "#e0f2fe", fg: "#0369a1" },
    { chip: "#8b5cf6", bg: "#ede9fe", fg: "#6d28d9" },
    { chip: "#ec4899", bg: "#fce7f3", fg: "#be185d" },
    { chip: "#14b8a6", bg: "#ccfbf1", fg: "#0f766e" },
    { chip: "#f97316", bg: "#ffedd5", fg: "#c2410c" }
  ];
  const typeColor = i => TYPE_COLORS[i % TYPE_COLORS.length];
  const typeLen = t => (t.talk || 0) + (t.qa || 0);
  const newEntry = typeId => ({ id: uid(), typeId, title: "", speaker: "" });

  function readSettings() {
    return {
      start: $("#tt-start").value,
      lunchOn: $("#tt-lunch-on").checked,
      lunchStart: $("#tt-lunch-start").value,
      lunchEnd: $("#tt-lunch-end").value,
      showGap: $("#tt-showgap").checked
    };
  }

  /* ---------------- 下書きの保存・復元 ---------------- */
  function serialize() {
    const s = readSettings();
    return {
      start: s.start, lunchOn: s.lunchOn, lunchStart: s.lunchStart, lunchEnd: s.lunchEnd,
      showGap: s.showGap,
      talkTypes: talkTypes.map(t => ({ id: t.id, name: t.name, talk: t.talk, qa: t.qa, count: t.count })),
      talkList: talkList.map(e => ({ id: e.id, typeId: e.typeId, title: e.title, speaker: e.speaker })),
      customSlots: customSlots.map(c => ({ id: c.id, start: c.start, end: c.end, label: c.label, type: c.type })),
      // CSVの時刻をそのまま使っている場合だけ、その時刻を保存して復元する
      absolute: absolute,
      items: absolute ? items.map(it => Object.assign({}, it)) : null,
      savedAt: new Date().toISOString()
    };
  }

  function scheduleSave() {
    if (suspendSave || !ctx || !ctx.saveDraft) return;
    setSaved("保存中…", false);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await ctx.saveDraft(serialize());
        setSaved("下書きを保存しました", true);
      } catch (err) {
        setSaved("下書きを保存できませんでした", false);
      }
    }, 800);
  }
  function setSaved(text, ok) {
    const el = $("#tt-saved");
    if (el) { el.textContent = text; el.className = "saved-tag" + (ok ? " on" : ""); }
  }

  function restore(draft) {
    if (!draft || typeof draft !== "object") return false;
    suspendSave = true;
    try {
      if (draft.start) $("#tt-start").value = draft.start;
      $("#tt-lunch-on").checked = draft.lunchOn !== false;
      if (draft.lunchStart) $("#tt-lunch-start").value = draft.lunchStart;
      if (draft.lunchEnd) $("#tt-lunch-end").value = draft.lunchEnd;
      $("#tt-showgap").checked = draft.showGap !== false;

      if (Array.isArray(draft.talkTypes) && draft.talkTypes.length) {
        talkTypes = draft.talkTypes.map((t, i) => ({
          id: typeof t.id === "string" && t.id ? t.id : uid(),
          name: String(t.name == null ? "" : t.name) || `種別${i + 1}`,
          talk: Math.max(0, parseInt(t.talk, 10) || 0),
          qa: Math.max(0, parseInt(t.qa, 10) || 0),
          count: t.count == null ? null : Math.max(0, parseInt(t.count, 10) || 0)
        }));
      }
      const known = new Set(talkTypes.map(t => t.id));
      if (Array.isArray(draft.talkList)) {
        talkList = draft.talkList
          .filter(e => e && known.has(e.typeId))
          .map(e => ({
            id: typeof e.id === "string" && e.id ? e.id : uid(),
            typeId: e.typeId,
            title: String(e.title == null ? "" : e.title),
            speaker: String(e.speaker == null ? "" : e.speaker)
          }));
      }
      if (Array.isArray(draft.customSlots)) {
        customSlots = draft.customSlots.filter(c => c && typeof c === "object").map(c => ({
          id: typeof c.id === "string" && c.id ? c.id : uid(),
          start: String(c.start || ""), end: String(c.end || ""),
          label: String(c.label == null ? "" : c.label),
          type: c.type === "custom" ? "custom" : "break"
        }));
      }
      renderTypes();
      renderSlots();

      if (draft.absolute && Array.isArray(draft.items) && draft.items.length) {
        absolute = true;
        items = draft.items;
        render();
        renderNotice([], "");
      } else {
        generate();
      }
      return true;
    } finally {
      suspendSave = false;
    }
  }

  /* ---------------- 参加登録からの読み込み ---------------- */
  function speakerLine(r) {
    const who = String(r.speaker || "").trim();
    const org = String(r.affiliation || "").trim();
    if (who && org) return `${who}（${org}）`;
    return who || org;
  }

  /* 登録一覧を発表順として取り込む。種別マスタの発表／質疑時間をそのまま使う。 */
  function loadFromRegistrations(quiet) {
    const src = (ctx && ctx.source) || { registrations: [], types: [] };
    const regs = src.registrations || [];
    const master = (src.types || []).map(t => ({
      id: t.id, name: t.name, talk: t.talk || 0, qa: t.qa || 0, count: 0
    }));

    const byId = new Map(master.map(t => [t.id, t]));
    const nextTypes = master.slice();
    const orphan = [];

    for (const r of regs) {
      let def = byId.get(r.typeId);
      if (!def) {
        // 種別マスタから削除された種別。登録に残っている名前で仮の種別を作る
        const name = String(r.typeName || "").trim() || "種別不明";
        def = nextTypes.find(t => t.__orphan && t.name === name);
        if (!def) {
          const donor = master[0];
          def = { id: "orphan-" + uid(), name, talk: donor ? donor.talk : 12,
                  qa: donor ? donor.qa : 3, count: 0, __orphan: true };
          nextTypes.push(def);
          orphan.push(name);
        }
        byId.set(r.typeId, def);
      }
      def.count++;
    }

    const used = nextTypes.filter(t => t.count > 0);
    talkTypes = (used.length ? used : nextTypes).map(t => ({
      id: t.id, name: t.name, talk: t.talk, qa: t.qa, count: t.count
    }));
    const live = new Set(talkTypes.map(t => t.id));

    talkList = regs.map(r => {
      const def = byId.get(r.typeId);
      const typeId = def && live.has(def.id) ? def.id : (talkTypes[0] ? talkTypes[0].id : null);
      return { id: uid(), typeId, title: r.title || "", speaker: speakerLine(r) };
    }).filter(e => e.typeId);

    absolute = false;
    renderTypes();
    renderSlots();

    const msgs = [`参加登録 ${talkList.length} 件を発表順として読み込みました。`];
    if (orphan.length)
      msgs.push(`種別マスタに無い種別（${[...new Set(orphan)].join("・")}）は登録に残っている名前で仮に作成しました。`);
    if (!quiet) noticeLead = { msgs, type: orphan.length ? "warn" : "ok" };
    generate();
    return talkList.length;
  }

  function updateLoadHint() {
    const el = $("#tt-load-hint");
    if (!el || !ctx) return;
    const n = ((ctx.source || {}).registrations || []).length;
    el.innerHTML = n
      ? `現在の登録は <b>${n}</b> 件です。読み込むと、いま表内にある発表と手動の並べ替えは登録一覧の内容で置き換わります。`
      : `登録がまだありません。参加登録ページから申込があると、ここから取り込めます。`;
  }

  /* ---------------- generation ---------------- */
  function generate() {
    const s = readSettings();
    const start = toMin(s.start);
    const warnings = [];

    const lead = noticeLead; noticeLead = null;
    absolute = false;

    if (start == null) {
      renderNotice(["開始時刻を正しく入力してください。"], "err");
      items = []; render(); return;
    }

    // 発表種別
    const specById = new Map();
    talkTypes.forEach((t, i) => {
      const spec = { id: t.id, name: t.name || `種別${i + 1}`, len: typeLen(t), colorIdx: i };
      specById.set(t.id, spec);
      if (spec.len <= 0 && t.count !== 0)
        warnings.push(`発表種別「${spec.name}」は発表＋質疑が0分のため配置しません。`);
    });

    // 発表リストを種別の件数に合わせる（並び順は保持し、増減は末尾で行う）
    talkList = talkList.filter(e => specById.has(e.typeId));
    for (const t of talkTypes) {
      if (t.count == null) continue;   // 空欄＝現在の件数のまま
      const idxs = [];
      talkList.forEach((e, i) => { if (e.typeId === t.id) idxs.push(i); });
      if (idxs.length > t.count) {
        const drop = new Set(idxs.slice(t.count));       // 後ろの分から削除
        talkList = talkList.filter((e, i) => !drop.has(i));
      } else {
        for (let n = idxs.length; n < t.count; n++) talkList.push(newEntry(t.id));
      }
    }
    if (!talkList.length) warnings.push("発表が0件です。「登録一覧から読み込む」か、発表種別の件数を指定してください。");

    // collect fixed slots
    let fixed = [];
    if (s.lunchOn) {
      const ls = toMin(s.lunchStart), le = toMin(s.lunchEnd);
      if (ls != null && le != null && le > ls) fixed.push({ type: "lunch", start: ls, end: le, label: "ランチ" });
      else warnings.push("ランチの時刻が不正です（開始<終了で指定してください）。");
    }
    customSlots.forEach(c => {
      const cs = toMin(c.start), ce = toMin(c.end);
      if (cs != null && ce != null && ce > cs) fixed.push({ type: c.type, start: cs, end: ce, label: c.label || "（無題）" });
      else if (c.start || c.end || c.label) warnings.push(`特別枠「${c.label || "無題"}」の時刻が不正です。`);
    });
    fixed.sort((a, b) => a.start - b.start || a.end - b.end);

    // 開始時刻より前に終わる固定枠は無視する
    const outside = fixed.filter(f => f.end <= start);
    if (outside.length) {
      fixed = fixed.filter(f => f.end > start);
      warnings.push(`開始時刻より前の枠（${outside.map(f => f.label).join("・")}）は配置しませんでした。`);
    }

    // detect overlaps among fixed
    for (let i = 1; i < fixed.length; i++) {
      if (fixed[i].start < fixed[i - 1].end)
        warnings.push(`固定枠が重複しています（${toStr(fixed[i - 1].start)}–${toStr(fixed[i - 1].end)} と ${toStr(fixed[i].start)}–${toStr(fixed[i].end)}）。`);
    }

    const out = [];
    let cursor = start;
    let li = 0;   // 発表リストの位置

    // to まで発表を並べる。to が null なら残りをすべて並べる
    function fill(to) {
      while (li < talkList.length) {
        const e = talkList[li];
        const spec = specById.get(e.typeId);
        if (!spec || spec.len <= 0) { li++; continue; }   // 0分の種別は配置しない
        if (to != null && cursor + spec.len > to) break;
        out.push({
          type: "talk", start: cursor, end: cursor + spec.len,
          entryId: e.id, typeName: spec.name, colorIdx: spec.colorIdx,
          title: e.title, speaker: e.speaker
        });
        cursor += spec.len; li++;
      }
      if (to != null && s.showGap && to - cursor >= 1) out.push({ type: "gap", start: cursor, end: to });
    }

    for (const f of fixed) {
      if (f.start > cursor) fill(f.start);
      out.push(Object.assign({}, f));
      cursor = Math.max(cursor, f.end);
    }
    fill(null);   // 残りは最後の固定枠のあとに続けて並べる

    items = out;
    renderNotice(lead ? lead.msgs.concat(warnings) : warnings,
                 warnings.length ? "warn" : (lead ? lead.type : ""));
    render();
    scheduleSave();
  }

  /* ---------------- rendering ---------------- */
  const KIND = {
    talk:   { label: "発表",   cls: "talk" },
    lunch:  { label: "ランチ", cls: "lunch" },
    break:  { label: "休憩",   cls: "break" },
    custom: { label: "特別",   cls: "custom" }
  };

  function render() {
    const body = $("#tt-board");

    const talkItems = items.filter(i => i.type === "talk");
    const total = items.length ? items[items.length - 1].end - items[0].start : 0;

    // 種別ごとの件数（定義順）
    const perType = new Map();
    for (const it of talkItems) {
      const k = it.typeName || "発表";
      perType.set(k, (perType.get(k) || 0) + 1);
    }
    const breakdown = perType.size > 1
      ? `（${[...perType].map(([n, c]) => `${esc(n)} ${c}`).join(" / ")}）` : "";

    $("#tt-summary").innerHTML =
      `<span>発表 <b>${talkItems.length}</b> 件${breakdown}</span>` +
      `<span>枠 <b>${items.filter(i => i.type !== "gap" && i.type !== "talk").length}</b> 件</span>` +
      (total > 0 ? `<span>会期 <b>${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}m</b></span>` : "");

    renderLegend();

    if (!items.length) {
      body.innerHTML = `<div class="empty-board"><b>タイムテーブルが空です</b>「登録一覧から読み込む」か、発表種別の件数を指定してください。</div>`;
      return;
    }

    let rows = "";
    let talkNo = 0;
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const dur = it.end - it.start;

      if (it.type === "talk") {
        const c = typeColor(it.colorIdx || 0);
        talkNo++;
        rows += `<tr data-idx="${idx}" data-entry="${esc(it.entryId)}">
          <td class="c-move"><div class="cell mv">
            <span class="grip" draggable="true" data-id="${esc(it.entryId)}" title="ドラッグで並べ替え">⠿</span>
            <span class="arrows">
              <button class="mv-btn" data-move="-1" data-id="${esc(it.entryId)}" title="上へ">▲</button>
              <button class="mv-btn" data-move="1" data-id="${esc(it.entryId)}" title="下へ">▼</button>
            </span>
          </div></td>
          <td class="c-time"><div class="cell"><div class="time-range">
            <span class="chip" style="background:${c.chip}"></span>
            <span class="rng">${toStr(it.start)}<small>– ${toStr(it.end)}</small></span>
          </div></div></td>
          <td class="c-kind"><div class="cell"><span class="badge" style="background:${c.bg};color:${c.fg}">${esc(it.typeName || "発表")}</span></div></td>
          <td><div class="cell" style="padding:7px 10px">
            <input class="title-in" data-field="title" data-idx="${idx}" placeholder="発表タイトル（${talkNo}）" value="${esc(it.title)}">
            <input class="sub-in" data-field="speaker" data-idx="${idx}" placeholder="発表者 / 所属" value="${esc(it.speaker)}">
          </div></td>
          <td class="c-dur"><div class="cell">${dur}分</div></td>
        </tr>`;
      } else if (it.type === "gap") {
        rows += `<tr class="row-gap">
          <td class="c-move"></td>
          <td class="c-time"><div class="cell"><div class="time-range">
            <span class="chip"></span>
            <span class="rng">${toStr(it.start)}<small>– ${toStr(it.end)}</small></span>
          </div></div></td>
          <td class="c-kind"><div class="cell"></div></td>
          <td><div class="cell fixed-label" style="font-weight:400;font-style:italic;color:var(--ink-faint)">空き時間</div></td>
          <td class="c-dur"><div class="cell">${dur}分</div></td>
        </tr>`;
      } else {
        const k = KIND[it.type] || KIND.custom;
        rows += `<tr class="row-${it.type}">
          <td class="c-move"></td>
          <td class="c-time"><div class="cell"><div class="time-range">
            <span class="chip"></span>
            <span class="rng">${toStr(it.start)}<small>– ${toStr(it.end)}</small></span>
          </div></div></td>
          <td class="c-kind"><div class="cell"><span class="badge ${k.cls}">${k.label}</span></div></td>
          <td><div class="cell fixed-label">${esc(it.label)}</div></td>
          <td class="c-dur"><div class="cell">${dur}分</div></td>
        </tr>`;
      }
    }

    body.innerHTML = `<table>
      <thead><tr>
        <th class="c-move"></th><th>時刻</th><th>種別</th><th>内容</th><th style="text-align:right">時間</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

    // 並べ替えボタンを連打できるよう、再描画後にフォーカスを戻す
    if (refocus) {
      const btn = body.querySelector(`.mv-btn[data-id="${refocus.id}"][data-move="${refocus.move}"]`);
      if (btn) btn.focus({ preventScroll: false });
      refocus = null;
    }
  }

  function renderLegend() {
    const seg = [];
    const shown = new Set(items.filter(i => i.type === "talk").map(i => i.typeName));
    talkTypes.forEach((t, i) => {
      const name = t.name || `種別${i + 1}`;
      if (typeLen(t) <= 0 || !shown.has(name)) return;   // 表に出ていない種別は凡例に載せない
      seg.push(`<span><i style="background:${typeColor(i).chip}"></i>${esc(name)} ${typeLen(t)}分</span>`);
    });
    const has = k => items.some(i => i.type === k);
    if (has("lunch"))  seg.push(`<span><i style="background:var(--lunch)"></i>ランチ</span>`);
    if (has("break"))  seg.push(`<span><i style="background:var(--break)"></i>休憩</span>`);
    if (has("custom")) seg.push(`<span><i style="background:var(--custom)"></i>特別</span>`);
    $("#tt-legend").innerHTML = seg.join("");
  }

  function renderNotice(msgs, type) {
    const n = $("#tt-notice");
    if (!msgs || !msgs.length) { n.className = "notice"; n.innerHTML = ""; return; }
    const icon = type === "ok" ? "✓" : type === "err" ? "✕" : "！";
    n.className = "notice show " + (type || "warn");
    n.innerHTML = `<span style="font-weight:700">${icon}</span><div class="grow">${
      msgs.length === 1 ? esc(msgs[0]) : "<ul>" + msgs.map(m => `<li>${esc(m)}</li>`).join("") + "</ul>"
    }</div>`;
  }

  /* ---------------- reorder ---------------- */
  function moveEntry(id, delta) {
    const i = talkList.findIndex(x => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= talkList.length) return;
    const [e] = talkList.splice(i, 1);
    talkList.splice(j, 0, e);
    refocus = { id, move: String(delta) };
    generate();
  }
  function dropEntry(dragId, refId, before) {
    if (!dragId || !refId || dragId === refId) return;
    const from = talkList.findIndex(x => x.id === dragId);
    if (from < 0) return;
    const [e] = talkList.splice(from, 1);
    const to = talkList.findIndex(x => x.id === refId);
    if (to < 0) { talkList.splice(from, 0, e); return; }
    talkList.splice(before ? to : to + 1, 0, e);
    generate();
  }
  function clearDropMarks() {
    $("#tt-board").querySelectorAll("tr.drop-before,tr.drop-after")
      .forEach(tr => tr.classList.remove("drop-before", "drop-after"));
  }
  function dropSide(tr, y) {
    const r = tr.getBoundingClientRect();
    return (y - r.top) < r.height / 2;
  }

  /* ---------------- talk types editor ---------------- */
  function renderTypes() {
    const box = $("#tt-types");
    if (!talkTypes.length) {
      box.innerHTML = `<div class="type-empty">発表種別がありません</div>`;
      return;
    }
    box.innerHTML = talkTypes.map((t, i) => `
      <div class="type-row" data-id="${esc(t.id)}">
        <div class="head">
          <span class="swatch" style="background:${typeColor(i).chip}"></span>
          <input class="name" type="text" data-k="name" placeholder="種別名（一般講演 等）" value="${esc(t.name)}">
        </div>
        <button class="kill" data-del="${esc(t.id)}" title="削除">×</button>
        <div class="nums">
          <div>
            <span class="mini">発表(分)</span>
            <input type="number" data-k="talk" min="0" step="1" value="${t.talk}">
          </div>
          <div>
            <span class="mini">質疑(分)</span>
            <input type="number" data-k="qa" min="0" step="1" value="${t.qa}">
          </div>
          <div>
            <span class="mini">件数</span>
            <input type="number" data-k="count" min="0" step="1" placeholder="－" value="${t.count == null ? "" : t.count}">
          </div>
        </div>
      </div>`).join("");
  }

  /* ---------------- slots editor ---------------- */
  function renderSlots() {
    const box = $("#tt-slots");
    if (!customSlots.length) {
      box.innerHTML = `<div class="slot-empty">枠はまだありません</div>`;
      return;
    }
    box.innerHTML = customSlots.map(c => `
      <div class="slot-row" data-id="${esc(c.id)}">
        <div class="times">
          <input type="time" data-k="start" value="${esc(c.start || "")}">
          <input type="time" data-k="end" value="${esc(c.end || "")}">
        </div>
        <input class="name" type="text" data-k="label" placeholder="名称（休憩・基調講演 等）" value="${esc(c.label)}">
        <select class="type" data-k="type">
          <option value="break" ${c.type === "break" ? "selected" : ""}>休憩</option>
          <option value="custom" ${c.type === "custom" ? "selected" : ""}>特別</option>
        </select>
        <button class="kill" data-del="${esc(c.id)}" title="削除">×</button>
      </div>`).join("");
  }

  /* ---------------- CSV ---------------- */
  function csvCell(v) {
    v = v == null ? "" : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function exportCSV() {
    const header = ["開始時刻", "終了時刻", "種別", "タイトル", "発表者", "発表種別"];
    const lines = [header.map(csvCell).join(",")];
    for (const it of items) {
      if (it.type === "gap") continue;
      const kind = (KIND[it.type] || {}).label || "特別";
      const title = it.type === "talk" ? it.title : it.label;
      const speaker = it.type === "talk" ? it.speaker : "";
      const tname = it.type === "talk" ? (it.typeName || "") : "";
      lines.push([toStr(it.start), toStr(it.end), kind, title || "", speaker || "", tname].map(csvCell).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "timetable.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    renderNotice(["CSVをエクスポートしました。"], "ok");
  }

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, "");
    const rows = []; let row = []; let cur = ""; let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else {
        if (ch === '"') q = true;
        else if (ch === ",") { row.push(cur); cur = ""; }
        else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
        else if (ch === "\r") { /* skip */ }
        else cur += ch;
      }
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ""));
  }

  const KIND_FROM = { "発表": "talk", "ランチ": "lunch", "昼食": "lunch", "休憩": "break", "特別": "custom" };

  /* 見出し行から列の位置を推定する（見出しが無ければ null）。
     時刻の列が無いCSV（発表種別だけを並べたもの）も読めるようにするため、
     位置固定ではなく見出しの語で列を判定する。 */
  const HEAD_PATTERNS = [
    ["start",   /開始/],
    ["start",   /^start/i],
    ["end",     /終了/],
    ["end",     /^end/i],
    ["ttype",   /発表種別|講演種別|セッション/],
    ["kind",    /種別|区分|kind|category/i],
    ["title",   /タイトル|題目|題名|演題|内容|title/i],
    ["speaker", /発表者|登壇者|氏名|著者|所属|speaker|author|presenter/i]
  ];
  function detectHeader(row) {
    const map = {}; let hit = 0;
    row.forEach((c, i) => {
      const v = String(c == null ? "" : c).trim();
      if (!v || toMin(v) != null) return;        // 時刻が入っていればデータ行
      for (const [key, re] of HEAD_PATTERNS) {
        if (!re.test(v)) continue;
        if (map[key] == null) { map[key] = i; hit++; }
        break;
      }
    });
    // 語が2つ以上一致すれば見出し行と判断する（1列だけのCSVは1つで判断）
    const cols = row.filter(c => String(c == null ? "" : c).trim() !== "").length;
    return (hit >= 2 || (hit === 1 && cols === 1)) ? map : null;
  }
  function uniqueTypeName(defs, base) {
    let name = base || "発表";
    for (let n = 2; defs.some(t => t.name === name); n++) name = (base || "発表") + n;
    return name;
  }

  function importCSV(text) {
    const raw = parseCSV(text);
    if (!raw.length) { renderNotice(["CSVが空です。"], "err"); return; }

    const warn = [];
    const head = detectHeader(raw[0]);
    const rows = head ? raw.slice(1) : raw;
    let map = head || { start: 0, end: 1, kind: 2, title: 3, speaker: 4, ttype: 5 };
    const cell = (r, k) => map[k] == null ? "" : String(r[map[k]] == null ? "" : r[map[k]]).trim();

    if (!rows.length) { renderNotice(["CSVにデータ行がありません。"], "err"); return; }

    // 見出しが無く時刻の列も見当たらない → 「発表種別／タイトル／発表者」の並びと解釈する
    if (!head && !rows.some(r => toMin(cell(r, "start")) != null)) {
      map = { ttype: 0, title: 1, speaker: 2 };
      warn.push("見出し行が無いため、列を「発表種別／タイトル／発表者」として読み込みました。");
    }

    const talks = [];    // 発表（CSVの並び順）
    const fixed = [];    // 時刻付きの休憩・特別枠
    const dropped = [];  // 時刻が無く配置できなかった枠
    let lunch = null, untimed = 0;

    for (const r of rows) {
      const s = toMin(cell(r, "start")), e = toMin(cell(r, "end"));
      const timed = s != null && e != null && e > s;
      const kindRaw = cell(r, "kind"), title = cell(r, "title"), speaker = cell(r, "speaker");
      let tname = cell(r, "ttype"), type;

      if (!kindRaw)                 type = "talk";
      else if (KIND_FROM[kindRaw])  type = KIND_FROM[kindRaw];
      else if (timed)               type = "custom";
      else { type = "talk"; if (!tname) tname = kindRaw; }  // 時刻の無い行は固定枠にできないので発表として扱う

      if (type === "talk") {
        if (!timed) untimed++;
        talks.push({ name: tname, title, speaker,
                     start: timed ? s : null, end: timed ? e : null, len: timed ? e - s : null });
      } else if (!timed) {
        dropped.push(title || kindRaw);
      } else if (type === "lunch") {
        lunch = { start: s, end: e, label: title || "ランチ" };
      } else {
        fixed.push({ type, start: s, end: e, label: title || (type === "break" ? "休憩" : "特別") });
      }
    }

    if (!talks.length && !fixed.length && !lunch) {
      renderNotice(["読み込める行がありませんでした。見出し（開始時刻／終了時刻／種別／タイトル／発表者／発表種別）や時刻の形式（HH:MM）をご確認ください。"], "err");
      return;
    }
    if (dropped.length)
      warn.push(`時刻の無い枠（${dropped.slice(0, 3).map(d => d || "無題").join("・")}${dropped.length > 3 ? " ほか" : ""}）は時間帯が決まらないため配置しませんでした。`);

    // 発表を種別ごとにまとめる（種別名が無ければコマ長でまとめる）
    const groups = [], byKey = new Map();
    for (const t of talks) {
      const key = t.name ? "n:" + t.name : (t.len != null ? "l:" + t.len : "l:?");
      let g = byKey.get(key);
      if (!g) { g = { name: t.name, len: t.len, count: 0 }; byKey.set(key, g); groups.push(g); }
      if (g.len == null) g.len = t.len;
      g.count++; t.group = g;
    }

    // 種別定義を確定する。既存の定義（発表／質疑の内訳）を活かし、未知の種別だけ追加する
    const defs = talkTypes.map(t => Object.assign({}, t, { count: 0 }));
    const claimed = new Set(), guessed = [];
    const order = groups.map((g, i) => ({ g, i })).sort((a, b) => (a.g.name ? 0 : 1) - (b.g.name ? 0 : 1));
    for (const { g, i: gi } of order) {
      const autoName = groups.length === 1 ? "発表" : `種別${String.fromCharCode(65 + gi)}`;
      let def = g.name ? defs.find(t => t.name === g.name && !claimed.has(t))
                       : (g.len != null ? defs.find(t => typeLen(t) === g.len && !claimed.has(t)) : null);
      if (def) {
        if (g.len != null && typeLen(def) !== g.len) {          // CSVのコマ長に合わせる
          const qa = Math.min(def.qa, g.len);
          def.qa = qa; def.talk = g.len - qa;
        }
      } else if (g.len != null) {
        const donor = defs.find(t => typeLen(t) === g.len);
        const qa = donor ? Math.min(donor.qa, g.len) : 0;
        def = { id: uid(), name: uniqueTypeName(defs, g.name || autoName), talk: g.len - qa, qa, count: 0 };
        defs.push(def);
      } else {
        const donor = defs[0];                                 // コマ長不明。既存の定義から仮置きする
        def = { id: uid(), name: uniqueTypeName(defs, g.name || autoName),
                talk: donor ? donor.talk : 12, qa: donor ? donor.qa : 3, count: 0 };
        defs.push(def);
        guessed.push(def);
      }
      claimed.add(def);
      def.count += g.count;
      g.def = def;
    }
    if (guessed.length)
      warn.push(`${guessed.map(d => `「${d.name}」`).join("")}のコマ長はCSVに無いため ${guessed.map(d => `${d.talk}+${d.qa}`).join("／")}分 で仮置きしました。左パネルで調整してください。`);

    const allTimed = talks.length > 0 && untimed === 0;      // すべての発表に時刻がある
    if (allTimed) talks.sort((a, b) => a.start - b.start || a.end - b.end);

    // 状態を差し替える（CSVに出てこない種別は残さない。件数だけ0にすると次の読み込みで溜まっていく）
    talkTypes = talks.length ? defs.filter(t => t.count > 0) : defs;
    talkList = talks.map(t => ({ id: uid(), typeId: t.group.def.id, title: t.title, speaker: t.speaker }));
    customSlots = fixed.map(f => ({ id: uid(), start: toStr(f.start), end: toStr(f.end), label: f.label, type: f.type }));
    $("#tt-lunch-on").checked = !!lunch;
    if (lunch) { $("#tt-lunch-start").value = toStr(lunch.start); $("#tt-lunch-end").value = toStr(lunch.end); }
    renderTypes();
    renderSlots();

    if (allTimed) {
      // CSVの時刻をそのまま使う
      const out = talks.map((t, i) => {
        const ci = talkTypes.indexOf(t.group.def);
        return { type: "talk", start: t.start, end: t.end, entryId: talkList[i].id,
                 typeName: t.group.def.name || `種別${ci + 1}`, colorIdx: ci,
                 title: t.title, speaker: t.speaker };
      });
      if (lunch) out.push({ type: "lunch", start: lunch.start, end: lunch.end, label: lunch.label });
      for (const f of fixed) out.push(Object.assign({}, f));
      out.sort((a, b) => a.start - b.start || a.end - b.end);
      items = out;
      absolute = true;
      $("#tt-start").value = toStr(items[0].start);
      render();
      renderNotice([`CSVを読み込みました（発表 ${talks.length} 件）。設定パネルにも反映済みです。`].concat(warn),
                   warn.length ? "warn" : "ok");
      scheduleSave();
    } else {
      // 時刻の無い発表がある → 並び順だけを受け取り、開始時刻から自動配置する
      if (untimed && untimed < talks.length)
        warn.push("時刻の無い発表行があるため、すべての発表を開始時刻から順に並べ直しました。");
      if (!talks.length) {
        const first = Math.min(lunch ? lunch.start : Infinity, ...fixed.map(f => f.start));
        if (isFinite(first)) $("#tt-start").value = toStr(first);
      }
      noticeLead = {
        msgs: [`CSVを読み込みました（発表 ${talks.length} 件）。開始時刻から順に配置しました。開始時刻の変更と行の並べ替えで調整できます。`].concat(warn),
        type: warn.length ? "warn" : "ok"
      };
      generate();
    }
  }

  /* ---------------- events ---------------- */
  function bind() {
    // settings -> regenerate (interactive)
    ["tt-start", "tt-lunch-on", "tt-lunch-start", "tt-lunch-end", "tt-showgap"]
      .forEach(id => $("#" + id).addEventListener("input", generate));

    $("#tt-regen").addEventListener("click", generate);
    $("#tt-print").addEventListener("click", () => window.print());
    $("#tt-export").addEventListener("click", exportCSV);
    $("#tt-import").addEventListener("click", () => $("#tt-file").click());
    $("#tt-file").addEventListener("change", e => {
      const f = e.target.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = ev => importCSV(ev.target.result);
      reader.readAsText(f, "utf-8");
      e.target.value = "";
    });

    $("#tt-load-regs").addEventListener("click", () => {
      const n = ((ctx.source || {}).registrations || []).length;
      if (talkList.length && !confirm(
        `いま表にある発表 ${talkList.length} 件を、参加登録 ${n} 件で置き換えます。よろしいですか？`)) return;
      loadFromRegistrations(false);
    });

    // talk type add
    $("#tt-add-type").addEventListener("click", () => {
      const last = talkTypes[talkTypes.length - 1];
      const used = new Set(talkTypes.map(t => t.name));
      let name = "種別A";
      for (let i = 0; i < 26 && used.has(name); i++) name = `種別${String.fromCharCode(65 + i + 1)}`;
      talkTypes.push({
        id: uid(), name,
        talk: last ? last.talk : 12,
        qa: last ? last.qa : 3,
        count: 1
      });
      renderTypes(); generate();
    });
    // talk type edit / delete (delegation)
    $("#tt-types").addEventListener("input", e => {
      const row = e.target.closest(".type-row"); if (!row) return;
      const t = talkTypes.find(x => x.id === row.dataset.id); if (!t) return;
      const k = e.target.dataset.k; if (!k) return;
      if (k === "name") t.name = e.target.value;
      else if (k === "count") t.count = e.target.value.trim() === "" ? null : Math.max(0, parseInt(e.target.value, 10) || 0);
      else t[k] = Math.max(0, parseInt(e.target.value, 10) || 0);
      generate();
    });
    $("#tt-types").addEventListener("click", e => {
      const del = e.target.dataset.del; if (!del) return;
      talkTypes = talkTypes.filter(x => x.id !== del);
      renderTypes(); generate();
    });

    // custom slot add
    $("#tt-add-slot").addEventListener("click", () => {
      const last = customSlots[customSlots.length - 1];
      const base = last ? toMin(last.end) : toMin($("#tt-start").value);
      const s = base != null ? toStr(base) : "15:00";
      const e = base != null ? toStr(base + 15) : "15:15";
      customSlots.push({ id: uid(), start: s, end: e, label: "休憩", type: "break" });
      renderSlots(); generate();
    });
    // custom slot edit / delete (delegation)
    $("#tt-slots").addEventListener("input", e => {
      const row = e.target.closest(".slot-row"); if (!row) return;
      const c = customSlots.find(x => x.id === row.dataset.id); if (!c) return;
      const k = e.target.dataset.k; if (k) c[k] = e.target.value;
      generate();
    });
    $("#tt-slots").addEventListener("click", e => {
      const del = e.target.dataset.del; if (!del) return;
      customSlots = customSlots.filter(x => x.id !== del);
      renderSlots(); generate();
    });

    // inline talk editing (delegation) — no regenerate, just persist
    $("#tt-board").addEventListener("input", e => {
      const t = e.target;
      if (!t.classList.contains("title-in") && !t.classList.contains("sub-in")) return;
      const idx = +t.dataset.idx, field = t.dataset.field;
      const it = items[idx]; if (!it || it.type !== "talk") return;
      it[field] = t.value;
      const en = talkList.find(x => x.id === it.entryId);
      if (en) en[field] = t.value;
      scheduleSave();
    });

    /* ---- 並べ替え（▲▼ / ドラッグ＆ドロップ） ---- */
    let dragId = null;

    $("#tt-board").addEventListener("click", e => {
      const b = e.target.closest(".mv-btn"); if (!b) return;
      moveEntry(b.dataset.id, parseInt(b.dataset.move, 10));
    });

    $("#tt-board").addEventListener("dragstart", e => {
      const g = e.target.closest(".grip");
      if (!g) { e.preventDefault(); return; }   // 入力欄のテキストドラッグは無効化
      dragId = g.dataset.id;
      const tr = g.closest("tr");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragId); } catch (_) {}
      if (tr) {
        e.dataTransfer.setDragImage(tr, 24, 14);
        setTimeout(() => tr.classList.add("dragging"), 0);
      }
    });
    $("#tt-board").addEventListener("dragover", e => {
      if (!dragId) return;
      const tr = e.target.closest("tr[data-entry]");
      if (!tr || tr.dataset.entry === dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      clearDropMarks();
      tr.classList.add(dropSide(tr, e.clientY) ? "drop-before" : "drop-after");
    });
    $("#tt-board").addEventListener("drop", e => {
      if (!dragId) return;
      e.preventDefault();
      const tr = e.target.closest("tr[data-entry]");
      clearDropMarks();
      if (tr) dropEntry(dragId, tr.dataset.entry, dropSide(tr, e.clientY));
      dragId = null;
    });
    $("#tt-board").addEventListener("dragend", () => {
      clearDropMarks();
      const d = $("#tt-board").querySelector("tr.dragging");
      if (d) d.classList.remove("dragging");
      dragId = null;
    });
  }

  /* ---------------- public ---------------- */
  /* context: {source:{registrations,types}, draft, saveDraft(draft)->Promise} */
  function mount(context) {
    ctx = context;
    if (!mounted) { bind(); mounted = true; }
    updateLoadHint();

    const restored = restore(ctx.draft);
    if (restored) {
      setSaved("下書きを復元しました", false);
    } else {
      // 初回は登録一覧をそのまま発表順として取り込む。
      // quiet=true で「読み込みました」の通知は出さないが、
      // 発表0件・時刻の矛盾といった generate() の警告はそのまま見せる。
      suspendSave = true;
      try { loadFromRegistrations(true); } finally { suspendSave = false; }
    }
  }

  function setSource(source) {
    if (!ctx) return;
    ctx.source = source;
    updateLoadHint();
  }

  return { mount, setSource, loadFromRegistrations, isMounted: () => mounted };
})();
