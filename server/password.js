"use strict";

/* 管理者パスワードのハッシュ。
   .htpasswd と同じく、設定に置くのは平文ではなくハッシュ値1行だけにする。
   npm 依存を増やさないので、Node 標準の scrypt（ソルト付き・伸長あり）を使う。

   形式（PHC string format にならった1行。ハッシュを作るのは hash-password.js）
     scrypt:ln=14,r=8,p=1:<salt>:<hash>          salt / hash は base64url
     ln は N の対数（N = 2^ln）。

   区切りに $ を使わないのは、この値を .env に書くため。
   docker compose の .env は値の中の $ を変数として展開してしまう。 */

const { scrypt, randomBytes, timingSafeEqual } = require("node:crypto");

const SCHEME = "scrypt";
const PARAMS = { ln: 14, r: 8, p: 1 };   /* 約16MB・数十ミリ秒。ログインは絞ってあるので十分 */
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_LN = 17;                       /* 設定ミスで起動やログインが固まらないための上限 */
const MAX_PASSWORD = 200;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const b64 = buf => buf.toString("base64url");
const inRange = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

/* ログインの入力と、ハッシュを作るときの入力を必ず同じ形に揃える。
   （サーバーの他の1行入力と同じ正規化。制御文字を落とし、連続する空白をまとめる） */
function normalize(v) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_PASSWORD);
}

function derive(plain, salt, { ln, r, p }, keyLen) {
  return new Promise((resolve, reject) => {
    const N = 2 ** ln;
    scrypt(plain, salt, keyLen, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key));
  });
}

/* 保存用の1行を作る。 */
async function hash(plain) {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(normalize(plain), salt, PARAMS, KEY_BYTES);
  return `${SCHEME}:ln=${PARAMS.ln},r=${PARAMS.r},p=${PARAMS.p}:${b64(salt)}:${b64(key)}`;
}

/* 壊れている・知らない形式なら null。 */
function parse(stored) {
  const parts = String(stored == null ? "" : stored).trim().split(":");
  if (parts.length !== 4 || parts[0] !== SCHEME) return null;

  const params = {};
  for (const kv of parts[1].split(",")) {
    const i = kv.indexOf("=");
    if (i < 0) return null;
    params[kv.slice(0, i)] = Number(kv.slice(i + 1));
  }
  const { ln, r, p } = params;
  if (!inRange(ln, 1, MAX_LN) || !inRange(r, 1, 32) || !inRange(p, 1, 16)) return null;

  if (!B64URL_RE.test(parts[2]) || !B64URL_RE.test(parts[3])) return null;
  const salt = Buffer.from(parts[2], "base64url");
  const key = Buffer.from(parts[3], "base64url");
  if (salt.length < 8 || key.length < 16 || key.length > 64) return null;

  return { ln, r, p, salt, key };
}

const isHash = stored => parse(stored) !== null;

/* 定数時間で照合する。形式が不正なら常に false。 */
async function verify(plain, stored) {
  const rec = parse(stored);
  if (!rec) return false;
  try {
    const key = await derive(normalize(plain), rec.salt, rec, rec.key.length);
    return timingSafeEqual(key, rec.key);
  } catch (_) {
    return false;
  }
}

module.exports = { hash, verify, isHash, normalize, MAX_PASSWORD };
