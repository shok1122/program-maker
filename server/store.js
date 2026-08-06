"use strict";

/* 参加登録データの永続化。
   依存関係を持たないよう JSON ファイル1つに保存する。
   書き込みは tmp → rename の原子的置換で行い、直前の状態を .bak に残す。
   すべての更新は mutate() のキューを通るので、並行リクエストでも壊れない。 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { randomUUID } = crypto;

const VERSION = 1;
const TYPE_NAME_MAX = 60;

/* 種別定義ファイル。無ければ下の DEFAULT_TYPES を使う。 */
const TYPES_FILE = path.resolve(
  process.env.TYPES_FILE || path.join(__dirname, "..", "config", "types.json"));

const DEFAULT_TYPES = [
  { name: "一般講演", talk: 12, qa: 3 },
  { name: "学生講演", talk: 10, qa: 5 },
  { name: "招待講演", talk: 30, qa: 10 },
  { name: "ポスター発表", talk: 3, qa: 0 }
];

/* id を書かずに済むよう、名称から決まる安定した id を作る。
   再起動しても変わらないので、既存の登録との対応が保たれる。 */
const idFromName = name =>
  "t-" + crypto.createHash("sha1").update(name).digest("hex").slice(0, 16);

function normalizeTypes(list) {
  const seen = new Set();
  const out = [];
  list.forEach((t, i) => {
    if (!t || typeof t !== "object") return;
    const name = String(t.name == null ? "" : t.name)
      .replace(/\s+/g, " ").trim().slice(0, TYPE_NAME_MAX) || `種別${i + 1}`;
    let id = typeof t.id === "string" && /^[\w-]{1,64}$/.test(t.id) ? t.id : idFromName(name);
    if (seen.has(id)) id = `${id}-${i + 1}`;      // 同名が並んでいた場合
    seen.add(id);
    out.push({
      id, name,
      talk: Number.isFinite(+t.talk) ? Math.min(600, Math.max(0, Math.round(+t.talk))) : 0,
      qa: Number.isFinite(+t.qa) ? Math.min(600, Math.max(0, Math.round(+t.qa))) : 0
    });
  });
  return out;
}

/* config/types.json を読む。読めない・壊れている・空の場合は null を返し、
   呼び出し側は組み込みの既定値（または保存済みの内容）をそのまま使う。 */
function readTypesFile(file) {
  const give = reason => {
    console.warn(`[program-maker] ${file} ${reason} 種別の定義は変更しません。`);
    return null;
  };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;      // 未設置は正常
    return give(`を読み込めませんでした（${err.message}）。`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return give("のJSONが不正です。");
  }

  const list = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray(parsed.types) ? parsed.types : null);
  if (!list) return give("に types の配列がありません。");

  const types = normalizeTypes(list);
  if (!types.length) return give("に種別が1つもありません。");

  return { types, fingerprint: crypto.createHash("sha256")
    .update(JSON.stringify(types)).digest("hex").slice(0, 32) };
}

function defaultData(seed) {
  seed = seed || {};
  return {
    version: VERSION,
    settings: {
      eventName: seed.eventName || "研究発表会",
      notice: "",
      registrationOpen: true,
      registrationKey: seed.registrationKey || "",
      types: normalizeTypes(DEFAULT_TYPES)
    },
    registrations: [],
    timetable: null,
    typesFingerprint: null
  };
}

/* 読み込んだデータに欠けているフィールドを補う（将来のフィールド追加に備える） */
function migrate(data, seed) {
  const base = defaultData(seed);
  if (!data || typeof data !== "object") return base;

  const s = data.settings && typeof data.settings === "object" ? data.settings : {};
  const types = Array.isArray(s.types) ? s.types.filter(t => t && typeof t === "object") : null;

  return {
    version: VERSION,
    settings: {
      eventName: typeof s.eventName === "string" ? s.eventName : base.settings.eventName,
      notice: typeof s.notice === "string" ? s.notice : "",
      registrationOpen: s.registrationOpen !== false,
      registrationKey: typeof s.registrationKey === "string" ? s.registrationKey : "",
      types: types && types.length
        ? types.map(t => ({
            id: typeof t.id === "string" && t.id ? t.id : randomUUID(),
            name: String(t.name == null ? "" : t.name),
            talk: Number.isFinite(+t.talk) ? Math.max(0, Math.round(+t.talk)) : 0,
            qa: Number.isFinite(+t.qa) ? Math.max(0, Math.round(+t.qa)) : 0
          }))
        : base.settings.types
    },
    registrations: Array.isArray(data.registrations)
      ? data.registrations.filter(r => r && typeof r === "object")
      : [],
    timetable: data.timetable && typeof data.timetable === "object" ? data.timetable : null,
    typesFingerprint: typeof data.typesFingerprint === "string" ? data.typesFingerprint : null
  };
}

class Store {
  constructor(dataDir, seed) {
    this.dir = path.resolve(dataDir);
    this.file = path.join(this.dir, "registrations.json");
    this.typesFile = TYPES_FILE;
    this.seed = seed || {};
    this.data = null;
    this._queue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    const fromFile = readTypesFile(this.typesFile);
    let raw = null;
    try {
      raw = await fsp.readFile(this.file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    if (raw == null) {
      this.data = defaultData(this.seed);
      this._applyTypesFile(fromFile);
      await this._write();
      return { created: true, typesFile: fromFile ? this.typesFile : null };
    }

    let recoveredFrom = null;
    try {
      this.data = migrate(JSON.parse(raw), this.seed);
    } catch (err) {
      // 壊れたファイルは捨てずに退避してから初期化する
      recoveredFrom = this.file + ".broken-" + Date.now();
      await fsp.rename(this.file, recoveredFrom).catch(() => {});
      this.data = defaultData(this.seed);
    }
    const typesUpdated = this._applyTypesFile(fromFile);
    await this._write();   // migrate 結果を書き戻す
    return {
      created: !!recoveredFrom, recoveredFrom,
      typesFile: fromFile ? this.typesFile : null,
      typesUpdated
    };
  }

  /* 種別定義ファイルの内容を反映する。前回反映した内容から変わっていなければ何もしないので、
     管理画面で種別を編集していても、ファイルを触らないかぎり再起動で戻ることはない。 */
  _applyTypesFile(fromFile) {
    if (!fromFile) return false;
    if (this.data.typesFingerprint === fromFile.fingerprint) return false;

    this.data.settings.types = fromFile.types.map(t => Object.assign({}, t));
    this.data.typesFingerprint = fromFile.fingerprint;
    // 種別名を変えたら既存の登録の表示名も追随させる（管理画面の設定保存と同じ扱い）
    const byId = new Map(fromFile.types.map(t => [t.id, t]));
    for (const r of this.data.registrations) {
      const t = byId.get(r.typeId);
      if (t) r.typeName = t.name;
    }
    return true;
  }

  /* データを読み書きする唯一の入口。fn は同期的に this.data を書き換えてよい。
     fn の戻り値がそのまま mutate() の解決値になる。fn が投げた場合は保存しない。 */
  mutate(fn) {
    const run = async () => {
      const before = JSON.stringify(this.data);
      let result;
      try {
        result = fn(this.data);
      } catch (err) {
        this.data = JSON.parse(before);   // 途中まで書き換えていても巻き戻す
        throw err;
      }
      if (JSON.stringify(this.data) !== before) await this._write();
      return result;
    };
    // 失敗しても後続が止まらないようにキューを繋ぐ
    const next = this._queue.then(run, run);
    this._queue = next.then(() => {}, () => {});
    return next;
  }

  async _write() {
    const tmp = this.file + ".tmp";
    const body = JSON.stringify(this.data, null, 2);
    const fh = await fsp.open(tmp, "w");
    try {
      await fh.writeFile(body, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (fs.existsSync(this.file)) await fsp.copyFile(this.file, this.file + ".bak").catch(() => {});
    await fsp.rename(tmp, this.file);
  }
}

module.exports = { Store, VERSION };
