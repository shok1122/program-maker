"use strict";

/* 参加登録データの永続化。
   依存関係を持たないよう JSON ファイル1つに保存する。
   書き込みは tmp → rename の原子的置換で行い、直前の状態を .bak に残す。
   すべての更新は mutate() のキューを通るので、並行リクエストでも壊れない。 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const VERSION = 1;

const DEFAULT_TYPES = [
  { name: "一般講演", talk: 12, qa: 3 },
  { name: "学生講演", talk: 10, qa: 5 },
  { name: "招待講演", talk: 30, qa: 10 },
  { name: "ポスター発表", talk: 3, qa: 0 }
];

function defaultData(seed) {
  seed = seed || {};
  return {
    version: VERSION,
    settings: {
      eventName: seed.eventName || "研究発表会",
      notice: "",
      registrationOpen: true,
      registrationKey: seed.registrationKey || "",
      types: DEFAULT_TYPES.map(t => Object.assign({ id: randomUUID() }, t))
    },
    registrations: [],
    timetable: null
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
    timetable: data.timetable && typeof data.timetable === "object" ? data.timetable : null
  };
}

class Store {
  constructor(dataDir, seed) {
    this.dir = path.resolve(dataDir);
    this.file = path.join(this.dir, "registrations.json");
    this.seed = seed || {};
    this.data = null;
    this._queue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    let raw = null;
    try {
      raw = await fsp.readFile(this.file, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    if (raw == null) {
      this.data = defaultData(this.seed);
      await this._write();
      return { created: true };
    }

    try {
      this.data = migrate(JSON.parse(raw), this.seed);
    } catch (err) {
      // 壊れたファイルは捨てずに退避してから初期化する
      const broken = this.file + ".broken-" + Date.now();
      await fsp.rename(this.file, broken).catch(() => {});
      this.data = defaultData(this.seed);
      await this._write();
      return { created: true, recoveredFrom: broken };
    }
    await this._write();   // migrate 結果を書き戻す
    return { created: false };
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
