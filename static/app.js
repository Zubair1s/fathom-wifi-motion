(() => {
  "use strict";

  const WINDOW_SECONDS = 60;
  const KEEP_SECONDS = 90;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ state
  const S = {
    samples: [],            // {t, rssi, std, score, motion}
    offset: null,           // client clock - server clock (s)
    baseline: null,
    calibratedAt: null,
    sensitivity: 0.6,
    threshold: null,
    motion: false,
    since: null,
    calibrating: false,
    calSeconds: 10,
    link: null,
    online: false,
    lastMsg: 0,
    events: [],
    view: null,             // current state word key
    score: 0,
  };

  const now = () => Date.now() / 1000 - (S.offset || 0);

  // ------------------------------------------------------------------ colours
  let C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    C = {
      ink: v("--ink"), muted: v("--muted"), faint: v("--faint"),
      line: v("--line"), lineStrong: v("--line-strong"),
      accent: v("--accent"), accentSoft: v("--accent-soft"), surface: v("--surface"),
    };
  }
  readColors();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readColors);

  // ------------------------------------------------------------------ state word
  const WORDS = {
    listening: { text: "Listening.", desc: "Waiting for the first readings from your WiFi adapter." },
    still: { text: "Still.", desc: "The signal is steady. Nothing is crossing the path between this PC and your router." },
    motion: { text: "Movement.", desc: "The signal is being disturbed. Someone is moving near the path to your router.", cls: "motion" },
    calibrating: { text: "Hold still.", desc: "Measuring how much the signal wobbles on its own when nobody moves." },
    offline: { text: "No signal.", desc: "Can't read the WiFi signal. Make sure WiFi is connected and Location services are on." },
  };

  // One word at a time: the old word fully leaves before the new one enters,
  // and any change requested mid-transition waits its turn.
  let wordBusy = false, wordPending = null;
  function setView(key) {
    if (wordBusy) { wordPending = key; return; }
    if (S.view === key) return;
    S.view = key;
    wordBusy = true;

    const def = WORDS[key];
    const host = $("state-word");
    const old = host.querySelector(".word");

    const enter = () => {
      const word = document.createElement("span");
      word.className = "word" + (def.cls ? " " + def.cls : "");
      [...def.text].forEach((ch, i) => {
        const s = document.createElement("span");
        s.textContent = ch === " " ? " " : ch;
        s.style.setProperty("--i", i);
        word.appendChild(s);
      });
      host.appendChild(word);
      void word.offsetWidth;
      word.classList.add("is-in");
      setTimeout(() => {
        wordBusy = false;
        const next = wordPending; wordPending = null;
        if (next && next !== S.view) setView(next);
      }, 650);
    };

    if (old) {
      old.classList.remove("is-in");
      old.classList.add("is-out");
      setTimeout(() => { old.remove(); enter(); }, 380);
    } else {
      enter();
    }

    const desc = $("state-desc");
    desc.classList.add("is-hidden");
    setTimeout(() => { desc.textContent = def.desc; desc.classList.remove("is-hidden"); }, 300);

    document.body.classList.toggle("is-motion", key === "motion");
    document.title = key === "motion" ? "Movement · Fathom" : "Fathom";
  }

  function refreshView() {
    if (!S.online) return setView(S.samples.length || S.lastMsg ? "offline" : "listening");
    if (S.calibrating) return setView("calibrating");
    setView(S.motion ? "motion" : "still");
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }
  const fmtClock = (t) => new Date((t + (S.offset || 0)) * 1000)
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  // ------------------------------------------------------------------ tweened numbers
  const tweens = {};
  function tweenTo(id, value, decimals) {
    const t = tweens[id] || (tweens[id] = { el: $(id), cur: value, target: value, d: decimals });
    if (t.cur == null || t.target == null) t.cur = value;
    t.target = value; t.d = decimals;
  }
  function stepTweens() {
    for (const k in tweens) {
      const t = tweens[k];
      if (t.target == null) { t.el.textContent = "—"; continue; }
      t.cur += (t.target - t.cur) * 0.18;
      if (Math.abs(t.target - t.cur) < Math.pow(10, -t.d) / 2) t.cur = t.target;
      const txt = t.cur.toFixed(t.d).replace("-", "−");
      if (t.el.textContent !== txt) t.el.textContent = txt;
    }
  }

  // ------------------------------------------------------------------ canvas helpers
  function setupCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function smoothLine(ctx, pts) {
    if (!pts.length) return;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    if (pts.length > 1) ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  }

  const range = { lo: -75, hi: -55 };

  function drawRssi(tNow) {
    const { ctx, w, h } = setupCanvas($("chart-rssi"));
    const padL = 44, padR = 14, padT = 10, padB = 24;
    const pw = w - padL - padR, ph = h - padT - padB;
    const t0 = tNow - WINDOW_SECONDS;
    const vis = S.samples.filter((s) => s.t >= t0 - 2);
    const xOf = (t) => padL + ((t - t0) / WINDOW_SECONDS) * pw;

    // animated y-range
    if (vis.length) {
      let lo = Math.min(...vis.map((s) => s.rssi)), hi = Math.max(...vis.map((s) => s.rssi));
      lo = Math.floor((lo - 3) / 5) * 5; hi = Math.ceil((hi + 3) / 5) * 5;
      if (hi - lo < 15) { const mid = (hi + lo) / 2; lo = Math.floor((mid - 7.5) / 5) * 5; hi = lo + 15; }
      range.lo += (lo - range.lo) * 0.08; range.hi += (hi - range.hi) * 0.08;
      if (Math.abs(lo - range.lo) < 0.05) range.lo = lo;
      if (Math.abs(hi - range.hi) < 0.05) range.hi = hi;
    }
    const yOf = (v) => padT + (1 - (v - range.lo) / (range.hi - range.lo)) * ph;

    // grid + labels
    ctx.font = "11px 'DM Mono', monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let v = Math.ceil(range.lo / 5) * 5; v <= range.hi; v += 5) {
      const y = Math.round(yOf(v)) + 0.5;
      if (y < padT - 1 || y > padT + ph + 1) continue;
      ctx.strokeStyle = C.line; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.fillText(String(v).replace("-", "−"), padL - 10, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    for (let s = 0; s <= WINDOW_SECONDS; s += 15) {
      const x = padL + pw - (s / WINDOW_SECONDS) * pw;
      ctx.fillStyle = C.faint;
      ctx.fillText(s === 0 ? "now" : `−${s}s`, Math.min(Math.max(x, padL + 14), w - padR - 14), h - 4);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(padL, 0, pw, h); ctx.clip();

    // motion bands
    let start = null;
    const flush = (end) => {
      const x1 = xOf(start), x2 = xOf(end);
      ctx.fillStyle = C.accentSoft;
      ctx.fillRect(x1, padT, x2 - x1, ph);
      ctx.fillStyle = C.accent;
      ctx.fillRect(x1, padT, x2 - x1, 2);
    };
    vis.forEach((s, i) => {
      if (s.motion && start === null) start = s.t;
      if (!s.motion && start !== null) { flush(s.t); start = null; }
      if (i === vis.length - 1 && start !== null) flush(s.t);
    });

    if (vis.length > 1) {
      const pts = vis.map((s) => [xOf(s.t), yOf(s.rssi)]);
      // soft fill
      const g = ctx.createLinearGradient(0, padT, 0, padT + ph);
      g.addColorStop(0, hexA(C.ink, 0.09)); g.addColorStop(1, hexA(C.ink, 0));
      ctx.beginPath(); smoothLine(ctx, pts);
      ctx.lineTo(pts[pts.length - 1][0], padT + ph); ctx.lineTo(pts[0][0], padT + ph); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      // line
      ctx.beginPath(); smoothLine(ctx, pts);
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.stroke();
    }
    ctx.restore();
  }

  function drawScore(tNow) {
    const { ctx, w, h } = setupCanvas($("chart-score"));
    const padL = 44, padR = 14, padT = 6, padB = 6;
    const pw = w - padL - padR, ph = h - padT - padB;
    const t0 = tNow - WINDOW_SECONDS;
    const MAX = 2.2;
    const xOf = (t) => padL + ((t - t0) / WINDOW_SECONDS) * pw;
    const yOf = (v) => padT + (1 - Math.min(v, MAX) / MAX) * ph;
    const yThr = Math.round(yOf(1)) + 0.5;

    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, padT + ph + 0.5); ctx.lineTo(w - padR, padT + ph + 0.5); ctx.stroke();

    ctx.font = "11px 'DM Mono', monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillStyle = C.muted; ctx.fillText("100%", padL - 10, yThr);

    const vis = S.samples.filter((s) => s.t >= t0 - 2);
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, 0, pw, h); ctx.clip();
    if (vis.length > 1) {
      const pts = vis.map((s) => [xOf(s.t), yOf(s.score)]);
      const area = () => {
        ctx.beginPath(); smoothLine(ctx, pts);
        ctx.lineTo(pts[pts.length - 1][0], padT + ph); ctx.lineTo(pts[0][0], padT + ph); ctx.closePath();
      };
      area(); ctx.fillStyle = hexA(C.ink, 0.07); ctx.fill();
      ctx.beginPath(); smoothLine(ctx, pts); ctx.strokeStyle = C.ink; ctx.lineWidth = 1.3; ctx.stroke();
      // above the trigger line, repaint in accent
      ctx.save();
      ctx.beginPath(); ctx.rect(padL, 0, pw, yThr); ctx.clip();
      area(); ctx.fillStyle = C.accentSoft; ctx.fill();
      ctx.beginPath(); smoothLine(ctx, pts); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    ctx.setLineDash([4, 4]); ctx.strokeStyle = C.muted; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, yThr); ctx.lineTo(w - padR, yThr); ctx.stroke();
    ctx.setLineDash([]);
  }

  function hexA(color, a) {
    const c = color.replace("#", "");
    if (c.length !== 6) return color;
    const n = parseInt(c, 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // ------------------------------------------------------------------ path wave
  const wave = { amp: 4, phase: 0, turb: 0 };
  function drawWave(dt) {
    const sc = S.online ? Math.min(S.score, 2.5) : 0;
    const targetAmp = S.online ? 3 + sc * 26 : 0.5;
    wave.amp += (targetAmp - wave.amp) * Math.min(1, dt * 4);
    wave.turb += ((S.motion ? 1 : sc * 0.4) - wave.turb) * Math.min(1, dt * 3);
    wave.phase += dt * (1.6 + sc * 5);

    const x0 = 48, x1 = 432, cy = 110;
    const build = (lag, ampMul) => {
      let d = "";
      for (let x = x0; x <= x1; x += 4) {
        const u = (x - x0) / (x1 - x0);
        const env = Math.sin(Math.PI * u);
        const p = wave.phase - lag;
        const y = cy + wave.amp * ampMul * env * (
          Math.sin(u * 14 - p) * (1 - wave.turb * 0.45) +
          Math.sin(u * 31 + p * 1.7) * 0.35 * wave.turb +
          Math.sin(u * 53 - p * 2.3) * 0.2 * wave.turb
        );
        d += (d ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      }
      return d;
    };
    $("wave").setAttribute("d", build(0, 1));
    $("wave-ghost").setAttribute("d", build(0.9, 0.6));
  }

  // ------------------------------------------------------------------ panels
  function renderLink() {
    const el = $("link"), txt = $("link-text");
    el.classList.toggle("is-live", S.online);
    el.classList.toggle("is-lost", !S.online && S.lastMsg > 0);
    if (S.online && S.link) {
      const parts = ["Live", S.link.ssid, S.link.band, S.link.channel && `ch ${S.link.channel}`].filter(Boolean);
      txt.textContent = parts.join(" · ");
      $("cap-adapter").textContent = shortAdapter(S.link.adapter);
      $("cap-router").textContent = [S.link.ssid, S.link.channel && `ch ${S.link.channel}`].filter(Boolean).join(" · ");
      $("foot-adapter").textContent = S.link.adapter || "";
    } else {
      txt.textContent = S.lastMsg ? "Signal lost" : "Connecting…";
    }
  }
  const shortAdapter = (a) => (a || "—").replace(/\b(WiFi 6E?|PCI-?E|NIC|Wireless|Network|Adapter)\b/gi, "").replace(/\s+/g, " ").trim();

  function renderMetrics(last) {
    tweenTo("m-rssi", last ? last.rssi : null, 0);
    tweenTo("m-std", last ? last.std : null, 2);
    tweenTo("m-score", last ? Math.round(last.score * 100) : null, 0);
    tweenTo("m-base", S.baseline, 2);
    $("m-quality").textContent = S.link && S.online ? `${S.link.quality}% link quality` : " ";
    $("cap-path").textContent = last && S.online ? `${last.rssi} dBm`.replace("-", "−") : "—";
    const meter = $("m-meter");
    meter.style.width = last ? `${Math.min(last.score / 2, 1) * 100}%` : "0%";
    meter.parentElement.classList.toggle("hot", !!last && last.score >= 1);
    renderBaselineNote();
  }

  function renderBaselineNote() {
    $("m-base-note").textContent = S.calibratedAt
      ? `Calibrated ${fmtDuration(now() - S.calibratedAt)} ago`
      : "Default. Calibrate for accuracy";
  }

  function renderSensitivity() {
    const s = S.sensitivity, input = $("sens");
    if (document.activeElement !== input) input.value = s;
    input.style.setProperty("--p", `${s * 100}%`);
    const factor = 3.5 - 2 * s;
    $("sens-val").textContent = `Triggers at ${factor.toFixed(1)}× calm variation`;
  }

  // events ---------------------------------------------------------------
  const eventEls = new Map();
  function renderEvents() {
    const list = $("events");
    const tNow = now();
    const keys = new Set();
    S.events.forEach((ev, idx) => {
      const key = ev.start.toFixed(2);
      keys.add(key);
      let li = eventEls.get(key);
      if (!li) {
        li = document.createElement("li");
        li.className = "event";
        li.innerHTML = '<span class="ev-time"></span><span class="ev-bar"><span></span></span><span class="ev-dur"></span>';
        li.querySelector(".ev-time").textContent = fmtClock(ev.start);
        eventEls.set(key, li);
      }
      const live = idx === 0 && S.motion && Math.abs(ev.start - S.since) < 0.01;
      li.classList.toggle("live", live);
      const end = live ? tNow : ev.end;
      li.querySelector(".ev-dur").textContent = fmtDuration(end - ev.start) + (live ? " · now" : "");
      li.querySelector(".ev-bar span").style.width = `${Math.max(6, Math.min(ev.peak / 2.5, 1) * 100)}%`;
      if (list.children[idx] !== li) list.insertBefore(li, list.children[idx] || null);
    });
    for (const [key, li] of eventEls) {
      if (!keys.has(key)) { li.remove(); eventEls.delete(key); }
    }
    $("events-empty").hidden = S.events.length > 0;
    $("btn-clear").style.visibility = S.events.length ? "visible" : "hidden";
    const n = S.events.length;
    $("act-sub").textContent = n ? `${n} movement${n === 1 ? "" : "s"} detected this session` : "Movement detected this session";
  }

  // calibration ----------------------------------------------------------
  function renderCalibration(progress) {
    const btn = $("btn-cal"), fill = $("ring-fill"), text = $("btn-cal-text");
    if (S.calibrating) {
      btn.disabled = true;
      fill.style.transform = `scaleX(${progress || 0})`;
      const left = Math.max(1, Math.ceil(S.calSeconds * (1 - (progress || 0))));
      text.textContent = `Hold still · ${left}`;
    } else {
      btn.disabled = false;
      fill.style.transform = "scaleX(0)";
      text.textContent = S.calibratedAt ? "Recalibrate" : "Calibrate";
    }
  }

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3600);
  }

  // ------------------------------------------------------------------ stream
  function ingest(msg) {
    S.lastMsg = Date.now();
    if (msg.type === "init") {
      S.samples = msg.history || [];
      S.baseline = msg.baseline;
      S.calibratedAt = msg.calibrated_at;
      S.sensitivity = msg.sensitivity;
      S.threshold = msg.threshold;
      S.motion = msg.motion;
      S.since = msg.since;
      S.calibrating = msg.calibrating;
      S.calSeconds = msg.calibration_seconds || 10;
      S.events = msg.events || [];
      S.link = msg.link;
      S.online = !!msg.link && S.samples.length > 0;
      const last = S.samples[S.samples.length - 1];
      if (last) { S.offset = Date.now() / 1000 - last.t; S.score = last.score; }
      renderSensitivity(); renderEvents(); renderCalibration(0);
      renderLink(); renderMetrics(last); refreshView();
      return;
    }
    if (msg.type !== "sample") return;

    const off = Date.now() / 1000 - msg.t;
    S.offset = S.offset == null ? off : S.offset + (off - S.offset) * 0.1;

    if (msg.rssi == null) {
      S.online = false;
      renderLink(); renderMetrics(null); refreshView();
      return;
    }
    S.online = true;
    S.samples.push({ t: msg.t, rssi: msg.rssi, std: msg.std, score: msg.score, motion: msg.motion });
    const cut = msg.t - KEEP_SECONDS;
    while (S.samples.length && S.samples[0].t < cut) S.samples.shift();

    S.score = msg.score;
    S.motion = msg.motion;
    S.since = msg.since;
    S.threshold = msg.threshold;
    S.link = msg.link || S.link;
    if (msg.events) { S.events = msg.events; }

    if (msg.calibration) {
      if (msg.calibration.done) {
        S.calibrating = false;
        S.baseline = msg.calibration.baseline;
        S.calibratedAt = msg.t;
        toast(`Calibrated. Your room's calm variation is ${msg.calibration.baseline.toFixed(2)} dB.`);
        renderCalibration(1);
      } else {
        S.calibrating = true;
        renderCalibration(msg.calibration.progress);
      }
    }

    renderLink(); renderMetrics(S.samples[S.samples.length - 1]); renderEvents(); refreshView();
  }

  function connect() {
    const es = new EventSource("/api/stream");
    es.onmessage = (e) => { try { ingest(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    es.onerror = () => {
      S.online = false;
      renderLink(); refreshView();
    };
  }

  // ------------------------------------------------------------------ controls
  $("btn-cal").addEventListener("click", async () => {
    S.calibrating = true;
    renderCalibration(0); refreshView();
    try {
      await fetch("/api/calibrate", { method: "POST" });
    } catch {
      S.calibrating = false; renderCalibration(0); refreshView();
      toast("Couldn't reach the server.");
    }
  });

  let sensTimer;
  $("sens").addEventListener("input", (e) => {
    S.sensitivity = parseFloat(e.target.value);
    renderSensitivity();
    clearTimeout(sensTimer);
    sensTimer = setTimeout(() => {
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sensitivity: S.sensitivity }),
      }).catch(() => toast("Couldn't save sensitivity."));
    }, 180);
  });

  $("btn-clear").addEventListener("click", () => {
    S.events = []; renderEvents();
    fetch("/api/events/clear", { method: "POST" }).catch(() => {});
  });

  // ------------------------------------------------------------------ frame loop
  let lastFrame = performance.now(), lastSlow = 0;
  function frame(ts) {
    const dt = Math.min(0.1, (ts - lastFrame) / 1000);
    lastFrame = ts;
    // draw slightly behind real time so new points glide in rather than pop
    const tView = now() - 0.4;
    drawRssi(tView);
    drawScore(tView);
    drawWave(dt);
    stepTweens();

    if (ts - lastSlow > 250) {
      lastSlow = ts;
      if (S.lastMsg && Date.now() - S.lastMsg > 4000 && S.online) {
        S.online = false; renderLink(); refreshView();
      }
      const label = S.view === "motion" ? "Moving for " : S.view === "still" ? "Steady for " : "";
      $("state-duration").textContent = label && S.since ? label + fmtDuration(now() - S.since) : " ";
      if (S.motion) renderEvents();
      renderBaselineNote();
    }
    requestAnimationFrame(frame);
  }

  // Only show "Listening" if the first data is slow to arrive, so a normal
  // refresh goes straight to the real state with a single clean animation.
  setTimeout(() => { if (!S.view) setView("listening"); }, 1200);

  // Hold the entrance animations until the fonts are ready (no font swap jump).
  Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 700))])
    .then(() => document.body.classList.add("ready"));

  renderSensitivity();
  renderCalibration(0);
  connect();
  requestAnimationFrame(frame);
})();
