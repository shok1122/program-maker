"use strict";

/* タイムテーブルの一般公開ページ（program.html）。

   管理画面が保存した下書きを読むだけの閲覧専用ページで、ログインは要らない。
   公開・非公開は「設定」タブの公開フラグ（settings.publicTimetable）で決まり、
   非公開のあいだはサーバーがタイムテーブルの中身を返さないので、
   このページは「公開していません」の案内だけを表示する。

   表の組み立ては管理画面と同じ assets/schedule.js を通すので、
   管理画面で見えている時間割と公開ページの内容は必ず一致する。 */

(function () {

  const S = window.TTSchedule;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s)
    .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const ALL = "*";      // 発表日の切り替えの「すべて」

  let data = null;      // /api/program の内容
  let dayKeys = [];     // 表示できる発表日（"" は日付未定）
  let view = ALL;       // いま表示している発表日、または ALL

  function notice(msg, kind) {
    const n = $("#notice");
    if (!msg) { n.className = "notice"; n.innerHTML = ""; return; }
    const icon = kind === "ok" ? "✓" : kind === "err" ? "✕" : "！";
    n.className = "notice show " + (kind || "info");
    n.innerHTML = `<span style="font-weight:700">${icon}</span><div class="grow">${esc(msg)}</div>`;
  }

  /* ---------------- 発表日 ---------------- */
  const eventDates = () => TM.eventDates(data);
  const dayName = key => (key ? TM.dateLabel(key) : "日付未定");
  const dayTitle = key => (key ? TM.dateLabel(key, true) : "日付未定");

  const savedDays = () => {
    const t = data.timetable;
    return t && t.days && typeof t.days === "object" && !Array.isArray(t.days) ? t.days : {};
  };
  /* 発表日を持たなかったころの下書き（1日ぶんが直接入っている）は初日のものとして扱う。 */
  function draftFor(key) {
    const t = data.timetable;
    if (!t || typeof t !== "object") return null;
    if (t.days && typeof t.days === "object" && !Array.isArray(t.days)) return t.days[key] || null;
    if (Array.isArray(t.talkList) || t.start) {
      const dates = eventDates();
      return key === (dates.length ? dates[0] : "") ? t : null;
    }
    return null;
  }

  /* その発表日に割り当てられた参加登録。会期が未設定ならすべてが対象。 */
  function regsForDay(key) {
    const regs = data.registrations || [];
    if (!eventDates().length) return regs;
    return regs.filter(r => String(r.date || "") === key);
  }

  /* 表示する発表日の一覧（管理画面の発表日の切り替えと同じ規則）。 */
  function computeDayKeys() {
    const dates = eventDates();
    if (!dates.length) return [""];
    const keys = dates.slice();
    const undated = savedDays()[""];
    if ((data.registrations || []).some(r => !r.date) ||
        (undated && Array.isArray(undated.talkList) && undated.talkList.length))
      keys.push("");
    return keys;
  }

  /* ---------------- 1日ぶんの組み立て ---------------- */
  const master = () => (data.types || []).map(t => ({
    id: t.id,
    name: String(t.name == null ? "" : t.name),
    talk: Math.max(0, parseInt(t.talk, 10) || 0),
    qa: Math.max(0, parseInt(t.qa, 10) || 0),
    emphasis: t.emphasis === true
  }));

  /* 下書きがある発表日はその内容を、まだ無い発表日は登録一覧から組み立てる
     （管理画面がその発表日を初めて開いたときと同じ状態）。 */
  function buildDay(key) {
    const saved = draftFor(key);
    const regs = regsForDay(key);
    if (!saved && !regs.length) return { key, pending: true, items: [], types: [], talkList: [] };

    let d, types;
    if (saved) {
      d = S.normalizeDayDraft(saved);
      types = d.talkTypes;
    } else {
      d = S.blankDay();
      const r = S.entriesFromRegs(regs, master());
      d.talkList = r.list;
      types = r.types;
    }
    const known = new Set(types.map(t => t.id));
    const list = d.talkList.filter(e => known.has(e.typeId));
    types = S.mergeMasterTypes(types, master(), list, true);   // 種別マスタを優先する

    // CSVの時刻をそのまま使っている日は時刻を振り直さない（管理画面と同じ扱い）
    if (d.absolute)
      return { key, items: S.applyTypesToItems(d.items, types, list), types, talkList: list };

    const r = S.layout(d, types, list);
    return { key, items: r.error ? [] : r.items, types, talkList: r.error ? list : r.talkList };
  }

  /* ---------------- 描画 ---------------- */
  function legendHtml(day) {
    const seg = [];
    const shown = new Set(day.items.filter(i => i.type === "talk").map(i => i.typeName));
    day.types.forEach((t, i) => {
      const name = t.name || `種別${i + 1}`;
      if (S.typeLen(t) <= 0 || !shown.has(name)) return;
      seg.push(`<span><i style="background:${S.typeColor(i).chip}"></i>${esc(name)}</span>`);
    });
    const has = k => day.items.some(i => i.type === k);
    if (has("lunch"))   seg.push(`<span><i style="background:var(--lunch)"></i>ランチ</span>`);
    if (has("break"))   seg.push(`<span><i style="background:var(--break)"></i>休憩</span>`);
    if (has("special")) seg.push(`<span><i style="background:var(--special)"></i>特別</span>`);
    return seg.join("");
  }

  function rowsHtml(day) {
    let no = 0;
    return day.items.map(it => {
      if (it.type === "gap") return "";      // 空き時間は編集のための表示なので出さない
      const time = `<td class="c-time"><div class="cell"><div class="time-range">
          <span class="chip"${it.type === "talk"
            ? ` style="background:${S.typeColor(it.colorIdx || 0).chip}"` : ""}></span>
          <span class="rng">${S.toStr(it.start)}<small>– ${S.toStr(it.end)}</small></span>
        </div></div></td>`;

      if (it.type === "talk") {
        const c = S.typeColor(it.colorIdx || 0);
        const em = !!it.emph;
        no++;
        return `<tr${em ? ` class="row-emph" style="background:${c.bg};--emph:${c.chip}"` : ""}>
          <td class="c-no">${no}</td>
          ${time}
          <td class="c-kind"><div class="cell"><span class="badge" style="background:${
            em ? c.chip : c.bg};color:${em ? "#fff" : c.fg}">${esc(it.typeName || "発表")}</span></div></td>
          <td><div class="cell ro-cell">
            <div class="ro-title">${it.title ? esc(it.title) : `<span class="ro-none">（無題）</span>`}</div>
            ${it.speaker ? `<div class="ro-sub">${esc(it.speaker)}</div>` : ""}
          </div></td>
        </tr>`;
      }
      const k = S.KIND[it.type] || S.KIND.break;
      return `<tr class="row-${it.type}">
        <td class="c-no"></td>
        ${time}
        <td class="c-kind"><div class="cell"><span class="badge ${k.cls}">${k.label}</span></div></td>
        <td><div class="cell fixed-label">${esc(it.label)}</div></td>
      </tr>`;
    }).join("");
  }

  /* 発表時間が0分の種別（ポスター発表など）は時刻を持てないので、表の下に一覧で出す。 */
  function untimedHtml(day) {
    return S.untimedGroups(day.types, day.talkList).map(g => {
      const c = S.typeColor(g.i);
      const em = !!g.t.emphasis;
      const rows = g.list.map((e, n) => `<tr>
        <td class="num">${n + 1}</td>
        <td class="u-title">${e.title ? esc(e.title) : `<span class="u-none">（無題）</span>`}</td>
        <td>${esc(e.speaker)}</td>
        <td class="u-org">${esc(e.affiliation)}</td>
      </tr>`).join("");
      return `<div class="board untimed${em ? " emph" : ""}"${
        em ? ` style="--emph:${c.chip};--emph-bg:${c.bg}"` : ""}>
        <div class="board-head">
          <span class="ttl"><i class="sw" style="background:${c.chip}"></i>${
            esc(g.t.name || `種別${g.i + 1}`)}</span>
          <div class="summary" style="font-size:11px"><span>発表 <b>${g.list.length}</b> 件</span></div>
        </div>
        <div class="board-scroll"><table>
          <thead><tr>
            <th class="num">#</th><th>タイトル</th>
            <th style="width:170px">発表者</th><th style="width:210px">所属</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
    }).join("");
  }

  function dayHtml(day, named) {
    const talks = day.items.filter(i => i.type === "talk");
    const total = day.items.length ? day.items[day.items.length - 1].end - day.items[0].start : 0;
    const summary = day.pending ? "" :
      `<span>発表 <b>${talks.length}</b> 件</span>` +
      (total > 0 ? `<span>所要 <b>${Math.floor(total / 60)}h${
        String(total % 60).padStart(2, "0")}m</b></span>` : "");

    const body = day.pending
      ? `<div class="empty-board"><b>準備中</b>この発表日のプログラムはまだ公開されていません。</div>`
      : `<div class="board-scroll"><table>
          <thead><tr>
            <th class="c-no">#</th><th>時刻</th><th>種別</th><th>内容</th>
          </tr></thead>
          <tbody>${rowsHtml(day)}</tbody>
        </table></div>`;

    return `<section class="pg-day">
      <div class="board">
        <div class="board-head">
          <span class="ttl${named ? " day" : ""}">${named ? esc(dayTitle(day.key)) : "Timetable"}</span>
          <div class="summary" style="font-size:11px;gap:14px">${summary}</div>
          <div class="legend">${day.pending ? "" : legendHtml(day)}</div>
        </div>
        ${body}
      </div>
      ${untimedHtml(day)}
    </section>`;
  }

  function renderDayButtons() {
    const box = $("#pg-days");
    const multi = dayKeys.length > 1;
    box.hidden = !multi;
    if (!multi) { box.innerHTML = ""; return; }
    box.innerHTML = `<span class="lbl">発表日</span>`
      + dayKeys.map((k, i) => {
          const label = k ? `${i + 1}日目 ${esc(dayName(k))}` : `<span class="undated">日付未定</span>`;
          return `<button type="button" class="day-btn${k === view ? " on" : ""}"
            data-day="${esc(k)}" title="${esc(dayTitle(k))}"${
            k === view ? ` aria-current="true"` : ""}>${label}</button>`;
        }).join("")
      + `<button type="button" class="day-btn${view === ALL ? " on" : ""}" data-day="${ALL}"
          title="すべての発表日をまとめて表示">すべて</button>`;
  }

  function render() {
    const multi = dayKeys.length > 1;
    const keys = view === ALL ? dayKeys : [view];
    const days = keys.map(buildDay);

    renderDayButtons();
    $("#pg-boards").innerHTML = days
      .map(d => dayHtml(d, multi || !!d.key))
      .join("");

    const stamp = data.timetable && data.timetable.savedAt
      ? new Date(data.timetable.savedAt) : null;
    const when = stamp && !isNaN(stamp.getTime())
      ? `${stamp.getFullYear()}/${String(stamp.getMonth() + 1).padStart(2, "0")}/${
          String(stamp.getDate()).padStart(2, "0")} ${String(stamp.getHours()).padStart(2, "0")}:${
          String(stamp.getMinutes()).padStart(2, "0")}`
      : "";
    $("#pg-foot").innerHTML = (when ? `最終更新 ${esc(when)}` : "")
      + (multi && view !== ALL ? `${when ? " ／ " : ""}印刷 / PDF は表示している発表日が対象です。` : "");
  }

  /* ---------------- 起動 ---------------- */
  function applyHeader() {
    const dates = eventDates();
    document.title = (data.eventName || "プログラム") + " プログラム";
    $("#pg-event").textContent = data.eventName || "プログラム";
    $("#pg-summary").innerHTML = dates.length
      ? `<span>会期 <b>${TM.dateLabel(dates[0], true)}${
          dates.length > 1 ? "–" + TM.dateLabel(dates[dates.length - 1]) : ""}</b></span>`
      : "";
  }

  async function boot() {
    let config;
    try {
      config = await TM.init();
      data = await TM.getProgram();
    } catch (err) {
      $("#loading").hidden = true;
      notice(err.message || "プログラムを読み込めませんでした。", "err");
      return;
    }
    if (TM.isDemo()) $("#demo-bar").classList.add("show");
    $("#loading").hidden = true;

    // 受付中のあいだは申込ページへの導線を出す（申込ページ側の「プログラム」と対）。
    // プログラムがまだ公開されていない場合も、受付中なら出す。
    $("#pg-register").hidden = !(config && config.registrationOpen);

    if (!data || !data.published) {
      $("#pg-print").hidden = true;
      notice("タイムテーブルは現在公開されていません。公開の予定については主催者にお問い合わせください。", "info");
      return;
    }

    applyHeader();
    dayKeys = computeDayKeys();
    view = dayKeys.length > 1 ? ALL : dayKeys[0];
    $("#pg-shell").hidden = false;
    render();

    if (!dayKeys.some(k => draftFor(k) || regsForDay(k).length))
      notice("プログラムはまだ用意されていません。", "info");
  }

  $("#pg-days").addEventListener("click", e => {
    const b = e.target.closest(".day-btn");
    if (!b) return;
    const key = b.dataset.day;
    if (key === view) return;
    if (key !== ALL && dayKeys.indexOf(key) < 0) return;
    view = key;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("#pg-print").addEventListener("click", () => window.print());

  boot();
})();
