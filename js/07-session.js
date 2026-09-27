function editJson() {
  return {
    app: "live-splicer",
    version: 2,
    source: { name: state.file ? state.file.name : null, size: state.file ? state.file.size : null, duration: state.duration },
    ranges: state.ranges,
    settings: {
      output: document.querySelector('input[name="output"]:checked').value,
      bitrate: Number($("bitrate").value),
      crossfadeMs: Number($("xfade").value),
      useCrossfade: $("xuse").checked,
      outName: $("outName").value,
      silThr: Number($("silThr").value),
      silMin: Number($("silMin").value),
      silPad: Number($("silPad").value),
    },
    meta: Object.fromEntries([...document.querySelectorAll("[data-tag]")].map((el) => [el.dataset.tag, el.value])),
  };
}

function applyJson(o) {
  if (!o || o.app !== "live-splicer") throw new Error("このアプリの JSON ではありません");
  state.ranges = (o.ranges || []).map((r) => ({
    mode: r.mode,
    start: Number(r.start),
    end: Number(r.end),
    title: r.title || "",
  }));
  snapAllRanges("JSON");
  const s = o.settings || {};
  if (s.output) document.querySelector(`input[name="output"][value="${s.output}"]`).checked = true;
  if (s.bitrate) $("bitrate").value = String(s.bitrate);
  if (s.crossfadeMs != null) $("xfade").value = String(s.crossfadeMs);
  if (s.useCrossfade != null) $("xuse").checked = !!s.useCrossfade;
  if (s.outName) $("outName").value = s.outName;
  if (s.silThr != null) $("silThr").value = String(s.silThr);
  if (s.silMin != null) $("silMin").value = String(s.silMin);
  if (s.silPad != null) $("silPad").value = String(s.silPad);
  for (const [k, v] of Object.entries(o.meta || {})) {
    const el = document.querySelector(`[data-tag="${k}"]`);
    if (el) el.value = v || "";
  }
  renderRanges();
  render();
  log(`JSON を読み込みました（${trackList().length} 曲）`);
}

function saveLocal() {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(editJson()));
    $("jsonInfo").textContent = "自動保存済み " + new Date().toLocaleTimeString();
  } catch (e) {
    /* quota */
  }
}
