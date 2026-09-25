"use strict";
(function () {
  try {
    const parts = window.__LS_PARTS;
    if (!parts || !parts.length) throw new Error("app parts missing");
    const b64 = parts.join("");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const code = new TextDecoder().decode(bytes);
    (0, eval)(code);
  } catch (e) {
    console.error(e);
    const el = document.getElementById("log");
    if (el) el.textContent = "アプリの読み込みに失敗しました: " + (e && e.message ? e.message : e);
  }
})();
