"use strict";

/* タイムテーブル作成ツール（管理画面の「タイムテーブル」タブ）。
   参加登録の一覧から発表順を受け取り、開始時刻・固定枠に合わせてコマを並べる。
   CSVの入出力と手動並べ替えは従来どおり。
   編集内容は下書きとして自動保存される（サーバー版はサーバー、デモ版は localStorage）。 */

window.Timetable = (function () {

  /* ---------------- state ---------------- */
  // 発表種別 {id, name, talk, qa, emphasis}。設定タブの種別マスタが正で、ここでは編集しない。
  // CSVから取り込んだ種別など、マスタに無いものだけ末尾に残る。
  let talkTypes = [];
  // 休憩の枠 {id, start, end, label}。発表以外の時間帯はすべてここで扱う。
  let breakSlots = [{ id: uid(), start: "15:00", end: "15:15", label: "休憩" }];
  // 発表の並び順そのもの。手動で入れ替え可能で、再生成をまたいで保持される
  // {id, typeId, title, speaker, affiliation}
  let talkList = [];
  let items = [];         // rendered rows
  let refocus = null;     // 再描画後にフォーカスを戻す並べ替えボタン
  let focusEntry = null;  // 再描画後にタイトル欄へフォーカスする発表（追加した直後）
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
  const newEntry = typeId => ({ id: uid(), typeId, title: "", speaker: "", affiliation: "" });

  /* 発表者と所属は分けて持ち、表の1行に収めるときだけ「発表者（所属）」にまとめる。 */
  function joinSpeaker(who, org) {
    who = String(who == null ? "" : who).trim();
    org = String(org == null ? "" : org).trim();
    if (who && org) return `${who}（${org}）`;
    return who || org;
  }
  /* まとまった1つの文字列（旧い下書き・CSVなど）を発表者と所属に戻す。 */
  function splitSpeaker(s) {
    s = String(s == null ? "" : s).trim();
    const m = /^(.+?)\s*[（(]\s*([^（()）]+?)\s*[）)]$/.exec(s);
    return m ? { speaker: m[1], affiliation: m[2] } : { speaker: s, affiliation: "" };
  }

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
      talkTypes: talkTypes.map(t => ({
        id: t.id, name: t.name, talk: t.talk, qa: t.qa, emphasis: !!t.emphasis
      })),
      talkList: talkList.map(e => ({
        id: e.id, typeId: e.typeId, title: e.title, speaker: e.speaker, affiliation: e.affiliation
      })),
      breakSlots: breakSlots.map(c => ({ id: c.id, start: c.start, end: c.end, label: c.label })),
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
          emphasis: t.emphasis === true
        }));
      }
      const known = new Set(talkTypes.map(t => t.id));
      if (Array.isArray(draft.talkList)) {
        talkList = draft.talkList
          .filter(e => e && known.has(e.typeId))
          .map(e => {
            // 所属を分けて持つ前の下書きは「発表者（所属）」の形なので分解して取り込む
            const who = e.affiliation == null
              ? splitSpeaker(e.speaker)
              : { speaker: String(e.speaker == null ? "" : e.speaker), affiliation: String(e.affiliation) };
            return {
              id: typeof e.id === "string" && e.id ? e.id : uid(),
              typeId: e.typeId,
              title: String(e.title == null ? "" : e.title),
              speaker: who.speaker,
              affiliation: who.affiliation
            };
          });
      }
      applyMasterTypes(true);   // 下書きより設定タブの種別マスタを優先する
      // customSlots は特別枠があったころの下書き。休憩としてそのまま引き継ぐ
      const slots = Array.isArray(draft.breakSlots) ? draft.breakSlots : draft.customSlots;
      if (Array.isArray(slots)) {
        breakSlots = slots.filter(c => c && typeof c === "object").map(c => ({
          id: typeof c.id === "string" && c.id ? c.id : uid(),
          start: String(c.start || ""), end: String(c.end || ""),
          label: String(c.label == null ? "" : c.label)
        }));
      }
      renderSlots();

      if (draft.absolute && Array.isArray(draft.items) && draft.items.length) {
        absolute = true;
        // 特別枠があったころの下書きの行は休憩として扱う
        items = draft.items.map(it => it && it.type === "custom" ? Object.assign({}, it, { type: "break" }) : it);
        applyTypesToItems();
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

  /* ---------------- 種別マスタ（設定タブ）との同期 ---------------- */
  function masterTypes() {
    return ((((ctx || {}).source) || {}).types || []).map(t => ({
      id: t.id,
      name: String(t.name == null ? "" : t.name),
      talk: Math.max(0, parseInt(t.talk, 10) || 0),
      qa: Math.max(0, parseInt(t.qa, 10) || 0),
      emphasis: t.emphasis === true
    }));
  }

  /* 発表種別は設定タブでしか編集できないので、マスタの内容をこちらへ取り込む。
     sync=true … 名称・時間もマスタで上書きし、マスタにも発表にも無い種別は落とす
     sync=false … マスタに無い種別（CSV由来など）はそのまま残し、足りない種別だけ足す
     並びが変わったかどうかを返す。 */
  function applyMasterTypes(sync) {
    const master = masterTypes();
    if (!master.length) return false;
    const cur = new Map(talkTypes.map(t => [t.id, t]));
    const used = new Set(talkList.map(e => e.typeId));
    const next = master.map(m => (!sync && cur.get(m.id)) || m);
    const inMaster = new Set(master.map(m => m.id));
    for (const t of talkTypes)
      if (!inMaster.has(t.id) && (!sync || used.has(t.id))) next.push(t);

    const key = list => JSON.stringify(list.map(t => [t.id, t.name, t.talk, t.qa, !!t.emphasis]));
    const changed = key(next) !== key(talkTypes);
    talkTypes = next;
    return changed;
  }

  /* CSVの時刻をそのまま使っている状態（absolute）では時刻を振り直さないので、
     種別の名称・色・強調だけを talkTypes の内容に合わせる。 */
  function applyTypesToItems() {
    const byId = new Map(talkTypes.map((t, i) => [t.id, { name: t.name || `種別${i + 1}`, i, emphasis: !!t.emphasis }]));
    for (const it of items) {
      if (it.type !== "talk") continue;
      const e = talkList.find(x => x.id === it.entryId);
      const t = e && byId.get(e.typeId);
      if (t) { it.typeName = t.name; it.colorIdx = t.i; it.emph = t.emphasis; }
    }
  }

  /* ---------------- 参加登録からの読み込み ---------------- */
  /* 登録一覧を発表順として取り込む。種別マスタの発表／質疑時間をそのまま使う。 */
  function loadFromRegistrations(quiet) {
    const src = (ctx && ctx.source) || { registrations: [], types: [] };
    const regs = src.registrations || [];
    const master = masterTypes();

    const byId = new Map(master.map(t => [t.id, t]));
    const orphanTypes = [];
    const orphan = [];

    talkList = [];
    for (const r of regs) {
      let def = byId.get(r.typeId);
      if (!def) {
        // 種別マスタから削除された種別。登録に残っている名前で仮の種別を作る
        const name = String(r.typeName || "").trim() || "種別不明";
        def = orphanTypes.find(t => t.name === name);
        if (!def) {
          const donor = master[0];
          def = { id: "orphan-" + uid(), name,
                  talk: donor ? donor.talk : 12, qa: donor ? donor.qa : 3 };
          orphanTypes.push(def);
          orphan.push(name);
        }
        byId.set(r.typeId, def);
      }
      talkList.push({
        id: uid(), typeId: def.id, title: r.title || "",
        speaker: String(r.speaker || "").trim(),
        affiliation: String(r.affiliation || "").trim()
      });
    }

    // マスタの種別はすべて残す（発表が0件でも「＋ 発表を追加」から選べるように）
    talkTypes = master.concat(orphanTypes);

    absolute = false;
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
      specById.set(t.id, { id: t.id, name: t.name || `種別${i + 1}`, len: typeLen(t),
                           colorIdx: i, emphasis: !!t.emphasis });
    });

    // 種別が無くなった発表は落とす
    talkList = talkList.filter(e => specById.has(e.typeId));

    // 発表＋質疑が0分の種別は時間を取れないので、表の下に一覧として出す
    const zero = new Map();
    for (const e of talkList) {
      const spec = specById.get(e.typeId);
      if (spec.len <= 0) zero.set(spec.name, (zero.get(spec.name) || 0) + 1);
    }
    for (const [name, n] of zero)
      warnings.push(`発表種別「${name}」は発表＋質疑が0分のため、${n}件をタイムテーブルには並べず、下の一覧に表示しました（時間を割り当てる場合は「設定」タブで指定できます）。`);

    if (!talkList.length)
      warnings.push("発表が0件です。「登録一覧から読み込む」か、表の下の「＋ 発表を追加」で追加してください。");

    // collect fixed slots
    let fixed = [];
    if (s.lunchOn) {
      const ls = toMin(s.lunchStart), le = toMin(s.lunchEnd);
      if (ls != null && le != null && le > ls) fixed.push({ type: "lunch", start: ls, end: le, label: "ランチ" });
      else warnings.push("ランチの時刻が不正です（開始<終了で指定してください）。");
    }
    breakSlots.forEach(c => {
      const cs = toMin(c.start), ce = toMin(c.end);
      if (cs != null && ce != null && ce > cs) fixed.push({ type: "break", start: cs, end: ce, label: c.label || "（無題）" });
      else if (c.start || c.end || c.label) warnings.push(`休憩「${c.label || "無題"}」の時刻が不正です。`);
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
          entryId: e.id, typeName: spec.name, colorIdx: spec.colorIdx, emph: spec.emphasis,
          title: e.title, speaker: joinSpeaker(e.speaker, e.affiliation)
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
    break:  { label: "休憩",   cls: "break" }
  };

  function render() {
    const body = $("#tt-board");

    renderTypes();
    renderAddBar();
    renderUntimed();

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
      body.innerHTML = `<div class="empty-board"><b>タイムテーブルが空です</b>「登録一覧から読み込む」か、下の「＋ 発表を追加」から作りはじめてください。</div>`;
      refocus = null; focusEntry = null;
      return;
    }

    let rows = "";
    let talkNo = 0;
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const dur = it.end - it.start;

      if (it.type === "talk") {
        const c = typeColor(it.colorIdx || 0);
        // 強調する種別（設定タブで指定）は行に背景色を敷いて目立たせる
        const em = !!it.emph;
        talkNo++;
        rows += `<tr data-idx="${idx}" data-entry="${esc(it.entryId)}"${
          em ? ` class="row-emph" style="background:${c.bg};--emph:${c.chip}"` : ""}>
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
          <td class="c-kind"><div class="cell"><span class="badge" style="background:${
            em ? c.chip : c.bg};color:${em ? "#fff" : c.fg}">${esc(it.typeName || "発表")}</span></div></td>
          <td><div class="cell" style="padding:7px 10px">
            <input class="title-in" data-field="title" data-idx="${idx}" placeholder="発表タイトル（${talkNo}）" value="${esc(it.title)}">
            <input class="sub-in" data-field="speaker" data-idx="${idx}" placeholder="発表者 / 所属" value="${esc(it.speaker)}">
          </div></td>
          <td class="c-dur"><div class="cell">${dur}分</div></td>
          <td class="c-del"><button class="del-btn" data-del-entry="${esc(it.entryId)}" title="この発表を削除">×</button></td>
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
          <td class="c-del"></td>
        </tr>`;
      } else {
        const k = KIND[it.type] || KIND.break;
        rows += `<tr class="row-${it.type}">
          <td class="c-move"></td>
          <td class="c-time"><div class="cell"><div class="time-range">
            <span class="chip"></span>
            <span class="rng">${toStr(it.start)}<small>– ${toStr(it.end)}</small></span>
          </div></div></td>
          <td class="c-kind"><div class="cell"><span class="badge ${k.cls}">${k.label}</span></div></td>
          <td><div class="cell fixed-label">${esc(it.label)}</div></td>
          <td class="c-dur"><div class="cell">${dur}分</div></td>
          <td class="c-del"></td>
        </tr>`;
      }
    }

    body.innerHTML = `<table>
      <thead><tr>
        <th class="c-move"></th><th>時刻</th><th>種別</th><th>内容</th><th style="text-align:right">時間</th><th class="c-del"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

    // 並べ替えボタンを連打できるよう、再描画後にフォーカスを戻す
    if (refocus) {
      const btn = body.querySelector(`.mv-btn[data-id="${refocus.id}"][data-move="${refocus.move}"]`);
      if (btn) btn.focus({ preventScroll: false });
      refocus = null;
    }
    // 追加した直後の発表はタイトル欄をすぐ入力できるようにする
    if (focusEntry) {
      const inp = body.querySelector(`tr[data-entry="${focusEntry}"] .title-in`);
      focusEntry = null;
      if (inp) { inp.focus(); inp.scrollIntoView({ block: "nearest" }); }
    }
  }

  /* 表の下の「＋ 発表を追加」。時間が0分の種別は配置できないので選択肢に出さない。 */
  function renderAddBar() {
    const sel = $("#tt-add-kind"), btn = $("#tt-add-talk"), note = $("#tt-add-note");
    if (!sel || !btn) return;
    const usable = talkTypes.filter(t => typeLen(t) > 0);
    const prev = sel.value;
    sel.innerHTML = usable.map((t, i) =>
      `<option value="${esc(t.id)}">${esc(t.name || `種別${i + 1}`)}（${typeLen(t)}分）</option>`).join("");
    if (usable.some(t => t.id === prev)) sel.value = prev;
    sel.hidden = usable.length < 2;
    btn.disabled = !usable.length;
    if (note) note.textContent = usable.length
      ? "空の発表を1件、いちばん下に追加します。"
      : "発表時間が設定された種別がありません（「設定」タブで指定してください）。";
  }

  /* 発表＋質疑が0分の種別（ポスター発表など）は時刻を持てずタイムテーブルに並べられないので、
     表の下に種別ごとの一覧として出す。 */
  function renderUntimed() {
    const box = $("#tt-untimed");
    if (!box) return;
    const groups = talkTypes
      .map((t, i) => ({ t, i, list: talkList.filter(e => e.typeId === t.id) }))
      .filter(g => typeLen(g.t) <= 0 && g.list.length);

    if (!groups.length) { box.innerHTML = ""; return; }

    box.innerHTML = groups.map(g => {
      const rows = g.list.map((e, n) => `<tr>
        <td class="num">${n + 1}</td>
        <td class="u-title">${e.title ? esc(e.title) : `<span class="u-none">（無題）</span>`}</td>
        <td>${esc(e.speaker)}</td>
        <td class="u-org">${esc(e.affiliation)}</td>
      </tr>`).join("");
      const c = typeColor(g.i);
      const em = !!g.t.emphasis;
      return `<div class="board untimed${em ? " emph" : ""}"${
        em ? ` style="--emph:${c.chip};--emph-bg:${c.bg}"` : ""}>
        <div class="board-head">
          <span class="ttl"><i class="sw" style="background:${c.chip}"></i>${
            esc(g.t.name || `種別${g.i + 1}`)}</span>
          <div class="summary" style="font-size:11px"><span>発表 <b>${g.list.length}</b> 件</span></div>
        </div>
        <table>
          <thead><tr>
            <th class="num">#</th><th>タイトル</th>
            <th style="width:170px">発表者</th><th style="width:210px">所属</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }).join("");
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
    if (has("lunch")) seg.push(`<span><i style="background:var(--lunch)"></i>ランチ</span>`);
    if (has("break")) seg.push(`<span><i style="background:var(--break)"></i>休憩</span>`);
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

  /* ---------------- 発表の追加・削除 ---------------- */
  function addTalk(typeId) {
    const t = talkTypes.find(x => x.id === typeId && typeLen(x) > 0) || talkTypes.find(x => typeLen(x) > 0);
    if (!t) {
      renderNotice(["発表時間が設定された種別がありません。「設定」タブで発表・質疑の時間を指定してください。"], "err");
      return;
    }
    const e = newEntry(t.id);
    talkList.push(e);
    focusEntry = e.id;

    if (absolute) {
      // CSVの時刻をそのまま使っている状態。最後の枠のうしろに続けて置く
      const base = items.length ? items[items.length - 1].end : (toMin($("#tt-start").value) || 0);
      items.push({
        type: "talk", start: base, end: base + typeLen(t), entryId: e.id,
        typeName: t.name || "発表", colorIdx: talkTypes.indexOf(t), emph: !!t.emphasis,
        title: "", speaker: ""
      });
      render();
      scheduleSave();
    } else {
      generate();
    }
  }

  function removeTalk(id) {
    const i = talkList.findIndex(x => x.id === id);
    if (i < 0) return;
    const e = talkList[i];
    if ((e.title || e.speaker) &&
        !confirm(`「${e.title || "（無題）"}」を削除します。よろしいですか？`)) return;
    talkList.splice(i, 1);
    if (absolute) {
      items = items.filter(it => it.entryId !== id);
      render();
      scheduleSave();
    } else {
      generate();
    }
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

  /* ---------------- 発表種別の一覧（閲覧のみ。編集は設定タブ） ---------------- */
  function renderTypes() {
    const box = $("#tt-types");
    if (!box) return;
    if (!talkTypes.length) {
      box.innerHTML = `<div class="type-empty">発表種別がありません（「設定」タブで追加してください）</div>`;
      return;
    }
    const n = new Map();
    for (const e of talkList) n.set(e.typeId, (n.get(e.typeId) || 0) + 1);

    box.innerHTML = talkTypes.map((t, i) => `
      <div class="type-ro" title="${esc(t.name)}${t.emphasis ? "（強調）" : ""}">
        <span class="swatch" style="background:${typeColor(i).chip}"></span>
        <span class="nm">${esc(t.name || `種別${i + 1}`)}${t.emphasis
          ? `<i class="emph-mark" style="color:${typeColor(i).chip}" title="強調表示">★</i>` : ""}</span>
        <span class="len">${typeLen(t) > 0 ? `${t.talk}+${t.qa}分` : "時間なし"}</span>
        <span class="cnt">${n.get(t.id) || 0}件</span>
      </div>`).join("");
  }

  /* ---------------- 休憩エディタ ---------------- */
  function renderSlots() {
    const box = $("#tt-slots");
    if (!breakSlots.length) {
      box.innerHTML = `<div class="slot-empty">休憩はまだありません</div>`;
      return;
    }
    box.innerHTML = breakSlots.map(c => `
      <div class="slot-row" data-id="${esc(c.id)}">
        <div class="times">
          <input type="time" data-k="start" value="${esc(c.start || "")}">
          <input type="time" data-k="end" value="${esc(c.end || "")}">
        </div>
        <input class="name" type="text" data-k="label" placeholder="名称（休憩・コーヒーブレイク 等）" value="${esc(c.label)}">
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
      const kind = (KIND[it.type] || KIND.break).label;
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

  // 「特別」は特別枠があったころのエクスポート。休憩として読み込む
  const KIND_FROM = { "発表": "talk", "ランチ": "lunch", "昼食": "lunch", "休憩": "break", "特別": "break" };

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
    const fixed = [];    // 時刻付きの休憩
    const dropped = [];  // 時刻が無く配置できなかった枠
    let lunch = null, untimed = 0;

    for (const r of rows) {
      const s = toMin(cell(r, "start")), e = toMin(cell(r, "end"));
      const timed = s != null && e != null && e > s;
      const kindRaw = cell(r, "kind"), title = cell(r, "title"), speaker = cell(r, "speaker");
      let tname = cell(r, "ttype"), type;

      if (!kindRaw)                 type = "talk";
      else if (KIND_FROM[kindRaw])  type = KIND_FROM[kindRaw];
      else if (timed)               type = "break";       // 知らない種別でも時刻があれば休憩として置く
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
        fixed.push({ type: "break", start: s, end: e, label: title || "休憩" });
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
    talkTypes = (talks.length ? defs.filter(t => t.count > 0) : defs)
      .map(t => ({ id: t.id, name: t.name, talk: t.talk, qa: t.qa, emphasis: !!t.emphasis }));
    talkList = talks.map(t => {
      const who = splitSpeaker(t.speaker);   // 「発表者（所属）」の形なら所属を取り出す
      return { id: uid(), typeId: t.group.def.id, title: t.title,
               speaker: who.speaker, affiliation: who.affiliation };
    });
    applyMasterTypes(false);   // CSVに無かった種別も「＋ 発表を追加」から選べるように残す
    breakSlots = fixed.map(f => ({ id: uid(), start: toStr(f.start), end: toStr(f.end), label: f.label }));
    $("#tt-lunch-on").checked = !!lunch;
    if (lunch) { $("#tt-lunch-start").value = toStr(lunch.start); $("#tt-lunch-end").value = toStr(lunch.end); }
    renderSlots();

    if (allTimed) {
      // CSVの時刻をそのまま使う
      const out = talks.map((t, i) => {
        const ci = talkTypes.findIndex(x => x.id === t.group.def.id);
        return { type: "talk", start: t.start, end: t.end, entryId: talkList[i].id,
                 typeName: t.group.def.name || `種別${ci + 1}`, colorIdx: ci < 0 ? 0 : ci,
                 emph: ci >= 0 && !!talkTypes[ci].emphasis,
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

    // 発表の追加（表の下）
    $("#tt-add-talk").addEventListener("click", () => addTalk($("#tt-add-kind").value));

    // 休憩の追加
    $("#tt-add-slot").addEventListener("click", () => {
      const last = breakSlots[breakSlots.length - 1];
      const base = last ? toMin(last.end) : toMin($("#tt-start").value);
      const s = base != null ? toStr(base) : "15:00";
      const e = base != null ? toStr(base + 15) : "15:15";
      breakSlots.push({ id: uid(), start: s, end: e, label: "休憩" });
      renderSlots(); generate();
    });
    // 休憩の編集・削除（委譲）
    $("#tt-slots").addEventListener("input", e => {
      const row = e.target.closest(".slot-row"); if (!row) return;
      const c = breakSlots.find(x => x.id === row.dataset.id); if (!c) return;
      const k = e.target.dataset.k; if (k) c[k] = e.target.value;
      generate();
    });
    $("#tt-slots").addEventListener("click", e => {
      const del = e.target.dataset.del; if (!del) return;
      breakSlots = breakSlots.filter(x => x.id !== del);
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
      if (en) {
        en[field] = t.value;
        // 表では発表者と所属を1行にまとめて出しているので、書き換えられたら所属は畳み込む
        if (field === "speaker") en.affiliation = "";
      }
      scheduleSave();
    });

    /* ---- 並べ替え（▲▼ / ドラッグ＆ドロップ） ---- */
    let dragId = null;

    $("#tt-board").addEventListener("click", e => {
      const del = e.target.closest(".del-btn");
      if (del) { removeTalk(del.dataset.delEntry); return; }
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

  /* 設定タブでの保存・登録の増減を受け取る。発表種別はここが唯一の入り口になるので、
     マスタが変わっていれば時刻を振り直して表に反映する。 */
  function setSource(source) {
    if (!ctx) return;
    ctx.source = source;
    updateLoadHint();
    if (!applyMasterTypes(true)) return;

    if (absolute) {
      // CSVの時刻はそのまま。種別の名称・色・強調だけ設定タブの内容に合わせる
      applyTypesToItems();
      render();
      scheduleSave();
    } else {
      generate();
    }
  }

  return { mount, setSource, loadFromRegistrations, isMounted: () => mounted };
})();
