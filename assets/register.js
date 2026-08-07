"use strict";

/* 参加登録ページ。TM（assets/api.js）を通してサーバー or デモに登録する。 */

(function () {

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s)
    .replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const FIELDS = ["type", "title", "speaker", "affiliation", "key"];
  let config = null;

  function notice(msg, kind) {
    const n = $("#notice");
    if (!msg) { n.className = "notice"; n.innerHTML = ""; return; }
    const icon = kind === "ok" ? "✓" : kind === "err" ? "✕" : "！";
    n.className = "notice show " + (kind || "info");
    n.innerHTML = `<span style="font-weight:700">${icon}</span><div class="grow">${esc(msg)}</div>`;
  }

  function clearErrors() {
    for (const f of FIELDS) {
      const box = $("#e-" + f);
      if (box) { box.className = "field-err"; box.textContent = ""; }
      const input = $("#f-" + f);
      if (input) input.classList.remove("bad");
    }
  }
  function fieldError(name, msg) {
    const box = $("#e-" + name), input = $("#f-" + name);
    if (box) { box.className = "field-err show"; box.textContent = msg; }
    if (input) { input.classList.add("bad"); input.focus(); }
  }

  /* サーバーのエラーメッセージを、対応する入力欄の下に出す */
  function placeError(message) {
    const map = [
      ["種別", "type"], ["タイトル", "title"], ["発表者", "speaker"],
      ["所属", "affiliation"], ["参加登録キー", "key"]
    ];
    for (const [word, name] of map) {
      if (message.indexOf(word) === 0) { fieldError(name, message); return true; }
    }
    return false;
  }

  function renderTypes() {
    const sel = $("#f-type");
    sel.innerHTML = `<option value="">選択してください</option>` +
      config.types.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
    const withLen = config.types.filter(t => (t.talk || 0) + (t.qa || 0) > 0);
    $("#type-hint").textContent = withLen.length
      ? "持ち時間：" + withLen.map(t => `${t.name} ${t.talk + t.qa}分（発表${t.talk}分＋質疑${t.qa}分）`).join(" / ")
      : "";
  }

  function applyConfig() {
    document.title = config.eventName + " 発表申込";
    $("#event-name").textContent = config.eventName;
    // タイムテーブルを公開しているあいだは、プログラムへの導線も出す
    $("#program-link").hidden = !config.timetablePublic;

    if (config.notice) {
      $("#event-notice").textContent = config.notice;
      $("#notice-panel").hidden = false;
    } else {
      $("#notice-panel").hidden = true;
    }

    $("#loading").hidden = true;
    $("#key-field").hidden = !config.keyRequired;
    $("#f-key").required = !!config.keyRequired;

    if (!config.registrationOpen) {
      $("#form").hidden = true;
      $("#done").hidden = true;
      $("#form-tail").textContent = "受付終了";
      notice("現在、参加登録を受け付けていません。受付期間については主催者にお問い合わせください。", "warn");
      return;
    }
    if (!config.types.length) {
      $("#form").hidden = true;
      notice("発表種別が設定されていないため、まだ登録できません。主催者にお問い合わせください。", "warn");
      return;
    }

    $("#form-tail").textContent = "受付中";
    renderTypes();
    $("#form").hidden = false;
  }

  async function submit(e) {
    e.preventDefault();
    clearErrors();
    notice("");

    const input = {
      typeId: $("#f-type").value,
      title: $("#f-title").value,
      speaker: $("#f-speaker").value,
      affiliation: $("#f-affiliation").value,
      key: config.keyRequired ? $("#f-key").value : ""
    };

    if (!input.typeId) return fieldError("type", "種別を選択してください。");
    if (!input.title.trim()) return fieldError("title", "タイトルを入力してください。");
    if (!input.speaker.trim()) return fieldError("speaker", "発表者を入力してください。");
    if (!input.affiliation.trim()) return fieldError("affiliation", "所属を入力してください。");
    if (config.keyRequired && !input.key) return fieldError("key", "参加登録キーを入力してください。");

    const btn = $("#submit");
    btn.disabled = true;
    btn.textContent = "登録中…";
    try {
      const res = await TM.register(input);
      const type = config.types.find(t => t.id === input.typeId);
      $("#done-id").textContent = String(res.id || "").slice(0, 8);
      $("#r-type").textContent = type ? type.name : "";
      $("#r-title").textContent = input.title.trim();
      $("#r-speaker").textContent = input.speaker.trim();
      $("#r-affiliation").textContent = input.affiliation.trim();
      $("#form").hidden = true;
      $("#done").hidden = false;
      $("#again").focus();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      const msg = err.message || "登録できませんでした。";
      if (!placeError(msg)) notice(msg, "err");
      if (err.status === 409) {
        // 受付が締め切られた直後。画面の状態を最新に合わせる
        try { config = await TM.getConfig(); applyConfig(); } catch (_) { /* 表示はそのまま */ }
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "この内容で登録する";
    }
  }

  function again() {
    // 種別と所属は続けて登録するときに使い回せることが多いので残す
    $("#f-title").value = "";
    $("#f-speaker").value = "";
    clearErrors();
    notice("");
    $("#done").hidden = true;
    $("#form").hidden = false;
    $("#f-title").focus();
  }

  async function boot() {
    try {
      config = await TM.init();
    } catch (err) {
      $("#loading").hidden = true;
      notice(err.message || "設定を読み込めませんでした。", "err");
      return;
    }
    if (TM.isDemo()) $("#demo-bar").classList.add("show");
    applyConfig();
  }

  $("#form").addEventListener("submit", submit);
  $("#again").addEventListener("click", again);
  $("#demo-reset").addEventListener("click", async () => {
    if (!confirm("デモデータを初期状態に戻します。よろしいですか？")) return;
    await TM.resetDemo();
    location.reload();
  });

  boot();
})();
