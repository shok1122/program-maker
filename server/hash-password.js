#!/usr/bin/env node
"use strict";

/* 管理者パスワードのハッシュ値を作る（htpasswd 相当）。

     node server/hash-password.js                入力を2回求める（画面には表示しない）
     node server/hash-password.js <パスワード>   引数で渡す（シェルの履歴に残るので注意）
     echo -n <パスワード> | node server/hash-password.js

   標準出力に .env へ貼り付ける1行だけを出す。案内やプロンプトは標準エラーに出すので、
   `node server/hash-password.js >> .env` のように追記してもよい。 */

const password = require("./password.js");

const note = s => process.stderr.write(s + "\n");

function usage() {
  note("使い方: node server/hash-password.js [パスワード]");
  note("");
  note("  管理者パスワードのハッシュ値を作って、次の形式で1行出力します。");
  note("    ADMIN_PASSWORD_HASH=scrypt:...");
  note("  この1行を .env に置いてください（平文のパスワードは保存しません）。");
}

/* 端末なら画面に出さずに1行読む。パイプで渡されたときは全体をパスワードとして扱う。 */
function readSecret(prompt) {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    /* 端末が無いので伏せ字にできない。黙って待つと固まったように見えるため、必ず断りを出す。 */
    note("標準入力からパスワードを読み込みます（手で入力する場合は、入力後に Ctrl-D）。");
    return new Promise((resolve, reject) => {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", d => { buf += d; });
      stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
      stdin.on("error", reject);
    });
  }

  return new Promise(resolve => {
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";
    const done = result => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      resolve(result);
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(value);
        if (ch === "\u0003") { done(""); process.exit(130); return; }   // Ctrl-C
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        if (ch < " ") continue;
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) { usage(); return 0; }
  if (args.length > 1) { usage(); return 2; }

  let plain;
  if (args.length === 1) {
    plain = args[0];
  } else {
    plain = await readSecret("管理者パスワード: ");
    if (process.stdin.isTTY) {
      const again = await readSecret("もう一度入力: ");
      if (plain !== again) {
        note("2回の入力が一致しませんでした。");
        return 1;
      }
    }
  }

  const normalized = password.normalize(plain);
  if (!normalized) {
    note("パスワードが空です。");
    return 1;
  }
  if (normalized !== plain)
    note("注意: 前後の空白や制御文字は取り除いて扱います"
      + `（${password.MAX_PASSWORD}文字まで）。`);
  if (normalized.length < 8)
    note("注意: 8文字未満です。管理画面を公開する場合はもっと長いものにしてください。");

  process.stdout.write(`ADMIN_PASSWORD_HASH=${await password.hash(normalized)}\n`);
  note("");
  note("この1行を .env に置いて、コンテナを起動し直してください。");
  return 0;
}

main().then(code => { process.exitCode = code; }, err => {
  note("ハッシュ値を作れませんでした: " + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
