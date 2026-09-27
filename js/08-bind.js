function bind() {
  $("btnLoad").addEventListener("click", () => ensureFfmpeg().catch(failCore));

  $("file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    state.file = f;
    state.inputPath = null;
    state.peak = null;
    state.silences = [];
    state.ranges = [];
    state.embeddedCover = null;
    state.audio = null;
    $("fileInfo").textContent = `${f.name}（${(f.size / 1048576).toFixed(1)} MB）`;
    player.src = URL.createObjectURL(f);
    $("outName").value = f.name.replace(/\.[^.]+$/, "") + "-joined.m4a";
    renderRanges();
    render();
    try {
      await ensureFfmpeg();
      await attachInput();
      await probe();
      await buildWaveform();
      await readTags();
      await detectSilences();
      pill("probeStatus", `解析: ${fmt(state.duration)} / ${state.info.audio || ""}`, "ok");
      renderRanges();
      render();
    } catch (err) {
      failCore(err);
    }
  });

  const xOf = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
  };
  const tOf = (px) => (px / canvas.getBoundingClientRect().width) * state.duration;

  canvas.addEventListener("pointerdown", (ev) => {
    if (!state.duration) return;
    canvas.setPointerCapture(ev.pointerId);
    state.drag = { x0: xOf(ev), x1: xOf(ev) };
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!state.drag) return;
    state.drag.x1 = xOf(ev);
    state.selection = { start: tOf(Math.min(state.drag.x0, state.drag.x1)), end: tOf(Math.max(state.drag.x0, state.drag.x1)) };
    render();
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!state.drag) return;
    const { x0, x1 } = state.drag;
    state.drag = null;
    if (Math.abs(x1 - x0) < 4) {
      state.selection = null;
      player.currentTime = snapTime(tOf(x0));
    } else {
      state.selection = snapRange(tOf(Math.min(x0, x1)), tOf(Math.max(x0, x1)));
    }
    render();
  });

  $("btnAddKeep").addEventListener("click", () => {
    if (!state.selection) return log("先に波形をドラッグして範囲を選んでください");
    const title = $("trackTitle").value.trim();
    addTrack(state.selection.start, state.selection.end, title);
    $("trackTitle").value = "";
    state.selection = null;
    render();
  });
  $("btnAddCut").addEventListener("click", () => {
    if (!state.selection) return log("先に波形をドラッグして範囲を選んでください");
    const cut = snapRange(state.selection.start, state.selection.end);
    state.ranges.push({ mode: "cut", start: cut.start, end: cut.end, title: "" });
    state.selection = null;
    renderRanges();
    render();
    saveLocal();
    log("カットは一覧と波形だけの印です。書き出しには使いません");
  });
  if ($("btnInvertCuts")) {
    $("btnInvertCuts").addEventListener("click", () => invertCutsToTracks());
  }
  $("btnClearSel").addEventListener("click", () => {
    state.selection = null;
    render();
  });
  $("btnClearAll").addEventListener("click", () => {
    state.ranges = [];
    renderRanges();
    render();
    saveLocal();
  });

  $("btnDetect").addEventListener("click", () => detectSilences());
  $("btnApplySilence").addEventListener("click", () => {
    if (!state.silences.length) return log("先に無音を検出してください");
    const pad = Math.max(0, Number($("silPad").value));
    let n = 0;
    for (const s of state.silences) {
      const rawA = s.start + pad;
      const rawB = s.end - pad;
      const cut = snapRange(rawA, rawB);
      if (cut.end - cut.start > 0.05) {
        state.ranges.push({ mode: "cut", start: cut.start, end: cut.end, title: "" });
        n++;
      }
    }
    log(`無音 ${n} 件をカットに追加しました。書き出しには使いません`);
    renderRanges();
    render();
    saveLocal();
  });

  $("ranges").addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.dataset.track != null) {
      const item = trackList()[Number(t.dataset.track)];
      if (!item) return;
      item.title = t.value;
      saveLocal();
    }
  });
  $("ranges").addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.dataset.start != null) applyTrackTime(Number(t.dataset.start), "start", t.value);
    if (t.dataset.end != null) applyTrackTime(Number(t.dataset.end), "end", t.value);
  });

  $("ranges").addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.dataset.playKeep != null) {
      playRange(trackList()[Number(t.dataset.playKeep)]);
    }
    if (t.dataset.delKeep != null) {
      const r = trackList()[Number(t.dataset.delKeep)];
      state.ranges.splice(state.ranges.indexOf(r), 1);
      renderRanges();
      render();
      saveLocal();
    }
    if (t.dataset.playCut != null) {
      const cuts = state.ranges.filter((r) => r.mode === "cut").sort((a, b) => a.start - b.start);
      playRange(cuts[Number(t.dataset.playCut)]);
    }
    if (t.dataset.delCut != null) {
      const cuts = state.ranges.filter((r) => r.mode === "cut").sort((a, b) => a.start - b.start);
      const r = cuts[Number(t.dataset.delCut)];
      state.ranges.splice(state.ranges.indexOf(r), 1);
      renderRanges();
      render();
      saveLocal();
    }
  });

  $("btnReadTags").addEventListener("click", () => readTags().catch((e) => log("エラー: " + e.message)));
  $("cover").addEventListener("change", (e) => {
    const f = e.target.files[0];
    state.cover = f || null;
    $("coverInfo").textContent = f ? `${f.name}（${(f.size / 1024).toFixed(0)} KB）` : "未選択";
    $("coverPreview").innerHTML = f ? `<img src="${URL.createObjectURL(f)}" alt="cover">` : "";
  });
  $("btnClearCover").addEventListener("click", () => {
    state.cover = null;
    $("cover").value = "";
    $("coverInfo").textContent = "未選択";
    $("coverPreview").innerHTML = "";
  });

  $("btnRun").addEventListener("click", () => run().catch((e) => log("エラー: " + (e && e.message ? e.message : e))));
  $("btnCancel").addEventListener("click", () => {
    if (state.abort) {
      try { state.abort.abort(); } catch (_) {}
    }
    if (!state.ffmpeg) return;
    log("処理を中断しました。core は保持しているので再読み込みは短く済みます");
    try { state.ffmpeg.terminate(); } catch (_) {}
    state.ready = false;
    state.inputPath = null;
    state.mounted = false;
    state.embeddedCover = null;
    state.running = false;
    state.abort = null;
    $("btnRun").disabled = false;
    $("btnCancel").disabled = true;
    pill("coreStatus", "ffmpeg-core: 停止（core 保持）", "warn");
  });

  $("btnSaveJson").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(editJson(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.file ? state.file.name.replace(/\.[^.]+$/, "") : "live-splicer") + ".json";
    a.click();
  });
  $("jsonFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      applyJson(JSON.parse(await f.text()));
    } catch (err) {
      log("エラー: " + err.message);
    }
  });
  $("btnRestore").addEventListener("click", () => {
    try {
      const raw = localStorage.getItem(CONFIG.storageKey);
      if (!raw) throw new Error("自動保存されたデータがありません");
      applyJson(JSON.parse(raw));
    } catch (e) {
      log("エラー: " + e.message);
    }
  });

  ["silThr", "silMin", "silPad"].forEach((id) => $(id).addEventListener("change", () => detectSilences()));
  player.addEventListener("timeupdate", render);
  window.addEventListener("resize", render);
  document.addEventListener("input", (e) => {
    if (e.target.closest(".card")) saveLocal();
  });
}

bind();
renderRanges();
render();
log("準備完了。音源を選ぶと解析が始まります");
