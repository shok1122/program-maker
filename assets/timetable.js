"use strict";

/* タイムテーブル作成ツール（管理画面の「タイムテーブル」タブ）。
   参加登録の一覧から発表順を受け取り、開始時刻・固定枠に合わせてコマを並べる。
   CSVの入出力と手動並べ替えは従来どおり。
   編集内容は下書きとして自動保存される（サーバー版はサーバー、デモ版は localStorage）。

   時刻の割り当てそのもの（下書き → 表の行）は assets/schedule.js にある。
   一般公開ページ（assets/program.js）も同じものを使うので、両者の表は必ず一致する。

   会期（設定タブ）が複数日ある場合は、発表日ごとに独立した1日ぶんの下書きを持つ。
   基本設定・休憩・特別・発表の並びはすべて発表日ごとなので、日によって開始時刻や
   休憩のタイミングが違ってもよい。表示していない日の下書きは dayStore に退避し、
   保存するときに全日ぶんをまとめて1つのオブジェクトにする。 */

window.Timetable = (function () {

  /* ---------------- helpers ---------------- */
  /* 時刻の計算・配色・下書きの正規化は assets/schedule.js（公開ページと共有） */
  const S = window.TTSchedule;
  const uid = S.uid, toMin = S.toMin, toStr = S.toStr;
  const typeColor = S.typeColor, typeLen = S.typeLen, KIND = S.KIND;
  const splitSpeaker = S.splitSpeaker;

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s)
    .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /* ---------------- state ---------------- */
  // 発表種別 {id, name, talk, qa, emphasis}。設定タブの種別マスタが正で、ここでは編集しない。
  // CSVから取り込んだ種別など、マスタに無いものだけ末尾に残る。
  let talkTypes = [];
  // 休憩の枠 {id, start, end, label}
  let breakSlots = [{ id: uid(), start: "15:00", end: "15:15", label: "休憩" }];
  // 特別の枠 {id, start, end, label}。開会式・授賞式など発表以外のプログラム。
  let specialSlots = [];
  // 発表の並び順そのもの。手動で入れ替え可能で、再生成をまたいで保持される
  // {id, typeId, title, speaker, affiliation}
  let talkList = [];
  let items = [];         // rendered rows
  let refocus = null;     // 再描画後にフォーカスを戻す並べ替えボタン
  let noticeLead = null;  // 次の generate() の通知に前置するメッセージ {msgs,type}
  let absolute = false;   // CSVの時刻をそのまま使っている状態か

  // 発表日ごとの下書き。dayKeys は表示できる発表日（"" は「日付未定」＝会期未設定なら唯一の枠）、
  // dayKey はいま表示している日。表示中の日の内容は上のモジュール変数が正で、
  // 表示していない日の下書きだけ dayStore に持つ。
  let dayKeys = [""];
  let dayKey = "";
  let dayStore = {};

  let ctx = null;         // {source:{registrations,types,dates}, saveDraft(draft)}
  let mounted = false;
  let suspendSave = false;
  let saveTimer = null;

  /* 休憩と特別はどちらも「時間帯＋名称」の枠で、違うのは表での見え方と呼び名だけ。
     エディタ・タイムテーブルの生成・CSVの処理はこの表を回して共通に扱う
     （キーは items の type と KIND のキーでもある）。 */
  const SLOT_KINDS = {
    break: {
      box: "#tt-slots", add: "#tt-add-slot", len: 15, fallback: "15:00",
      empty: "休憩はまだありません", placeholder: "名称（休憩・コーヒーブレイク 等）",
      get: () => breakSlots, set: v => { breakSlots = v; }
    },
    special: {
      box: "#tt-special", add: "#tt-add-special", len: 30, fallback: "10:00",
      empty: "特別はまだありません", placeholder: "名称（開会式・授賞式 等）",
      get: () => specialSlots, set: v => { specialSlots = v; }
    }
  };
  const SLOT_TYPES = Object.keys(SLOT_KINDS);

  /* ---------------- 発表日 ---------------- */
  const sourceDates = () =>
    ((((ctx || {}).source) || {}).dates || []).filter(d => typeof d === "string" && d);
  const dayName = key => (key ? TM.dateLabel(key) : "日付未定");
  const dayTitle = key => (key ? TM.dateLabel(key, true) : "日付未定");

  /* その発表日に割り当てられた参加登録。会期が未設定ならすべてが対象。 */
  function regsForDay(key) {
    const regs = (((ctx || {}).source) || {}).registrations || [];
    if (!sourceDates().length) return regs;
    return regs.filter(r => String(r.date || "") === key);
  }

  /* 表示できる発表日の一覧。会期の各日に加えて、発表日が未定の登録や
     未定の下書きが残っている間は「日付未定」も出す。 */
  function computeDayKeys() {
    const dates = sourceDates();
    if (!dates.length) return [""];
    const keys = dates.slice();
    const regs = (((ctx || {}).source) || {}).registrations || [];
    const draft = dayStore[""];
    if (regs.some(r => !r.date) || dayKey === "" ||
        (draft && Array.isArray(draft.talkList) && draft.talkList.length))
      keys.push("");
    return keys;
  }

  /* 切り替えボタンに出す件数。まだ開いていない日は、読み込まれる予定の登録数を出す。 */
  function dayCount(key) {
    if (key === dayKey) return talkList.length;
    const d = dayStore[key];
    if (d && Array.isArray(d.talkList)) return d.talkList.length;
    return regsForDay(key).length;
  }

  function renderDays() {
    const multi = dayKeys.length > 1;
    const box = $("#tt-days");
    if (box) {
      box.hidden = !multi;
      box.innerHTML = !multi ? "" : `<span class="lbl">発表日</span>` + dayKeys.map((k, i) => {
        const label = k ? `${i + 1}日目 ${esc(dayName(k))}` : `<span class="undated">日付未定</span>`;
        return `<button type="button" class="day-btn${k === dayKey ? " on" : ""}"
          data-day="${esc(k)}" title="${esc(dayTitle(k))}"${k === dayKey ? ` aria-current="true"` : ""}
          >${label}<span class="n">${dayCount(k)}</span></button>`;
      }).join("");
    }
    const ttl = $("#tt-title");
    if (ttl) {
      // 1日開催でも会期を指定していれば日付を見出しに出す（印刷にも出る）
      const named = multi || !!dayKey;
      ttl.textContent = named ? dayTitle(dayKey) : "Timetable";
      ttl.className = named ? "ttl day" : "ttl";
    }
    // 左パネルの設定がどの日のものかを見出しに出す
    document.querySelectorAll("#panel-tt .day-tag")
      .forEach(el => { el.textContent = multi ? dayTitle(dayKey) : ""; });
    renderLoadScope();
  }

  /* いまの日を dayStore に退避してから、別の発表日に切り替える。 */
  function switchDay(key) {
    if (key === dayKey || dayKeys.indexOf(key) < 0) return;
    dayStore[dayKey] = serializeDay();
    dayKey = key;
    loadDay();
    scheduleSave();
  }

  /* いまの dayKey の内容を画面に反映する。下書きが無ければ登録一覧から取り込む。 */
  function loadDay() {
    const d = dayStore[dayKey];
    noticeLead = null;
    suspendSave = true;
    try {
      if (d) applyDayDraft(d);
      else { resetDay(); loadFromRegistrations(true); }
    } finally {
      suspendSave = false;
    }
  }

  /* 会期や登録の変化を受けて発表日の一覧を作り直す。 */
  function refreshDays() {
    const before = dayKeys.join("\u0000");
    dayKeys = computeDayKeys();
    if (dayKeys.indexOf(dayKey) < 0) {
      dayStore[dayKey] = serializeDay();   // 会期に戻ってきたときのために残しておく
      dayKey = dayKeys[0];
      loadDay();
      return "switched";
    }
    return dayKeys.join("\u0000") !== before ? "changed" : "";
  }

  /* 1日ぶんの初期値。まだ触っていない発表日はこの内容から始まる。 */
  const blankDayDraft = S.blankDay;

  /* 1日ぶんの内容を初期状態に戻す。 */
  function resetDay() {
    const d = blankDayDraft();
    $("#tt-start").value = d.start;
    $("#tt-lunch-on").checked = d.lunchOn;
    $("#tt-lunch-start").value = d.lunchStart;
    $("#tt-lunch-end").value = d.lunchEnd;
    $("#tt-showgap").checked = d.showGap;
    breakSlots = d.breakSlots;
    specialSlots = d.specialSlots;
    talkList = [];
    items = [];
    absolute = false;
    renderSlots();
  }

  /* その発表日に発表が入っているか（まだ開いていない日は空とみなす）。 */
  const dayHasTalks = key => (key === dayKey
    ? talkList.length > 0
    : !!(dayStore[key] && Array.isArray(dayStore[key].talkList) && dayStore[key].talkList.length));

  /* 「登録一覧から読み込む」で上書きする発表日の選択（複数可）。会期が複数日のときだけ出す。 */
  let scopeSig = "";
  function renderLoadScope() {
    const box = $("#tt-load-scope");
    if (!box) return;
    const multi = dayKeys.length > 1;
    box.hidden = !multi;
    if (!multi) { box.innerHTML = ""; scopeSig = ""; return; }

    // 日と件数が変わったときだけ作り直す。チェックは引き継ぎ、増えた日は選択済みで始める
    const sig = dayKeys.join("|") + "#" + dayKeys.map(k => regsForDay(k).length).join(",");
    if (sig !== scopeSig) {
      scopeSig = sig;
      const was = {};
      box.querySelectorAll("input").forEach(i => { was[i.value] = i.checked; });
      box.innerHTML = `<div class="scope-head">
          <span class="mini">上書きする発表日</span>
          <button type="button" class="link" data-all="1">すべて選択</button>
          <button type="button" class="link" data-all="0">すべて解除</button>
        </div>`
        + dayKeys.map((k, i) => `<label><input type="checkbox" value="${esc(k)}"${
            was[k] === false ? "" : " checked"}>${
            esc(k ? `${i + 1}日目 ${dayName(k)}` : "日付未定")
          }<span class="n">${regsForDay(k).length}件</span></label>`).join("");
    }
    markLoadScope();
  }
  /* チェックの見た目・読み込みボタンの有効／無効・ヒントをそろえる。 */
  function markLoadScope() {
    const box = $("#tt-load-scope");
    if (box) box.querySelectorAll("label")
      .forEach(l => l.classList.toggle("on", !!l.querySelector("input:checked")));
    const btn = $("#tt-load-regs");
    if (btn) btn.disabled = !selectedDays().length;
    updateLoadHint();
  }
  /* いま選ばれている発表日。会期が1日ぶんしか無いときは、その日だけ。 */
  function selectedDays() {
    if (dayKeys.length <= 1) return [dayKey];
    return [...document.querySelectorAll("#tt-load-scope input:checked")]
      .map(i => i.value).filter(v => dayKeys.indexOf(v) >= 0);
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
  /* いま表示している1日ぶんの内容。 */
  function serializeDay() {
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
      specialSlots: specialSlots.map(c => ({ id: c.id, start: c.start, end: c.end, label: c.label })),
      // CSVの時刻をそのまま使っている場合だけ、その時刻を保存して復元する
      absolute: absolute,
      items: absolute ? items.map(it => Object.assign({}, it)) : null
    };
  }

  /* 保存する下書きは全日ぶんをまとめた1つのオブジェクト。
     会期から外れた日の下書きは、中身があるものだけ残す（会期を戻せばそのまま復帰する）。 */
  function serialize() {
    const days = {};
    for (const k of Object.keys(dayStore)) {
      const d = dayStore[k];
      if (dayKeys.indexOf(k) >= 0 || (d && Array.isArray(d.talkList) && d.talkList.length))
        days[k] = d;
    }
    days[dayKey] = serializeDay();
    return { version: 2, current: dayKey, days, savedAt: new Date().toISOString() };
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

  /* 保存された下書きを dayStore / dayKey に取り込む（画面への反映は loadDay）。
     発表日を持たなかったころの下書きは、会期があれば初日のものとして引き継ぐ。 */
  function readDraft(draft) {
    dayStore = {};
    dayKey = null;
    if (!draft || typeof draft !== "object") return false;

    let src = null;
    if (draft.days && typeof draft.days === "object" && !Array.isArray(draft.days)) {
      src = draft.days;
      if (typeof draft.current === "string") dayKey = draft.current;
    } else if (Array.isArray(draft.talkList) || draft.start) {
      const dates = sourceDates();
      src = {}; src[dates.length ? dates[0] : ""] = draft;
    }
    if (!src) return false;

    let any = false;
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (v && typeof v === "object" && !Array.isArray(v)) { dayStore[String(k)] = v; any = true; }
    }
    if (!any) dayKey = null;
    return any;
  }

  /* 1日ぶんの下書きを画面に反映する（呼び出し側で suspendSave する）。 */
  function applyDayDraft(draft) {
    const d = S.normalizeDayDraft(draft);

    $("#tt-start").value = d.start;
    $("#tt-lunch-on").checked = d.lunchOn;
    $("#tt-lunch-start").value = d.lunchStart;
    $("#tt-lunch-end").value = d.lunchEnd;
    $("#tt-showgap").checked = d.showGap;

    if (d.talkTypes.length) talkTypes = d.talkTypes;
    const known = new Set(talkTypes.map(t => t.id));
    talkList = d.talkList.filter(e => known.has(e.typeId));
    applyMasterTypes(true);   // 下書きより設定タブの種別マスタを優先する
    breakSlots = d.breakSlots;
    specialSlots = d.specialSlots;
    renderSlots();

    if (d.absolute) {
      absolute = true;
      items = d.items;
      applyTypesToItems();
      render();
      renderNotice([], "");
    } else {
      generate();
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

  /* 発表種別は設定タブでしか編集できないので、マスタの内容をこちらへ取り込む
     （突き合わせの規則は S.mergeMasterTypes）。並びが変わったかどうかを返す。 */
  function applyMasterTypes(sync) {
    const next = S.mergeMasterTypes(talkTypes, masterTypes(), talkList, sync);
    const key = list => JSON.stringify(list.map(t => [t.id, t.name, t.talk, t.qa, !!t.emphasis]));
    const changed = key(next) !== key(talkTypes);
    talkTypes = next;
    return changed;
  }

  /* CSVの時刻をそのまま使っている状態（absolute）では時刻を振り直さないので、
     種別の名称・色・強調だけを talkTypes の内容に合わせる。 */
  function applyTypesToItems() { S.applyTypesToItems(items, talkTypes, talkList); }

  /* ---------------- 参加登録からの読み込み ---------------- */
  /* 登録の一覧を発表順（talkList）に変換する。 */
  const entriesFromRegs = regs => S.entriesFromRegs(regs, masterTypes());

  function orphanNote(msgs, orphan) {
    if (orphan.length)
      msgs.push(`種別マスタに無い種別（${[...new Set(orphan)].join("・")}）は登録に残っている名前で仮に作成しました。`);
    return msgs;
  }

  /* 表示している発表日の発表を、登録一覧の内容で置き換える。 */
  function loadFromRegistrations(quiet) {
    const r = entriesFromRegs(regsForDay(dayKey));
    talkList = r.list;
    talkTypes = r.types;
    absolute = false;
    renderSlots();

    if (!quiet) {
      const where = dayKeys.length > 1 ? `${dayTitle(dayKey)}の` : "";
      noticeLead = {
        msgs: orphanNote([`${where}参加登録 ${r.list.length} 件を発表順として読み込みました。`], r.orphan),
        type: r.orphan.length ? "warn" : "ok"
      };
    }
    generate();
    return talkList.length;
  }

  /* 表示していない発表日の下書きの発表だけを置き換える。
     その日の開始時刻・ランチ・休憩・特別・空き時間の設定はそのまま残す。 */
  function writeDayFromRegs(key) {
    const r = entriesFromRegs(regsForDay(key));
    dayStore[key] = Object.assign(dayStore[key] || blankDayDraft(), {
      talkTypes: r.types.map(t => ({ id: t.id, name: t.name, talk: t.talk, qa: t.qa,
                                     emphasis: !!t.emphasis })),
      talkList: r.list,
      absolute: false,
      items: null
    });
    return r;
  }

  /* 「登録一覧から読み込む」の本体。選ばれた発表日を、登録一覧の内容で上書きする。
     表示していない日は下書きに直接書き込み、表示中の日だけ画面に反映する。 */
  function loadRegistrations(keys) {
    keys = keys.filter(k => dayKeys.indexOf(k) >= 0);
    if (!keys.length) return;
    // 表示中の日が対象外なら、結果が見えるように最初の対象へ移る
    if (keys.indexOf(dayKey) < 0) switchDay(keys[0]);
    if (keys.length === 1) { loadFromRegistrations(false); return; }

    const orphan = [], per = [];
    for (const k of keys) {
      if (k === dayKey) continue;                 // 表示中の日は下で入れ替える
      const r = writeDayFromRegs(k);
      per.push([k, r.list.length]);
      orphan.push(...r.orphan);
    }
    const mine = entriesFromRegs(regsForDay(dayKey));
    talkList = mine.list;
    talkTypes = mine.types;
    absolute = false;
    per.push([dayKey, mine.list.length]);
    orphan.push(...mine.orphan);
    renderSlots();

    const total = per.reduce((n, p) => n + p[1], 0);
    const order = dayKeys.map(k => per.filter(p => p[0] === k)[0]).filter(Boolean);
    noticeLead = {
      msgs: orphanNote([`参加登録 ${total} 件を ${keys.length} つの発表日に読み込みました`
        + `（${order.map(([k, n]) => `${dayName(k)} ${n}件`).join("・")}）。`], orphan),
      type: orphan.length ? "warn" : "ok"
    };
    generate();
  }

  function updateLoadHint() {
    const el = $("#tt-load-hint");
    if (!el || !ctx) return;
    if (dayKeys.length > 1) {
      const sel = selectedDays();
      if (!sel.length) {
        el.innerHTML = `上書きする発表日を1つ以上選んでください。`;
        return;
      }
      const undated = dayKeys.indexOf("") >= 0 ? regsForDay("").length : 0;
      el.innerHTML = `チェックした <b>${sel.length}</b> つの発表日の発表と手動の並べ替えが、`
        + `登録一覧の内容で置き換わります（開始時刻・ランチ・休憩・特別はその日の設定のまま残ります）。`
        + (undated ? `<br>発表日が未定の登録が <b>${undated}</b> 件あります。`
                   + `「登録一覧」タブで発表日を指定してください。` : "");
      return;
    }
    const n = regsForDay(dayKey).length;
    el.innerHTML = n
      ? `現在の登録は <b>${n}</b> 件です。読み込むと、いま表内にある発表と手動の並べ替えは登録一覧の内容で置き換わります。`
      : `登録がまだありません。参加登録ページから申込があると、ここから取り込めます。`;
  }

  /* ---------------- generation ---------------- */
  /* 左パネルの設定と発表の並びから表の行を組み立てる（割り当てそのものは S.layout）。 */
  function generate() {
    const s = readSettings();
    const lead = noticeLead; noticeLead = null;
    absolute = false;

    const r = S.layout({
      start: s.start, lunchOn: s.lunchOn, lunchStart: s.lunchStart, lunchEnd: s.lunchEnd,
      showGap: s.showGap, breakSlots, specialSlots
    }, talkTypes, talkList);

    if (r.error) {
      renderNotice([r.error], "err");
      items = []; render(); return;
    }

    talkList = r.talkList;
    items = r.items;
    renderNotice(lead ? lead.msgs.concat(r.warnings) : r.warnings,
                 r.warnings.length ? "warn" : (lead ? lead.type : ""));
    render();
    scheduleSave();
  }

  /* ---------------- rendering ---------------- */
  function render() {
    const body = $("#tt-board");

    renderDays();
    renderTypes();
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
      (total > 0 ? `<span>所要 <b>${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}m</b></span>` : "");

    renderLegend();

    if (!items.length) {
      body.innerHTML = `<div class="empty-board"><b>タイムテーブルが空です</b>「登録一覧から読み込む」か「CSVインポート」から作りはじめてください。</div>`;
      refocus = null;
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
  }

  /* 発表＋質疑が0分の種別（ポスター発表など）は時刻を持てずタイムテーブルに並べられないので、
     表の下に種別ごとの一覧として出す。 */
  function renderUntimed() {
    const box = $("#tt-untimed");
    if (!box) return;
    const groups = S.untimedGroups(talkTypes, talkList);
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
    if (has("lunch"))   seg.push(`<span><i style="background:var(--lunch)"></i>ランチ</span>`);
    if (has("break"))   seg.push(`<span><i style="background:var(--break)"></i>休憩</span>`);
    if (has("special")) seg.push(`<span><i style="background:var(--special)"></i>特別</span>`);
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

  /* ---------------- 発表の削除 ---------------- */
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

  /* ---------------- 休憩・特別エディタ ---------------- */
  function renderSlots() { SLOT_TYPES.forEach(renderSlotKind); }

  function renderSlotKind(type) {
    const k = SLOT_KINDS[type];
    const box = $(k.box);
    if (!box) return;
    const list = k.get();
    if (!list.length) {
      box.innerHTML = `<div class="slot-empty">${esc(k.empty)}</div>`;
      return;
    }
    box.innerHTML = list.map(c => `
      <div class="slot-row" data-id="${esc(c.id)}">
        <div class="times">
          <input type="time" data-k="start" value="${esc(c.start || "")}">
          <input type="time" data-k="end" value="${esc(c.end || "")}">
        </div>
        <input class="name" type="text" data-k="label" placeholder="${esc(k.placeholder)}" value="${esc(c.label)}">
        <button class="kill" data-del="${esc(c.id)}" title="削除">×</button>
      </div>`).join("");
  }

  /* 1種類ぶんのエディタに追加・編集・削除をつなぐ（bind から1回だけ呼ばれる）。 */
  function bindSlotEditor(type) {
    const k = SLOT_KINDS[type];
    const box = $(k.box), add = $(k.add);
    if (!box || !add) return;

    // 追加する枠は、最後の枠の終わり（無ければ開始時刻）から続けて置く
    add.addEventListener("click", () => {
      const list = k.get();
      const last = list[list.length - 1];
      const base = last ? toMin(last.end) : toMin($("#tt-start").value);
      const from = base != null ? base : toMin(k.fallback);
      list.push({ id: uid(), start: toStr(from), end: toStr(from + k.len), label: KIND[type].label });
      renderSlotKind(type); generate();
    });
    box.addEventListener("input", e => {
      const row = e.target.closest(".slot-row"); if (!row) return;
      const c = k.get().find(x => x.id === row.dataset.id); if (!c) return;
      const f = e.target.dataset.k; if (f) c[f] = e.target.value;
      generate();
    });
    box.addEventListener("click", e => {
      const del = e.target.dataset.del; if (!del) return;
      k.set(k.get().filter(x => x.id !== del));
      renderSlotKind(type); generate();
    });
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
    a.download = dayKey ? `timetable-${dayKey}.csv` : "timetable.csv";
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

  const KIND_FROM = { "発表": "talk", "ランチ": "lunch", "昼食": "lunch", "休憩": "break", "特別": "special" };

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
    const fixed = [];    // 時刻付きの休憩・特別
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
        fixed.push({ type, start: s, end: e, label: title || KIND[type].label });
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
    applyMasterTypes(false);   // CSVに無かった種別も種別マスタのぶんは残す
    SLOT_TYPES.forEach(type => SLOT_KINDS[type].set(
      fixed.filter(f => f.type === type)
        .map(f => ({ id: uid(), start: toStr(f.start), end: toStr(f.end), label: f.label }))));
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
      const keys = selectedDays();
      if (!keys.length) return;
      const n = keys.reduce((sum, k) => sum + regsForDay(k).length, 0);
      if (keys.some(k => dayHasTalks(k))) {
        let what;
        if (dayKeys.length <= 1) what = "いま表にある発表";
        else if (keys.length === 1) what = `${dayTitle(keys[0])}のタイムテーブル`;
        else if (keys.length === dayKeys.length)
          what = `すべての発表日（${dayKeys.length}日ぶん）のタイムテーブル`;
        else what = `選んだ ${keys.length} つの発表日（${keys.map(dayName).join("・")}）のタイムテーブル`;
        if (!confirm(`${what}を、参加登録 ${n} 件で置き換えます。よろしいですか？`)) return;
      }
      loadRegistrations(keys);
    });
    // 発表日のチェック（個別／一括）
    $("#tt-load-scope").addEventListener("change", markLoadScope);
    $("#tt-load-scope").addEventListener("click", e => {
      const b = e.target.closest("button[data-all]");
      if (!b) return;
      const on = b.dataset.all === "1";
      $("#tt-load-scope").querySelectorAll("input").forEach(i => { i.checked = on; });
      markLoadScope();
    });

    // 発表日の切り替え
    const days = $("#tt-days");
    if (days) days.addEventListener("click", e => {
      const b = e.target.closest(".day-btn");
      if (b) switchDay(b.dataset.day);
    });

    // 休憩・特別の追加・編集・削除
    SLOT_TYPES.forEach(bindSlotEditor);

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

    const restored = readDraft(ctx.draft);
    dayKeys = computeDayKeys();
    if (dayKey == null || dayKeys.indexOf(dayKey) < 0)
      dayKey = dayKeys.filter(k => dayStore[k])[0] || dayKeys[0];
    updateLoadHint();

    // 下書きの無い発表日は、その日の登録一覧をそのまま発表順として取り込む。
    // quiet=true で「読み込みました」の通知は出さないが、
    // 発表0件・時刻の矛盾といった generate() の警告はそのまま見せる。
    loadDay();
    if (restored) setSaved("下書きを復元しました", false);
  }

  /* 設定タブでの保存・登録の増減を受け取る。発表種別はここが唯一の入り口になるので、
     マスタが変わっていれば時刻を振り直して表に反映する。 */
  function setSource(source) {
    if (!ctx) return;
    ctx.source = source;
    const days = refreshDays();          // 会期・発表日の増減を先に反映する
    updateLoadHint();
    if (days === "switched") { scheduleSave(); return; }
    if (!applyMasterTypes(true)) { renderDays(); return; }

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
