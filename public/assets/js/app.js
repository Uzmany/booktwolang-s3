/* ===========================================================================
 * BookTwoLang — Studio client
 *
 * A single-page literary studio for AI document translation. Talks to
 * api.booktwolang.com (or http://localhost:8001 in dev) via the existing
 * /v1 endpoints; everything else — PDF extraction, paragraph alignment,
 * proper-noun memory, the tone dial, sync-scrolling, the laser scan, the
 * cascade-in animation — runs entirely client-side.
 *
 * Sections, in reading order:
 *   1. Configuration & state
 *   2. API helper
 *   3. Toast system
 *   4. Auth (login / signup / logout / nav)
 *   5. View routing
 *   6. Languages + speaker weighting + equalizer
 *   7. Hero dashboard (dropzone, paste, library)
 *   8. PDF / DOCX / TXT extraction
 *   9. Document polling
 *  10. Studio workspace (split view, sync scroll, divider)
 *  11. Studio rail (progress ring, tone dial, format lock)
 *  12. Character memory (extraction, drawer, locks)
 *  13. Cascade-in animation
 *  14. Help overlay + boot
 * ======================================================================= */


/* ════════════════════════ 1. Config & state ═════════════════════════════ */

const API_BASE = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  ? "http://localhost:8001"
  : "https://api.booktwolang.com";

const STORAGE = {
  token:        "btl_access_token_v2",
  user:         "btl_user_v2",
  targetLang:   "btl_target_lang_v2",
  tone:         "btl_tone_v2",
  formatLock:   "btl_format_lock_v2",
  splitRatio:   "btl_split_ratio_v2",
  memory:       "btl_memory_v2",
};

const TONES = [
  { id: 0, key: "literal",  label: "Literal",  model: "gemini-3-flash-preview", angle: -45 },
  { id: 1, key: "literary", label: "Literary", model: "gemini-3-pro-preview",   angle:   0 },
  { id: 2, key: "academic", label: "Academic", model: "gemini-3-pro-preview",   angle:  45 },
];

/* Rough native-speaker counts (millions) — drives equalizer bar heights so
   the visual reads like a real audio EQ. Languages absent here fall back
   to a sensible mid-height. */
const SPEAKERS_M = {
  en: 1500, zh: 1100, hi: 600, es: 550, fr: 280, ar: 420, bn: 270, pt: 260,
  ru: 260, ur: 230, ja: 125, de: 130, ko:  80, vi:  85, it:  65, tr:  85,
  fa:  70, pl:  45, uk:  40, nl:  25, th:  60, id: 200, ms: 290, sv:  10,
  no:   5, da:   6, fi:   5, cs:  10, el:  13, ro:  24, hu:  13, he:   9,
  "zh-Hant": 100,
};

const state = {
  view: "auth",                         // 'auth' | 'hero' | 'studio'
  accessToken: localStorage.getItem(STORAGE.token) || null,
  user: safeParse(localStorage.getItem(STORAGE.user)),

  languages: [],                        // [{code,name}]
  targetLang: localStorage.getItem(STORAGE.targetLang) || null,

  documents: [],                        // metadata list
  expandedDocId: null,                  // for hero card (none — we use studio now)
  filter: "all",                        // 'all' | 'translating' | 'complete'
  pollHandles: new Map(),               // docId -> setTimeout handle

  // studio
  studioDocId: null,
  studioMeta: null,
  studioContent: { source: "", translated: "" },
  studioParagraphs: { src: [], tgt: [] },
  splitRatio: clamp(parseFloat(localStorage.getItem(STORAGE.splitRatio) || "0.5"), 0.2, 0.8),
  isSyncing: false,                     // re-entrancy guard for sync scroll
  cascadedParagraphs: new Set(),        // 'docId:idx' marks already animated
  syncSource: null,                     // which pane currently drives scroll

  // controls
  tone: clamp(parseInt(localStorage.getItem(STORAGE.tone) ?? "1", 10), 0, 2),
  formatLock: (localStorage.getItem(STORAGE.formatLock) ?? "1") === "1",
  memoryFilter: "all",
  memoryOpen: false,
};

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function safeParse(json) { try { return JSON.parse(json); } catch (_) { return null; } }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function formatRelative(iso) {
  if (!iso) return "";
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 30) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}


/* ════════════════════════ 2. API helper ═════════════════════════════════ */

async function api(path, { method = "GET", body, headers = {}, raw = false, signal } = {}) {
  const opts = { method, headers: { ...headers }, signal };
  if (state.accessToken) opts.headers["Authorization"] = `Bearer ${state.accessToken}`;
  if (body && !(body instanceof FormData)) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  } else if (body) {
    opts.body = body;
  }
  const resp = await fetch(API_BASE + path, opts);
  if (resp.status === 401 && state.accessToken) {
    setAuth(null, null);
    showView("auth");
    throw new Error("Session expired");
  }
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try { const j = await resp.json(); detail = j.detail || JSON.stringify(j); } catch (_) {}
    throw new Error(detail);
  }
  if (raw) return resp;
  if (resp.status === 204) return null;
  return resp.json();
}


/* ════════════════════════ 3. Toasts ═════════════════════════════════════ */

function toast(text, tone = "info") {
  const el = document.createElement("div");
  el.className = `toast ${tone === "error" ? "toast--error" : tone === "success" ? "toast--success" : ""}`;
  const icon = tone === "error" ? "!" : tone === "success" ? "✓" : "i";
  el.innerHTML = `<span class="toast__icon">${icon}</span><span>${escapeHtml(text)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 240ms ease, transform 240ms ease";
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    setTimeout(() => el.remove(), 260);
  }, 4200);
}


/* ════════════════════════ 4. Auth + nav ═════════════════════════════════ */

function setAuth(token, user) {
  state.accessToken = token;
  state.user = user;
  if (token) localStorage.setItem(STORAGE.token, token); else localStorage.removeItem(STORAGE.token);
  if (user)  localStorage.setItem(STORAGE.user, JSON.stringify(user)); else localStorage.removeItem(STORAGE.user);
  document.documentElement.classList.toggle("is-authed", !!token);
  document.documentElement.classList.toggle("is-anon", !token);
  renderNav();
}

function renderNav() {
  const nav = $("#nav-actions");
  if (!state.user) { nav.innerHTML = ""; return; }
  const display = state.user.displayName || state.user.email;
  const initials = display.trim().slice(0, 2).toUpperCase();
  nav.innerHTML = `
    <button id="profile-btn" type="button" class="profile-btn" aria-haspopup="menu">
      <span class="profile-btn__name">${escapeHtml(display)}</span>
      <span class="profile-btn__avatar">${escapeHtml(initials)}</span>
    </button>`;
  $("#profile-btn").addEventListener("click", openProfileMenu);
}

function openProfileMenu(e) {
  closeProfileMenu();
  const menu = document.createElement("div");
  menu.id = "profile-menu";
  menu.className = "profile-menu animate-rise-fast";
  menu.style.animation = "fadeIn 180ms ease both";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `
    <div class="profile-menu__email">${escapeHtml(state.user.email)}</div>
    <hr class="profile-menu__hr" />
    <button class="profile-menu__item" data-action="library">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
      Back to library
    </button>
    <button class="profile-menu__item" data-action="help">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 0.7-1.5 1-1.5 2"/><path d="M12 17.01l.01 0"/></svg>
      How it works
    </button>
    <hr class="profile-menu__hr" />
    <button class="profile-menu__item profile-menu__item--danger" data-action="logout">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
      Sign out
    </button>`;
  document.body.appendChild(menu);
  menu.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "logout")  handleLogout();
    if (btn.dataset.action === "library") showView("hero");
    if (btn.dataset.action === "help")    openHelp();
    closeProfileMenu();
  });
  setTimeout(() => {
    document.addEventListener("click", outsideProfileMenu, { once: true });
    document.addEventListener("keydown", escProfileMenu, { once: true });
  }, 0);
  e?.stopPropagation();
}
function closeProfileMenu() { document.getElementById("profile-menu")?.remove(); }
function outsideProfileMenu(e) {
  if (e.target.closest("#profile-menu") || e.target.closest("#profile-btn")) {
    document.addEventListener("click", outsideProfileMenu, { once: true });
    return;
  }
  closeProfileMenu();
}
function escProfileMenu(e) {
  if (e.key === "Escape") closeProfileMenu();
  else document.addEventListener("keydown", escProfileMenu, { once: true });
}

function switchAuthTab(which) {
  const isLogin = which === "login";
  $("#tab-login").classList.toggle("is-active", isLogin);
  $("#tab-signup").classList.toggle("is-active", !isLogin);
  $("#tab-login").setAttribute("aria-selected", isLogin ? "true" : "false");
  $("#tab-signup").setAttribute("aria-selected", isLogin ? "false" : "true");
  $("#auth-tabs-thumb").style.transform = isLogin ? "translateX(0%)" : "translateX(100%)";
  $("#form-login").hidden = !isLogin;
  $("#form-signup").hidden = isLogin;
}

window.handleLogin = async () => {
  const form = $("#form-login");
  const errEl = $("#login-error"); errEl.hidden = true;
  try {
    const data = await api("/v1/auth/login", {
      method: "POST",
      body: { email: form.email.value.trim(), password: form.password.value },
    });
    setAuth(data.accessToken, data.user);
    if (data.user?.preferredTargetLang && !state.targetLang) {
      state.targetLang = data.user.preferredTargetLang;
      localStorage.setItem(STORAGE.targetLang, state.targetLang);
    }
    showView("hero");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
};

window.handleSignup = async () => {
  const form = $("#form-signup");
  const errEl = $("#signup-error"); errEl.hidden = true;
  try {
    const data = await api("/v1/users", {
      method: "POST",
      body: {
        email: form.email.value.trim(),
        password: form.password.value,
        displayName: form.displayName.value.trim() || null,
      },
    });
    setAuth(data.accessToken, data.user);
    showView("hero");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
};

async function handleLogout() {
  try { await api("/v1/auth/logout", { method: "POST" }); } catch (_) {}
  setAuth(null, null);
  for (const id of state.pollHandles.keys()) clearPoll(id);
  state.documents = [];
  state.studioDocId = null;
  state.studioMeta = null;
  showView("auth");
}


/* ════════════════════════ 5. View routing ═══════════════════════════════ */

async function showView(view) {
  state.view = view;
  $("#view-auth").hidden   = view !== "auth";
  $("#view-hero").hidden   = view !== "hero";
  $("#view-studio").hidden = view !== "studio";

  // Topbar visible everywhere except the cinematic auth screen
  $("#topbar").style.display = view === "auth" ? "none" : "";

  if (view === "hero") {
    await refreshLanguages();
    await refreshDocuments();
  }
  if (view !== "studio") {
    closeMemoryDrawer();
    state.studioDocId = null;
  }
  window.scrollTo({ top: 0, behavior: "instant" });
}


/* ════════════════════════ 6. Languages + equalizer ══════════════════════ */

async function refreshLanguages() {
  if (state.languages.length) {
    populateLanguageWidgets();
    return;
  }
  try {
    const data = await api("/v1/languages");
    state.languages = data.languages || [];
  } catch (err) {
    console.error("Could not load languages", err);
  }
  populateLanguageWidgets();
}

function languageName(code) {
  if (code === "auto") return "auto";
  return state.languages.find((l) => l.code === code)?.name || code;
}

function populateLanguageWidgets() {
  if (!state.languages.length) return;
  // Initial target language
  const wanted = state.targetLang || state.user?.preferredTargetLang || "es";
  state.targetLang = state.languages.some((l) => l.code === wanted) ? wanted : "es";
  localStorage.setItem(STORAGE.targetLang, state.targetLang);

  // Paste source language
  const sourceOpts = `<option value="auto">Auto-detect</option>` +
    state.languages.map((l) => `<option value="${l.code}">${escapeHtml(l.name)}</option>`).join("");
  $("#paste-source-lang").innerHTML = sourceOpts;

  renderEqualizer();
}

let _equalizerWired = false;
function renderEqualizer() {
  const bars = $("#equalizer-bars");
  const sorted = [...state.languages].sort((a, b) => (SPEAKERS_M[b.code] || 25) - (SPEAKERS_M[a.code] || 25));

  bars.innerHTML = sorted.map((l) => {
    const speakers = SPEAKERS_M[l.code] || 25;
    const h = Math.round(22 + (Math.log10(speakers) / Math.log10(1500)) * 78);
    const isActive = l.code === state.targetLang;
    return `
      <button class="eq-bar ${isActive ? "is-active" : ""}" data-code="${l.code}" type="button"
              role="option" aria-selected="${isActive}" title="${escapeHtml(l.name)}">
        <span class="eq-bar__fill" style="height:${h}%"></span>
        <span class="eq-bar__label">${escapeHtml(l.code)}</span>
      </button>`;
  }).join("");

  if (!_equalizerWired) {
    bars.addEventListener("click", onEqualizerClick);
    bars.addEventListener("wheel", onEqualizerWheel, { passive: false });
    $("#eq-scroll-left").onclick  = () => bars.scrollBy({ left: -240, behavior: "smooth" });
    $("#eq-scroll-right").onclick = () => bars.scrollBy({ left:  240, behavior: "smooth" });
    _equalizerWired = true;
  }

  updateEqualizerHead();
  centerActiveBar();
}

function onEqualizerClick(e) {
  const btn = e.target.closest(".eq-bar");
  if (!btn) return;
  setTargetLang(btn.dataset.code);
}
function onEqualizerWheel(e) {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    e.currentTarget.scrollLeft += e.deltaY;
  }
}
function setTargetLang(code) {
  if (state.targetLang === code) return;
  state.targetLang = code;
  localStorage.setItem(STORAGE.targetLang, code);
  $$("#equalizer-bars .eq-bar").forEach((b) => {
    const active = b.dataset.code === code;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  updateEqualizerHead();
  centerActiveBar();
  api("/v1/users/me", { method: "PATCH", body: { preferredTargetLang: code } }).catch(() => {});
}
function updateEqualizerHead() {
  const el = $("#equalizer-current");
  if (!el) return;
  const name = languageName(state.targetLang);
  el.textContent = name;
}
function centerActiveBar() {
  const active = $("#equalizer-bars .eq-bar.is-active");
  if (!active) return;
  active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
}


/* ════════════════════════ 7. Hero dashboard ═════════════════════════════ */

function wireHeroOnce() {
  // Auth tabs
  $("#tab-login").addEventListener("click", () => switchAuthTab("login"));
  $("#tab-signup").addEventListener("click", () => switchAuthTab("signup"));

  // Dropzone
  const dz = $("#dropzone");
  const fi = $("#file-input");
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-dragging"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-dragging"); })
  );
  dz.addEventListener("drop", (e) => handleFiles(Array.from(e.dataTransfer?.files || [])));
  fi.addEventListener("change", (e) => {
    handleFiles(Array.from(e.target.files || []));
    e.target.value = "";
  });

  // Paste panel
  $("#toggle-paste").addEventListener("click", () => {
    const panel = $("#paste-panel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      $("#paste-text").focus();
      panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
  $("#paste-text").addEventListener("input", (e) => {
    $("#paste-count").textContent = `${e.target.value.length.toLocaleString()} chars`;
  });
  $("#paste-translate").addEventListener("click", handlePasteTranslate);

  // Help
  $("#open-help").addEventListener("click", openHelp);
  $$("#help-overlay [data-close]").forEach((el) => el.addEventListener("click", closeHelp));

  // Filters
  $$(".library__meta .seg__btn").forEach((b) => b.addEventListener("click", () => {
    state.filter = b.dataset.filter;
    $$(".library__meta .seg__btn").forEach((x) => x.classList.toggle("is-active", x === b));
    renderDocuments();
  }));

  // Brand link → hero
  $("#brand-link").addEventListener("click", (e) => {
    e.preventDefault();
    if (state.user) showView("hero"); else showView("auth");
  });

  // Global paste-anywhere shortcut on hero
  document.addEventListener("paste", (e) => {
    if (state.view !== "hero") return;
    const target = e.target;
    const inField = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (inField) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text || text.length < 4) return;
    $("#paste-panel").hidden = false;
    $("#paste-text").value = text;
    $("#paste-text").dispatchEvent(new Event("input"));
    $("#paste-text").focus();
  });
}

async function handleFiles(files) {
  if (!files.length) return;
  if (!state.targetLang) { toast("Pick a target language first", "error"); return; }
  for (const file of files) {
    await uploadAndTranslate(file);
  }
}

async function handlePasteTranslate() {
  const text = $("#paste-text").value.trim();
  if (!text) { toast("Paste some text first", "error"); return; }
  if (!state.targetLang) { toast("Pick a target language first", "error"); return; }
  const btn = $("#paste-translate");
  btn.disabled = true;
  try {
    const title = text.split(/\s+/).slice(0, 6).join(" ").slice(0, 60) || "Pasted text";
    const sourceLang = $("#paste-source-lang").value || "auto";
    const doc = await api("/v1/documents", { method: "POST", body: { title, sourceLang, sourceText: text } });
    upsertDoc(doc);
    const result = await api(`/v1/documents/${doc.docId}/translate`, {
      method: "POST",
      body: { targetLang: state.targetLang, model: TONES[state.tone].model },
    });
    upsertDoc({ ...doc, ...result });
    startPoll({ docId: doc.docId });
    $("#paste-text").value = "";
    $("#paste-count").textContent = "0 chars";
    $("#paste-panel").hidden = true;
    openStudio(doc.docId);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}


/* ════════════════════════ 8. File extraction ════════════════════════════ */

const ALLOWED_EXTS = [".txt", ".docx", ".pdf", ".md"];
const MAX_BYTES = 5 * 1024 * 1024;

async function uploadAndTranslate(file) {
  const lower = file.name.toLowerCase();
  if (!ALLOWED_EXTS.some((ext) => lower.endsWith(ext))) {
    toast(`${file.name}: unsupported file type`, "error");
    return;
  }
  if (file.size > MAX_BYTES) {
    toast(`${file.name}: too large (max 5 MB)`, "error");
    return;
  }

  const dz = $("#dropzone");
  dz.classList.add("is-scanning");

  try {
    let doc;
    if (lower.endsWith(".pdf") || lower.endsWith(".md")) {
      // PDF and Markdown extracted client-side, sent as raw text
      const text = lower.endsWith(".pdf")
        ? await extractPdfText(file)
        : await file.text();
      const cleaned = (text || "").trim();
      if (!cleaned) {
        toast(`${file.name}: no readable text found`, "error");
        return;
      }
      const title = file.name.replace(/\.(pdf|md)$/i, "");
      doc = await api("/v1/documents", { method: "POST", body: { title, sourceLang: "auto", sourceText: cleaned } });
    } else {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", file.name.replace(/\.(txt|docx)$/i, ""));
      fd.append("sourceLang", "auto");
      doc = await api("/v1/documents/upload", { method: "POST", body: fd });
    }

    upsertDoc(doc);
    const result = await api(`/v1/documents/${doc.docId}/translate`, {
      method: "POST",
      body: { targetLang: state.targetLang, model: TONES[state.tone].model },
    });
    upsertDoc({ ...doc, ...result });
    startPoll({ docId: doc.docId });
    openStudio(doc.docId);
  } catch (err) {
    toast(`${file.name}: ${err.message}`, "error");
  } finally {
    setTimeout(() => dz.classList.remove("is-scanning"), 600);
  }
}

let _pdfJsPromise = null;
function ensurePdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfJsPromise) return _pdfJsPromise;
  _pdfJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      } catch (_) {}
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error("Could not load PDF reader"));
    document.head.appendChild(s);
  });
  return _pdfJsPromise;
}

async function extractPdfText(file) {
  const lib = await ensurePdfJs();
  const buffer = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: buffer }).promise;
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const lines = [];
    let line = [];
    let lastY = null;
    for (const item of content.items) {
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(lastY - y) > 4) {
        lines.push(line.join(" "));
        line = [];
      }
      line.push(item.str);
      lastY = y;
    }
    if (line.length) lines.push(line.join(" "));
    out.push(lines.join("\n"));
  }
  // Glue pages with blank lines so chunker preserves paragraph breaks
  return out.join("\n\n");
}


/* ════════════════════════ 9. Documents + polling ════════════════════════ */

async function refreshDocuments() {
  try {
    const data = await api("/v1/documents");
    state.documents = data.documents || [];
    renderDocuments();
    state.documents.filter((d) => d.status === "translating").forEach(startPoll);
  } catch (err) {
    console.error(err);
  }
}

function upsertDoc(meta) {
  const idx = state.documents.findIndex((d) => d.docId === meta.docId);
  if (idx >= 0) state.documents[idx] = { ...state.documents[idx], ...meta };
  else state.documents.unshift(meta);
  renderDocuments();
  if (state.studioDocId === meta.docId) {
    state.studioMeta = { ...state.studioMeta, ...meta };
    renderStudioBar();
    renderStudioRail();
  }
}

function renderDocuments() {
  if (state.view !== "hero") return;
  const container = $("#doc-cards");
  const empty = $("#empty-state");
  const count = $("#history-count");

  const filtered = state.documents.filter((d) => {
    if (state.filter === "all") return true;
    if (state.filter === "translating") return d.status === "translating" || d.status === "pending";
    if (state.filter === "complete") return d.status === "complete";
    return true;
  });

  count.textContent = state.documents.length
    ? `${state.documents.length} manuscript${state.documents.length === 1 ? "" : "s"}`
    : "";

  if (!filtered.length) {
    container.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  container.innerHTML = filtered.map(renderDocCard).join("");
  $$("#doc-cards .doc-card").forEach((el) => {
    el.addEventListener("click", () => openStudio(el.dataset.id));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openStudio(el.dataset.id); }
    });
  });
}

function renderDocCard(d) {
  const pct = d.totalChunks ? Math.round((d.completedChunks / d.totalChunks) * 100) : 0;
  const isTranslating = d.status === "translating" || d.status === "pending";
  const isComplete = d.status === "complete";
  const isFailed = d.status === "failed";
  const glyphCls = isFailed ? "doc-card__glyph--rose" : isTranslating ? "doc-card__glyph--biolume" : "";
  const status = isTranslating
    ? `<span class="doc-card__status doc-card__status--translating"><span class="doc-card__pulse"></span>${pct}% · translating</span>`
    : isComplete
    ? `<span class="doc-card__status doc-card__status--complete">Done</span>`
    : isFailed
    ? `<span class="doc-card__status doc-card__status--failed">Failed</span>`
    : `<span class="doc-card__status doc-card__status--ready">Ready</span>`;

  const glyph = isTranslating
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>`
    : isFailed
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>`
    : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4 h10 l4 4 v12 a1 1 0 0 1 -1 1 H5 a1 1 0 0 1 -1 -1 V5 a1 1 0 0 1 1 -1 z"/><path d="M15 4 v4 h4"/><path d="M8 12 h7 M8 16 h5"/></svg>`;

  return `
    <article class="doc-card" data-id="${d.docId}" tabindex="0" role="button" aria-label="${escapeHtml(d.title)}">
      <div class="doc-card__row">
        <div class="doc-card__glyph ${glyphCls}">${glyph}</div>
        <div class="doc-card__main">
          <h4 class="doc-card__title">${escapeHtml(d.title || "Untitled")}</h4>
          <div class="doc-card__meta">
            <span class="doc-card__lang">
              <span class="lang-pill">${escapeHtml(d.sourceLang === "auto" ? "auto" : d.sourceLang)}</span>
              <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="opacity:.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
              <span class="lang-pill lang-pill--gold">${escapeHtml(d.targetLang || "—")}</span>
            </span>
            <span>·</span>
            <span class="mono">${(d.sourceChars || 0).toLocaleString()} chars</span>
            <span>·</span>
            <span>${formatRelative(d.createdAt)}</span>
          </div>
          ${isTranslating ? `
            <div class="doc-card__progress">
              <div class="doc-card__progress-bar"><div class="doc-card__progress-fill" style="width:${pct}%"></div></div>
              <span class="doc-card__progress-pct">${d.completedChunks}/${d.totalChunks}</span>
            </div>` : ""}
          ${isFailed && d.error ? `<p class="doc-card__error">${escapeHtml(d.error)}</p>` : ""}
        </div>
        ${status}
      </div>
    </article>`;
}

function clearPoll(docId) {
  const h = state.pollHandles.get(docId);
  if (h) { clearTimeout(h); state.pollHandles.delete(docId); }
}
function startPoll(doc) {
  clearPoll(doc.docId);
  const tick = async () => {
    try {
      const meta = await api(`/v1/documents/${doc.docId}`);
      upsertDoc(meta);

      // If we're in the studio for this doc, refresh content and re-render
      // so freshly arrived paragraphs cascade in. We don't re-extract the
      // memory list (source text is immutable); we only refresh inferred
      // translations cheaply.
      if (state.studioDocId === doc.docId) {
        await loadStudioContent(doc.docId, /* incremental */ true);
        renderStudioPanes();
        renderStudioRail();
        refreshMemoryTranslations();
      }

      if (meta.status === "complete" || meta.status === "failed") {
        clearPoll(doc.docId);
        if (meta.status === "complete") {
          toast(`"${meta.title}" translated`, "success");
        } else {
          toast(meta.error || "Translation failed", "error");
        }
        return;
      }
    } catch (err) {
      console.error("poll", err);
    }
    state.pollHandles.set(doc.docId, setTimeout(tick, 1800));
  };
  state.pollHandles.set(doc.docId, setTimeout(tick, 900));
}


/* ════════════════════════ 10. Studio workspace ══════════════════════════ */

async function openStudio(docId) {
  const meta = state.documents.find((d) => d.docId === docId);
  if (!meta) {
    toast("Document not found", "error");
    return;
  }
  state.studioDocId = docId;
  state.studioMeta = meta;
  state.studioContent = { source: "Loading…", translated: "" };
  state.studioParagraphs = { src: [], tgt: [] };
  state.cascadedParagraphs.clear();

  showView("studio");
  applySplitRatio(state.splitRatio);
  renderStudioBar();
  renderStudioRail();
  renderStudioPanes();

  await loadStudioContent(docId);

  // Mark every paragraph that's already translated as "seen" so we don't
  // cascade-animate the entire backlog when a finished doc is reopened —
  // only paragraphs that *arrive* after this point should cascade.
  const seen = paragraphsFromText(state.studioContent.translated || "");
  for (let i = 0; i < seen.length; i++) {
    state.cascadedParagraphs.add(`${docId}:${i}`);
  }

  renderStudioPanes();
  renderStudioRail();
  rebuildCharacterMemory();

  // If still translating, ensure the poll is running so cascade kicks in
  // as new chunks arrive.
  if (meta.status === "translating" || meta.status === "pending") {
    startPoll({ docId });
  }
}

async function loadStudioContent(docId, incremental = false) {
  try {
    const [src, trn] = await Promise.all([
      api(`/v1/documents/${docId}/source`),
      api(`/v1/documents/${docId}/translated`),
    ]);
    state.studioContent = { source: src.text || "", translated: trn.text || "" };
  } catch (err) {
    if (!incremental) console.error("loadStudioContent", err);
  }
}

function renderStudioBar() {
  const m = state.studioMeta;
  if (!m) return;
  $("#studio-title").textContent = m.title || "Untitled";
  $("#studio-src-lang").textContent = m.sourceLang === "auto" ? "auto" : m.sourceLang;
  $("#studio-tgt-lang").textContent = m.targetLang || "—";
  $("#pane-src-lang").textContent = m.sourceLang === "auto" ? "auto" : m.sourceLang;
  $("#pane-tgt-lang").textContent = m.targetLang || "—";

  const status = $("#studio-status");
  status.classList.remove("studio-status--translating", "studio-status--complete", "studio-status--failed", "studio-status--ready");
  if (m.status === "translating" || m.status === "pending") {
    status.classList.add("studio-status--translating");
    const pct = m.totalChunks ? Math.round((m.completedChunks / m.totalChunks) * 100) : 0;
    status.innerHTML = `<span class="dot dot--biolume"></span><span>Translating · ${pct}%</span>`;
  } else if (m.status === "complete") {
    status.classList.add("studio-status--complete");
    status.innerHTML = `<span class="dot dot--papyrus"></span><span>Complete</span>`;
  } else if (m.status === "failed") {
    status.classList.add("studio-status--failed");
    status.innerHTML = `<span>Failed</span>`;
  } else {
    status.classList.add("studio-status--ready");
    status.innerHTML = `<span>Ready</span>`;
  }
}

function paragraphsFromText(text) {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function renderStudioPanes() {
  const srcText = state.studioContent.source || "";
  const tgtText = state.studioContent.translated || "";

  const srcParas = paragraphsFromText(srcText);
  const tgtParas = paragraphsFromText(tgtText);
  state.studioParagraphs = { src: srcParas, tgt: tgtParas };

  // Preserve scroll positions across re-renders (poll updates would
  // otherwise yank the reader back to the top).
  const srcScroll = $("#pane-src-scroll");
  const tgtScroll = $("#pane-tgt-scroll");
  const srcTop = srcScroll.scrollTop;
  const tgtTop = tgtScroll.scrollTop;

  const srcBody = $("#pane-src-body");
  srcBody.innerHTML = srcParas.length
    ? srcParas.map((p, i) => `<p data-pidx="${i}">${escapeHtml(p)}</p>`).join("")
    : `<p class="pending">Loading source…</p>`;

  const tgtBody = $("#pane-tgt-body");
  const total = Math.max(srcParas.length, tgtParas.length);
  let html = "";
  for (let i = 0; i < total; i++) {
    if (i < tgtParas.length) {
      const key = `${state.studioDocId}:${i}`;
      const fresh = !state.cascadedParagraphs.has(key);
      state.cascadedParagraphs.add(key);
      const text = tgtParas[i];
      html += `<p data-pidx="${i}" data-fresh="${fresh ? "1" : "0"}">${fresh ? cascadeHtml(text) : escapeHtml(text)}</p>`;
    } else {
      html += `<p class="pending" data-pidx="${i}">Translating…</p>`;
    }
  }
  if (!total) {
    html = `<p class="pending">Awaiting translation…</p>`;
  }
  tgtBody.innerHTML = html;

  // Restore scroll positions
  state.isSyncing = true;
  srcScroll.scrollTop = srcTop;
  tgtScroll.scrollTop = tgtTop;
  requestAnimationFrame(() => { state.isSyncing = false; });

  ensureSyncWired();
}

/* Cascade: wrap each character in a <span class="cascade"> with staggered delay */
function cascadeHtml(text) {
  const chars = Array.from(text);
  // Cap to first 280 chars for performance — the rest fades in via the parent
  const cap = 280;
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const safe = escapeHtml(c);
    if (i < cap) {
      out += `<span class="cascade" style="animation-delay:${(i % 60) * 6}ms">${safe}</span>`;
    } else {
      out += safe;
    }
  }
  return out;
}

/* Sync scrolling — match scroll percentage between panes, then highlight
   the topmost visible paragraph in both. The pane that initiated the
   scroll wins until the user releases. */
let _syncWired = false;
function ensureSyncWired() {
  if (_syncWired) return;
  _syncWired = true;
  const srcEl = $("#pane-src-scroll");
  const tgtEl = $("#pane-tgt-scroll");
  srcEl.addEventListener("scroll", () => onPaneScroll("src"));
  tgtEl.addEventListener("scroll", () => onPaneScroll("tgt"));
  ["pointerenter", "wheel", "touchstart", "keydown"].forEach((ev) => {
    srcEl.addEventListener(ev, () => state.syncSource = "src");
    tgtEl.addEventListener(ev, () => state.syncSource = "tgt");
  });
}

function onPaneScroll(which) {
  if (state.isSyncing) return;
  if (state.syncSource && state.syncSource !== which) return;

  const fromEl = $(which === "src" ? "#pane-src-scroll" : "#pane-tgt-scroll");
  const toEl   = $(which === "src" ? "#pane-tgt-scroll" : "#pane-src-scroll");
  const fromBody = fromEl.firstElementChild;
  const toBody   = toEl.firstElementChild;
  if (!fromBody || !toBody) return;

  // Find the topmost visible paragraph in the source pane
  const fromParas = $$(`p[data-pidx]`, fromBody);
  const toParas   = $$(`p[data-pidx]`, toBody);
  if (!fromParas.length) return;

  const containerTop = fromEl.getBoundingClientRect().top;
  let activeIdx = 0;
  for (const p of fromParas) {
    const top = p.getBoundingClientRect().top - containerTop;
    if (top > 60) break;
    activeIdx = parseInt(p.dataset.pidx, 10);
  }

  // Highlight in both
  setFocusParagraph(fromBody, activeIdx);
  if (toParas.length) setFocusParagraph(toBody, Math.min(activeIdx, toParas.length - 1));

  // Align target scroll
  const targetPara = toParas.find((p) => parseInt(p.dataset.pidx, 10) === activeIdx);
  if (targetPara) {
    state.isSyncing = true;
    const toTop = targetPara.offsetTop - 24;
    toEl.scrollTop = toTop;
    requestAnimationFrame(() => { state.isSyncing = false; });
  }
}

function setFocusParagraph(body, idx) {
  $$("p.is-focus", body).forEach((p) => p.classList.remove("is-focus"));
  const target = body.querySelector(`p[data-pidx="${idx}"]`);
  if (target) target.classList.add("is-focus");
}


/* ── Studio bar wiring ── */
function wireStudioOnce() {
  $("#studio-back").addEventListener("click", () => showView("hero"));
  $("#studio-download").addEventListener("click", studioDownload);
  $("#studio-delete").addEventListener("click", studioDelete);
  $("#studio-find").addEventListener("click", studioFind);

  $$(".pane__tool[data-action='copy-src']").forEach((b) => b.addEventListener("click", () => copyText(state.studioContent.source, "Source copied")));
  $$(".pane__tool[data-action='copy-tgt']").forEach((b) => b.addEventListener("click", () => copyText(state.studioContent.translated, "Translation copied")));

  // Split divider
  wireSplitDivider();

  // Tone dial
  wireToneDial();

  // Format lock
  wireFormatLock();

  // Memory drawer
  $("#memory-toggle").addEventListener("click", openMemoryDrawer);
  $("#memory-close").addEventListener("click", closeMemoryDrawer);
  $$("[data-mem-filter]").forEach((b) => b.addEventListener("click", () => {
    state.memoryFilter = b.dataset.memFilter;
    $$("[data-mem-filter]").forEach((x) => x.classList.toggle("is-active", x === b));
    renderMemoryList();
  }));
}

async function copyText(text, msg) {
  if (!text) { toast("Nothing to copy yet", "error"); return; }
  try { await navigator.clipboard.writeText(text); toast(msg, "success"); }
  catch (_) { toast("Copy failed", "error"); }
}

async function studioDownload() {
  if (!state.studioMeta) return;
  const meta = state.studioMeta;
  if (!state.studioContent.translated) {
    toast("Translation not ready yet", "error");
    return;
  }
  const filename = `${(meta.title || "translation").replace(/[^\w.\- ]+/g, "_")}_${meta.targetLang || "translated"}.txt`;
  const blob = new Blob([state.studioContent.translated], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function studioDelete() {
  if (!state.studioMeta) return;
  if (!confirm(`Delete "${state.studioMeta.title}"?`)) return;
  try {
    await api(`/v1/documents/${state.studioMeta.docId}`, { method: "DELETE" });
    state.documents = state.documents.filter((d) => d.docId !== state.studioMeta.docId);
    clearPoll(state.studioMeta.docId);
    toast("Manuscript deleted", "success");
    showView("hero");
  } catch (err) {
    toast(err.message, "error");
  }
}

function studioFind() {
  const q = prompt("Search this manuscript", "");
  if (!q) return;
  const haystack = (state.studioContent.source + "\n" + state.studioContent.translated).toLowerCase();
  const idx = haystack.indexOf(q.toLowerCase());
  if (idx < 0) { toast("No match", "error"); return; }
  // Scroll to the first matching paragraph in source
  const target = state.studioParagraphs.src.findIndex((p) => p.toLowerCase().includes(q.toLowerCase()));
  if (target >= 0) {
    const el = $(`#pane-src-body p[data-pidx="${target}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFocusParagraph($("#pane-src-body"), target);
    setFocusParagraph($("#pane-tgt-body"), Math.min(target, state.studioParagraphs.tgt.length - 1));
  }
}


/* ════════════════════════ 11. Studio rail ═══════════════════════════════ */

function renderStudioRail() {
  const m = state.studioMeta;
  if (!m) return;

  // Progress ring
  const pct = m.totalChunks ? Math.round((m.completedChunks / m.totalChunks) * 100) : (m.status === "complete" ? 100 : 0);
  const r = 52;
  const C = 2 * Math.PI * r;
  const dash = C - (pct / 100) * C;
  const ringFg = $("#progress-ring-fg");
  if (ringFg) ringFg.setAttribute("stroke-dashoffset", String(dash));
  $("#progress-ring-pct").innerHTML = `${pct}<span>%</span>`;
  const sub = m.status === "complete" ? "translated"
    : m.status === "failed" ? "failed"
    : m.totalChunks ? `${m.completedChunks}/${m.totalChunks} chunks`
    : "queued";
  $("#progress-ring-sub").textContent = sub;

  // Read-time estimate (translation, then source, then char count fallback)
  const text = state.studioContent.translated || state.studioContent.source || "";
  const words = countWords(text);
  $("#rail-word-count").textContent = words ? words.toLocaleString() : "—";
  $("#rail-read-time").textContent = words ? formatReadTime(words, m.targetLang) : "—";

  // Tone dial
  setToneVisual(state.tone);

  // Format lock toggle
  const lockBtn = $("#format-lock");
  lockBtn.setAttribute("aria-pressed", state.formatLock ? "true" : "false");

  // Memory count
  const list = currentMemory();
  $("#memory-count").textContent = list.length
    ? `${list.length} entr${list.length === 1 ? "y" : "ies"} extracted`
    : "Awaiting source text";
}

function countWords(text) {
  if (!text) return 0;
  // Mixed-script word counter: split on whitespace then drop empties
  return text.split(/\s+/).filter(Boolean).length;
}

function formatReadTime(words, lang) {
  // Average WPM tunings — Latin scripts ~240, CJK 180 (chars-equivalent), Arabic 200
  const cjk = ["zh", "zh-Hant", "ja", "ko"];
  const wpm = cjk.includes(lang) ? 180 : (lang === "ar" || lang === "fa" || lang === "ur" || lang === "he") ? 200 : 240;
  const minutes = Math.max(1, Math.round(words / wpm));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/* Tone dial */
function wireToneDial() {
  const dial = $("#tone-dial");
  const face = dial.querySelector(".dial__face");
  const labels = $$(".dial__labels li");

  labels.forEach((li) => {
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      setTone(parseInt(li.dataset.tone, 10));
    });
  });

  // Drag the needle on the face only
  let dragging = false;
  const updateFromEvent = (e) => {
    const rect = face.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height;
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - cx;
    const y = (e.touches?.[0]?.clientY ?? e.clientY) - cy;
    let angle = Math.atan2(x, -y) * 180 / Math.PI;
    if (Number.isNaN(angle)) return;
    angle = clamp(angle, -60, 60);
    const snap = angle < -20 ? 0 : angle > 20 ? 2 : 1;
    setTone(snap);
  };
  face.addEventListener("pointerdown", (e) => {
    dragging = true;
    updateFromEvent(e);
    try { face.setPointerCapture(e.pointerId); } catch (_) {}
  });
  face.addEventListener("pointermove", (e) => { if (dragging) updateFromEvent(e); });
  face.addEventListener("pointerup",   (e) => { dragging = false; try { face.releasePointerCapture(e.pointerId); } catch (_) {} });
  face.addEventListener("pointercancel", () => { dragging = false; });

  dial.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown")  setTone(clamp(state.tone - 1, 0, 2));
    if (e.key === "ArrowRight" || e.key === "ArrowUp")   setTone(clamp(state.tone + 1, 0, 2));
  });
}
function setTone(idx) {
  const next = clamp(idx, 0, 2);
  if (next === state.tone) return;
  state.tone = next;
  localStorage.setItem(STORAGE.tone, String(state.tone));
  setToneVisual(state.tone);

  // Offer to re-translate with the new tone ONLY for completed docs and
  // ONLY when the user changes tone deliberately while in the studio.
  const m = state.studioMeta;
  if (m && state.view === "studio" && m.status === "complete" && state.targetLang) {
    // Debounce the confirm so a quick drag across positions doesn't spam.
    clearTimeout(_toneConfirmTimer);
    _toneConfirmTimer = setTimeout(() => {
      if (confirm(`Re-translate "${m.title}" with ${TONES[state.tone].label} tone?`)) {
        retranslate();
      }
    }, 350);
  }
}
let _toneConfirmTimer = null;
function setToneVisual(tone) {
  const t = TONES[tone];
  $("#dial-needle").style.transform = `translateX(-50%) rotate(${t.angle}deg)`;
  $$(".dial__labels li").forEach((li) => li.classList.toggle("is-active", parseInt(li.dataset.tone, 10) === tone));
  $("#tone-readout").textContent = t.label;
  $("#tone-dial").setAttribute("aria-valuenow", String(tone));
}

async function retranslate() {
  const m = state.studioMeta;
  if (!m) return;
  try {
    const result = await api(`/v1/documents/${m.docId}/translate`, {
      method: "POST",
      body: { targetLang: state.targetLang, model: TONES[state.tone].model },
    });
    upsertDoc({ ...m, ...result });
    state.cascadedParagraphs.clear();
    startPoll({ docId: m.docId });
    renderStudioBar();
    renderStudioRail();
    toast(`Re-translating with ${TONES[state.tone].label.toLowerCase()} tone…`, "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

/* Format lock — toggling rerenders the panes with normalised vs preserved
   whitespace. The translation itself preserves paragraphs server-side; the
   lock controls rendered presentation (line-break preservation). */
function wireFormatLock() {
  $("#format-lock").addEventListener("click", () => {
    state.formatLock = !state.formatLock;
    localStorage.setItem(STORAGE.formatLock, state.formatLock ? "1" : "0");
    $("#format-lock").setAttribute("aria-pressed", state.formatLock ? "true" : "false");
    document.body.classList.toggle("is-format-locked", state.formatLock);
    renderStudioPanes();
  });
}

/* Split divider drag */
function wireSplitDivider() {
  const split = $("#studio-split");
  const divider = $("#split-divider");
  let dragging = false;
  const onDown = (e) => {
    dragging = true;
    split.classList.add("is-dragging");
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left;
    // The rail occupies the rightmost 244px (or 56 if collapsed)
    const railW = split.classList.contains("is-rail-collapsed") ? 56 : 244;
    const usable = rect.width - railW - 12;
    const ratio = clamp(x / usable, 0.18, 0.82);
    applySplitRatio(ratio);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    split.classList.remove("is-dragging");
    localStorage.setItem(STORAGE.splitRatio, String(state.splitRatio));
  };
  divider.addEventListener("pointerdown", onDown);
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  divider.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft")  applySplitRatio(state.splitRatio - 0.04);
    if (e.key === "ArrowRight") applySplitRatio(state.splitRatio + 0.04);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      localStorage.setItem(STORAGE.splitRatio, String(state.splitRatio));
    }
  });
}
function applySplitRatio(ratio) {
  state.splitRatio = clamp(ratio, 0.18, 0.82);
  $("#studio-split").style.setProperty("--split", `${(state.splitRatio * 100).toFixed(2)}%`);
}


/* ════════════════════════ 12. Character memory ══════════════════════════ */

const PROPER_NOUN_RE = /\b([A-Z][a-zà-öø-ÿ]{1,}(?:[\s\-’'][A-Z][a-zà-öø-ÿ]+){0,3})\b/g;
const SENTENCE_STARTERS = new Set([
  "The","A","An","I","He","She","They","We","You","It","His","Her","Their","Our","My","Your","This","That","These","Those","And","But","Or","So","Yet","If","When","While","After","Before","Although","Because","Since","Whether","From","To","In","On","At","With","For","By","Of","About","As","Into","Onto","Upon","Through","Over","Under","Above","Below","After","Before","Between","Among","During","Across","Around","Behind","Beside","Beyond","Inside","Outside","Throughout","Within","Without","Then","Now","Here","There","No","Yes","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Mr","Mrs","Ms","Dr",
]);

const PLACE_HINTS = ["City","Town","Village","Lake","River","Mountain","Forest","Castle","Palace","Tower","Bay","Sea","Ocean","Island","Hill","Valley","Bridge","Square","Street","Road","House","Manor","Church","Cathedral","Temple","Mosque","Garden","Park","Hall","Place"];
const PERSON_HINTS = ["Mr.","Mrs.","Ms.","Dr.","Lord","Lady","King","Queen","Prince","Princess","Sir","Madam","Father","Mother","Captain","Commander","General","Professor","Doctor"];

function rebuildCharacterMemory() {
  const text = state.studioContent.source || "";
  if (!text || text.length < 200) {
    state.memoryEntries = [];
    renderMemoryList();
    renderStudioRail();
    return;
  }

  const counts = new Map();          // canonical → { count, contexts: [...] }
  const positions = new Map();       // canonical → array of char positions

  PROPER_NOUN_RE.lastIndex = 0;
  let m;
  while ((m = PROPER_NOUN_RE.exec(text)) !== null) {
    const phrase = m[1].trim();
    // Skip sentence-initial single-word matches that look like common starters
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    const isSentenceStart = /[.!?]\s+$/.test(before) || m.index === 0;
    const single = !phrase.includes(" ") && !phrase.includes("-");
    if (isSentenceStart && single && SENTENCE_STARTERS.has(phrase)) continue;
    if (SENTENCE_STARTERS.has(phrase)) continue;

    const canon = phrase;
    if (!counts.has(canon)) counts.set(canon, { count: 0, hint: "" });
    counts.get(canon).count++;
    if (!positions.has(canon)) positions.set(canon, []);
    positions.get(canon).push(m.index);
  }

  // Filter: ≥3 occurrences (or ≥2 for multi-word) and ≥3 chars
  const candidates = [];
  for (const [name, { count }] of counts.entries()) {
    if (name.length < 3) continue;
    const isMulti = name.includes(" ") || name.includes("-");
    if (!isMulti && count < 3) continue;
    if (isMulti && count < 2) continue;
    candidates.push({ name, count });
  }
  candidates.sort((a, b) => b.count - a.count);
  const top = candidates.slice(0, 32);

  // Classify
  const tgtParas = paragraphsFromText(state.studioContent.translated || "");
  const srcParas = paragraphsFromText(text);

  const overrides = loadMemoryOverrides();
  state.memoryEntries = top.map(({ name, count }) => {
    const type = classifyEntry(name, text);
    const inferred = inferTranslation(name, srcParas, tgtParas);
    const lockKey = `${state.studioDocId}::${name}`;
    const override = overrides[lockKey];
    return {
      name,
      type,                         // 'people' | 'places' | 'terms'
      count,
      translation: override?.translation || inferred || "",
      locked: !!override?.locked,
    };
  });

  renderMemoryList();
  renderStudioRail();
}

function classifyEntry(name, text) {
  for (const hint of PERSON_HINTS) {
    const re = new RegExp(`\\b${hint.replace(".", "\\.")}\\s+${name.split(" ").map(esc).join("\\s+")}`, "g");
    if (re.test(text)) return "people";
  }
  for (const hint of PLACE_HINTS) {
    if (name.endsWith(hint) || new RegExp(`${hint}\\s+of`, "i").test(text + " " + name)) return "places";
  }
  // Heuristic: two+ words usually a proper name/place; single-word capitalised
  // recurring tokens often a character name in fiction.
  return name.includes(" ") ? "places" : "people";
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function inferTranslation(name, srcParas, tgtParas) {
  // Find first paragraph index containing the name; pick the matching tgt
  // paragraph; look for capitalised tokens absent from a small stoplist.
  const idx = srcParas.findIndex((p) => p.includes(name));
  if (idx < 0 || idx >= tgtParas.length) return "";
  const tgt = tgtParas[idx];
  // Try to find a capitalised word in the target that isn't in source as is
  const tokens = tgt.match(/[\p{Lu}][\p{L}]{2,}/gu) || [];
  for (const tk of tokens) {
    if (!srcParas.some((p) => p.includes(tk))) return tk;
  }
  return tokens[0] || "";
}

function loadMemoryOverrides() {
  return safeParse(localStorage.getItem(STORAGE.memory)) || {};
}
function saveMemoryOverride(name, fields) {
  if (!state.studioDocId) return;
  const all = loadMemoryOverrides();
  const key = `${state.studioDocId}::${name}`;
  all[key] = { ...all[key], ...fields };
  localStorage.setItem(STORAGE.memory, JSON.stringify(all));
}

/* Cheap re-inference of translations as more chunks complete during
   polling. Locked entries keep their override; unlocked ones update if a
   better candidate appears. */
function refreshMemoryTranslations() {
  if (!state.memoryEntries?.length) return;
  const srcParas = paragraphsFromText(state.studioContent.source || "");
  const tgtParas = paragraphsFromText(state.studioContent.translated || "");
  let changed = false;
  for (const e of state.memoryEntries) {
    if (e.locked) continue;
    const guess = inferTranslation(e.name, srcParas, tgtParas);
    if (guess && guess !== e.translation) {
      e.translation = guess;
      changed = true;
    }
  }
  if (changed && state.memoryOpen) renderMemoryList();
  // Always refresh count
  const list = currentMemory();
  $("#memory-count").textContent = list.length
    ? `${list.length} entr${list.length === 1 ? "y" : "ies"} extracted`
    : "Awaiting source text";
}

function currentMemory() {
  return state.memoryEntries || [];
}

function renderMemoryList() {
  const list = $("#memory-list");
  if (!list) return;
  const filtered = currentMemory().filter((e) =>
    state.memoryFilter === "all" ? true : e.type === state.memoryFilter
  );
  if (!filtered.length) {
    list.innerHTML = `<div class="memory-empty">No entries yet. Drop a longer manuscript to extract characters and locations.</div>`;
    return;
  }
  list.innerHTML = filtered.map((e) => {
    const typeLabel = e.type === "people" ? "P" : e.type === "places" ? "L" : "T";
    return `
      <div class="memory-row ${e.locked ? "is-locked" : ""}" data-name="${escapeHtml(e.name)}">
        <span class="memory-row__type memory-row__type--${e.type}" title="${escapeHtml(e.type)}">${typeLabel}</span>
        <div class="memory-row__pair">
          <span class="memory-row__source">${escapeHtml(e.name)} <span style="color:var(--c-parch-3); font-size:11px; margin-left:6px">×${e.count}</span></span>
          <input class="memory-row__target" type="text" value="${escapeHtml(e.translation)}" placeholder="Translation"/>
        </div>
        <button class="memory-row__lock" type="button" title="${e.locked ? "Locked" : "Lock translation"}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            ${e.locked
              ? `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>`
              : `<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v0"/>`}
          </svg>
        </button>
      </div>`;
  }).join("");

  if (!_memoryListWired) {
    list.addEventListener("input", onMemoryInput);
    list.addEventListener("click", onMemoryLockClick);
    _memoryListWired = true;
  }
}
let _memoryListWired = false;

function onMemoryInput(e) {
  const row = e.target.closest(".memory-row");
  if (!row) return;
  if (!e.target.classList.contains("memory-row__target")) return;
  saveMemoryOverride(row.dataset.name, { translation: e.target.value });
}
function onMemoryLockClick(e) {
  const btn = e.target.closest(".memory-row__lock");
  if (!btn) return;
  const row = btn.closest(".memory-row");
  if (!row) return;
  const name = row.dataset.name;
  const entry = currentMemory().find((x) => x.name === name);
  if (!entry) return;
  entry.locked = !entry.locked;
  saveMemoryOverride(name, { locked: entry.locked, translation: entry.translation });
  row.classList.toggle("is-locked", entry.locked);
  toast(entry.locked ? `Locked: ${name}` : `Unlocked: ${name}`);
}

function openMemoryDrawer() {
  const drw = $("#memory-drawer");
  drw.hidden = false;
  // small delay so display:flex applies before transform
  requestAnimationFrame(() => drw.classList.add("is-open"));
  state.memoryOpen = true;
  drw.setAttribute("aria-hidden", "false");
  renderMemoryList();
}
function closeMemoryDrawer() {
  const drw = $("#memory-drawer");
  if (!drw) return;
  drw.classList.remove("is-open");
  drw.setAttribute("aria-hidden", "true");
  setTimeout(() => { drw.hidden = true; }, 320);
  state.memoryOpen = false;
}


/* ════════════════════════ 13. Help overlay ══════════════════════════════ */

function openHelp()  { $("#help-overlay").hidden = false; }
function closeHelp() { $("#help-overlay").hidden = true; }


/* ════════════════════════ 14. Boot ══════════════════════════════════════ */

document.addEventListener("DOMContentLoaded", () => {
  // Sync the html class with the actual auth state — the pre-paint
  // helper only checked localStorage, so this guarantees correctness.
  const isAuthed = !!(state.accessToken && state.user);
  document.documentElement.classList.toggle("is-authed", isAuthed);
  document.documentElement.classList.toggle("is-anon", !isAuthed);

  wireHeroOnce();
  wireStudioOnce();
  renderNav();

  showView(isAuthed ? "hero" : "auth");
});
