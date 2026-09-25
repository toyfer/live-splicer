"use strict";
(async function () {
  try {
    const names = ["app-p1.js", "app-p2.js", "app-p3.js"];
    let code = "";
    for (const name of names) {
      const res = await fetch("./" + name + "?v=10");
      if (!res.ok) throw new Error(name + " " + res.status);
      code += await res.text();
    }
    (0, eval)(code);
  } catch (e) {
    console.error(e);
    const el = document.getElementById("log");
    if (el) el.textContent = "アプリの読み込みに失敗しました: " + (e && e.message ? e.message : e);
  }
})();
