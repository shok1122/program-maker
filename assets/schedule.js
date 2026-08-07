"use strict";

/* タイムテーブルの組み立てのうち、画面（DOM）に依存しない部分。

   管理画面のタイムテーブルタブ（assets/timetable.js）と一般公開ページ（assets/program.js）は
   同じ下書きから同じ表を作らなければならないので、時刻の割り当て・発表種別の突き合わせ・
   下書きの正規化はすべてここに置く。ここを直せば両方の画面に効く。 */

window.TTSchedule = (function () {

  function uid() { return Math.random().toString(36).slice(2, 9); }

  /* "HH:MM" ⇔ 0時からの分数 */
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

  /* 表の行の種類。items の type と対応する。 */
  const KIND = {
    talk:    { label: "発表",   cls: "talk" },
    lunch:   { label: "ランチ", cls: "lunch" },
    break:   { label: "休憩",   cls: "break" },
    special: { label: "特別",   cls: "special" }
  };

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

  /* 1日ぶんの初期値。まだ触っていない発表日はこの内容から始まる。 */
  const blankDay = () => ({
    start: "09:00", lunchOn: true, lunchStart: "12:00", lunchEnd: "13:00", showGap: true,
    talkTypes: [], talkList: [],
    breakSlots: [{ id: uid(), start: "15:00", end: "15:15", label: "休憩" }],
    specialSlots: [],
    absolute: false, items: null
  });

  /* 保存された1日ぶんの下書きを、いまの形に整えて返す（古い下書きの形も受け付ける）。
     発表と発表種別の突き合わせ（種別マスタの反映）は mergeMasterTypes / layout が行う。 */
  function normalizeDayDraft(draft) {
    draft = draft && typeof draft === "object" ? draft : {};
    const d = blankDay();

    d.start = draft.start || d.start;
    d.lunchOn = draft.lunchOn !== false;
    d.lunchStart = draft.lunchStart || d.lunchStart;
    d.lunchEnd = draft.lunchEnd || d.lunchEnd;
    d.showGap = draft.showGap !== false;

    d.talkTypes = (Array.isArray(draft.talkTypes) ? draft.talkTypes : [])
      .filter(t => t && typeof t === "object")
      .map((t, i) => ({
        id: typeof t.id === "string" && t.id ? t.id : uid(),
        name: String(t.name == null ? "" : t.name) || `種別${i + 1}`,
        talk: Math.max(0, parseInt(t.talk, 10) || 0),
        qa: Math.max(0, parseInt(t.qa, 10) || 0),
        emphasis: t.emphasis === true
      }));

    d.talkList = (Array.isArray(draft.talkList) ? draft.talkList : [])
      .filter(e => e && typeof e === "object")
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

    const normSlots = list => (Array.isArray(list) ? list : [])
      .filter(c => c && typeof c === "object").map(c => ({
        id: typeof c.id === "string" && c.id ? c.id : uid(),
        start: String(c.start || ""), end: String(c.end || ""),
        label: String(c.label == null ? "" : c.label)
      }));
    // customSlots は休憩と特別を1つの表で持っていたころの下書き（type で分かれていた）
    if (!Array.isArray(draft.breakSlots) && Array.isArray(draft.customSlots)) {
      d.breakSlots = normSlots(draft.customSlots.filter(c => c && c.type !== "custom"));
      d.specialSlots = normSlots(draft.customSlots.filter(c => c && c.type === "custom"));
    } else {
      d.breakSlots = normSlots(draft.breakSlots);
      d.specialSlots = normSlots(draft.specialSlots);
    }

    // CSVの時刻をそのまま使っている下書きは、その時刻を保存してある
    if (draft.absolute && Array.isArray(draft.items) && draft.items.length) {
      d.absolute = true;
      // 特別の行は type: "custom" で保存されていたころの下書きがある
      d.items = draft.items.filter(it => it && typeof it === "object")
        .map(it => it.type === "custom" ? Object.assign({}, it, { type: "special" }) : it);
    } else {
      d.absolute = false;
      d.items = null;
    }
    return d;
  }

  /* 発表種別は「設定」タブの種別マスタが正なので、その内容を下書きの種別へ取り込む。
     sync=true  … 名称・時間もマスタで上書きし、マスタにも発表にも無い種別は落とす
     sync=false … マスタに無い種別（CSV由来など）はそのまま残し、足りない種別だけ足す
     マスタが空のときは判断材料が無いので、下書きの種別をそのまま返す。 */
  function mergeMasterTypes(talkTypes, master, talkList, sync) {
    if (!master || !master.length) return talkTypes;
    const cur = new Map(talkTypes.map(t => [t.id, t]));
    const used = new Set(talkList.map(e => e.typeId));
    const next = master.map(m => (!sync && cur.get(m.id)) || m);
    const inMaster = new Set(master.map(m => m.id));
    for (const t of talkTypes)
      if (!inMaster.has(t.id) && (!sync || used.has(t.id))) next.push(t);
    return next;
  }

  /* 参加登録の一覧を発表順（talkList）に変換する。種別マスタの発表／質疑時間をそのまま使い、
     マスタから消えた種別は登録に残っている名前で仮に作る。 */
  function entriesFromRegs(regs, master) {
    master = (master || []).slice();
    const byId = new Map(master.map(t => [t.id, t]));
    const orphanTypes = [], orphan = [], list = [];

    for (const r of regs) {
      let def = byId.get(r.typeId);
      if (!def) {
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
      list.push({
        id: uid(), typeId: def.id, title: r.title || "",
        speaker: String(r.speaker || "").trim(),
        affiliation: String(r.affiliation || "").trim()
      });
    }
    // マスタの種別はすべて残す（発表が0件の種別も設定タブの一覧と揃えるため）
    return { list, types: master.concat(orphanTypes), orphan };
  }

  /* 発表の並び（talkList）と固定枠から、表の行（items）を組み立てる。
     戻り値の talkList は、種別が無くなった発表を落としたもの。
     warnings は管理画面の通知欄に出す文言で、公開ページでは使わない。
     開始時刻が読めないときだけ error を返す（items は空）。 */
  function layout(opt, talkTypes, talkList) {
    const warnings = [];
    const start = toMin(opt.start);
    if (start == null)
      return { items: [], warnings, talkList,
               error: "開始時刻を正しく入力してください。" };

    // 発表種別
    const specById = new Map();
    talkTypes.forEach((t, i) => {
      specById.set(t.id, { id: t.id, name: t.name || `種別${i + 1}`, len: typeLen(t),
                           colorIdx: i, emphasis: !!t.emphasis });
    });

    // 種別が無くなった発表は落とす
    const list = talkList.filter(e => specById.has(e.typeId));

    // 発表＋質疑が0分の種別は時間を取れないので、表の下に一覧として出す
    const zero = new Map();
    for (const e of list) {
      const spec = specById.get(e.typeId);
      if (spec.len <= 0) zero.set(spec.name, (zero.get(spec.name) || 0) + 1);
    }
    for (const [name, n] of zero)
      warnings.push(`発表種別「${name}」は発表＋質疑が0分のため、${n}件をタイムテーブルには並べず、下の一覧に表示しました（時間を割り当てる場合は「設定」タブで指定できます）。`);

    if (!list.length)
      warnings.push("発表が0件です。「登録一覧から読み込む」か「CSVインポート」で読み込んでください。");

    // 固定枠（ランチ・休憩・特別）を集める
    let fixed = [];
    if (opt.lunchOn) {
      const ls = toMin(opt.lunchStart), le = toMin(opt.lunchEnd);
      if (ls != null && le != null && le > ls) fixed.push({ type: "lunch", start: ls, end: le, label: "ランチ" });
      else warnings.push("ランチの時刻が不正です（開始<終了で指定してください）。");
    }
    [["break", opt.breakSlots], ["special", opt.specialSlots]].forEach(([type, slots]) => {
      (slots || []).forEach(c => {
        const cs = toMin(c.start), ce = toMin(c.end);
        if (cs != null && ce != null && ce > cs) fixed.push({ type, start: cs, end: ce, label: c.label || "（無題）" });
        else if (c.start || c.end || c.label)
          warnings.push(`${KIND[type].label}「${c.label || "無題"}」の時刻が不正です。`);
      });
    });
    fixed.sort((a, b) => a.start - b.start || a.end - b.end);

    // 開始時刻より前に終わる固定枠は無視する
    const outside = fixed.filter(f => f.end <= start);
    if (outside.length) {
      fixed = fixed.filter(f => f.end > start);
      warnings.push(`開始時刻より前の枠（${outside.map(f => f.label).join("・")}）は配置しませんでした。`);
    }

    // 固定枠どうしの重複を知らせる
    for (let i = 1; i < fixed.length; i++) {
      if (fixed[i].start < fixed[i - 1].end)
        warnings.push(`固定枠が重複しています（${toStr(fixed[i - 1].start)}–${toStr(fixed[i - 1].end)} と ${toStr(fixed[i].start)}–${toStr(fixed[i].end)}）。`);
    }

    const out = [];
    let cursor = start;
    let li = 0;   // 発表リストの位置

    // to まで発表を並べる。to が null なら残りをすべて並べる
    function fill(to) {
      while (li < list.length) {
        const e = list[li];
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
      if (to != null && opt.showGap && to - cursor >= 1) out.push({ type: "gap", start: cursor, end: to });
    }

    for (const f of fixed) {
      if (f.start > cursor) fill(f.start);
      out.push(Object.assign({}, f));
      cursor = Math.max(cursor, f.end);
    }
    fill(null);   // 残りは最後の固定枠のあとに続けて並べる

    return { items: out, warnings, talkList: list, error: "" };
  }

  /* CSVの時刻をそのまま使っている状態（absolute）では時刻を振り直さないので、
     種別の名称・色・強調だけを talkTypes の内容に合わせる。 */
  function applyTypesToItems(items, talkTypes, talkList) {
    const byId = new Map(talkTypes.map((t, i) =>
      [t.id, { name: t.name || `種別${i + 1}`, i, emphasis: !!t.emphasis }]));
    for (const it of items) {
      if (it.type !== "talk") continue;
      const e = talkList.find(x => x.id === it.entryId);
      const t = e && byId.get(e.typeId);
      if (t) { it.typeName = t.name; it.colorIdx = t.i; it.emph = t.emphasis; }
    }
    return items;
  }

  /* 発表＋質疑が0分の種別（ポスター発表など）は時刻を持てずタイムテーブルに並べられないので、
     表の下に種別ごとの一覧として出す。その一覧のもとになる組を返す。 */
  function untimedGroups(talkTypes, talkList) {
    return talkTypes
      .map((t, i) => ({ t, i, list: talkList.filter(e => e.typeId === t.id) }))
      .filter(g => typeLen(g.t) <= 0 && g.list.length);
  }

  return {
    uid, toMin, toStr,
    TYPE_COLORS, typeColor, typeLen, KIND,
    joinSpeaker, splitSpeaker,
    blankDay, normalizeDayDraft, mergeMasterTypes, entriesFromRegs,
    layout, applyTypesToItems, untimedGroups
  };
})();
