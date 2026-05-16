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
 *   5. View routing + workspace switcher
 *   6. Languages + searchable picker
 *   7. Library dashboard (dropzone, paste, history)
 *   8. PDF / DOCX / TXT extraction
 *   9. Document polling
 *  10. Studio workspace (split view, sync scroll, divider)
 *  11. Studio rail (progress ring, tone dial, format lock)
 *  12. Character memory (extraction, drawer, locks)
 *  13. Help overlay
 *  14. Nexus canvas (boards, infinite pan/zoom, nodes, edges, compile)
 *  15. Vault journal (timeline, auto-tag, memory surface)
 *  16. Broadcast publishing (composer, global previews, analytics)
 *  17. Boot
 * ======================================================================= */


/* ════════════════════════ 1. Config & state ═════════════════════════════ */

const API_BASE = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  ? "http://localhost:8001"
  : "https://api.booktwolang.com";

const STORAGE = {
  token:        "btl_access_token_v2",
  user:         "btl_user_v2",
  workspace:    "btl_workspace_v1",
  targetLang:   "btl_target_lang_v2",
  recentLangs:  "btl_recent_langs_v1",
  tone:         "btl_tone_v2",
  formatLock:   "btl_format_lock_v2",
  splitRatio:   "btl_split_ratio_v2",
  memory:       "btl_memory_v2",
  vaultDraft:   "btl_vault_draft_v1",
  broadcastLangs: "btl_broadcast_langs_v1",
};

const WORKSPACES = ["library", "nexus", "vault", "broadcast"];

/* Native-script names. Falls back to the API's English label when missing. */
const NATIVE_NAMES = {
  en: "English",   es: "Español",     fr: "Français",      de: "Deutsch",
  it: "Italiano",  pt: "Português",   nl: "Nederlands",    ru: "Русский",
  pl: "Polski",    uk: "Українська",  tr: "Türkçe",        ar: "العربية",
  he: "עברית",     fa: "فارسی",       ur: "اردو",           hi: "हिन्दी",
  bn: "বাংলা",      ja: "日本語",        ko: "한국어",          zh: "中文",
  "zh-Hant": "繁體中文",   vi: "Tiếng Việt",  th: "ไทย",
  id: "Bahasa Indonesia",  ms: "Bahasa Melayu",
  sv: "Svenska",   no: "Norsk",       da: "Dansk",         fi: "Suomi",
  cs: "Čeština",   el: "Ελληνικά",    ro: "Română",        hu: "Magyar",
};

const POPULAR_CODES = ["en", "es", "fr", "de", "zh", "ja", "ar", "hi", "pt", "ru"];

const TONES = [
  { id: 0, key: "literal",  label: "Literal",  model: "gemini-3-flash-preview", angle: -45 },
  { id: 1, key: "literary", label: "Literary", model: "gemini-3-pro-preview",   angle:   0 },
  { id: 2, key: "academic", label: "Academic", model: "gemini-3-pro-preview",   angle:  45 },
];


const state = {
  view: "auth",                         // 'auth' | 'library' | 'nexus' | 'vault' | 'broadcast' | 'studio'
  workspace: localStorage.getItem(STORAGE.workspace) || "library",
  accessToken: localStorage.getItem(STORAGE.token) || null,
  user: safeParse(localStorage.getItem(STORAGE.user)),

  languages: [],
  targetLang: localStorage.getItem(STORAGE.targetLang) || null,

  // library
  documents: [],
  expandedDocId: null,
  filter: "all",
  pollHandles: new Map(),

  // studio (translation reader)
  studioDocId: null,
  studioMeta: null,
  studioContent: { source: "", translated: "" },
  studioParagraphs: { src: [], tgt: [] },
  splitRatio: clamp(parseFloat(localStorage.getItem(STORAGE.splitRatio) || "0.5"), 0.2, 0.8),
  isSyncing: false,
  cascadedParagraphs: new Set(),
  syncSource: null,

  // controls
  tone: clamp(parseInt(localStorage.getItem(STORAGE.tone) ?? "1", 10), 0, 2),
  formatLock: (localStorage.getItem(STORAGE.formatLock) ?? "1") === "1",
  memoryFilter: "all",
  memoryOpen: false,

  // nexus
  canvases: [],
  nexus: null,            // active canvas {meta, nodes:[], edges:[]}
  nexusViewport: { x: 3000, y: 3000, scale: 1 },  // pan offset (world starts centered)
  nexusSelected: null,    // selected node id
  nexusConnecting: null,  // {fromNodeId, x, y}

  // vault
  vaultEntries: [],
  vaultActive: null,      // active entry id (or null = new)
  vaultDraft: { title: "", body: "", tags: [], mood: null },
  vaultSaveState: "",     // 'saving' | 'saved' | ''
  vaultSurfaces: [],

  // broadcast
  articles: [],
  broadcastActive: null,  // {meta + translations}
  broadcastTab: "compose",
  broadcastLangs: safeParse(localStorage.getItem(STORAGE.broadcastLangs)) || ["es", "fr", "ja"],
  broadcastStats: null,
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
    if (btn.dataset.action === "library") showView("library");
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
    showView("library");
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
    showView("library");
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
  const prev = state.view;
  state.view = view;

  $("#view-auth").hidden      = view !== "auth";
  $("#view-library").hidden   = view !== "library";
  $("#view-nexus").hidden     = view !== "nexus";
  $("#view-vault").hidden     = view !== "vault";
  $("#view-broadcast").hidden = view !== "broadcast";
  $("#view-studio").hidden    = view !== "studio";

  // Topbar visible everywhere except the cinematic auth screen
  $("#topbar").style.display = view === "auth" ? "none" : "";

  // Hide workspace switcher when in studio (sub-view)
  $("#workspace-switcher").style.display = (view === "auth" || view === "studio") ? "none" : "";

  // Persist last workspace
  if (WORKSPACES.includes(view)) {
    state.workspace = view;
    localStorage.setItem(STORAGE.workspace, view);
    updateWorkspaceSwitcher();
  }

  // Lazy-load each workspace on entry
  if (view === "library") {
    await refreshLanguages();
    await refreshDocuments();
  } else if (view === "nexus") {
    await refreshLanguages();
    await refreshCanvases();
  } else if (view === "vault") {
    await refreshLanguages();
    await refreshJournal();
    await refreshSurfaces();
  } else if (view === "broadcast") {
    await refreshLanguages();
    await refreshArticles();
  }

  if (view !== "studio") {
    closeMemoryDrawer();
    state.studioDocId = null;
  }

  // Spatial transition (zoom feel) between top-level workspaces
  if (prev && prev !== view && WORKSPACES.includes(view)) {
    document.body.classList.add("is-warp");
    setTimeout(() => document.body.classList.remove("is-warp"), 360);
  }

  window.scrollTo({ top: 0, behavior: "instant" });
}

function updateWorkspaceSwitcher() {
  const switcher = $("#workspace-switcher");
  if (!switcher) return;
  const pills = $$(".ws-pill", switcher);
  let activePill = null;
  pills.forEach((p) => {
    const isActive = p.dataset.ws === state.workspace;
    p.classList.toggle("is-active", isActive);
    p.setAttribute("aria-selected", isActive ? "true" : "false");
    if (isActive) activePill = p;
  });
  // Move the gold thumb behind the active pill
  if (activePill) {
    const railRect = switcher.getBoundingClientRect();
    const r = activePill.getBoundingClientRect();
    const thumb = $("#ws-switcher-thumb");
    if (thumb) {
      thumb.style.left  = `${r.left - railRect.left}px`;
      thumb.style.width = `${r.width}px`;
    }
  }
}


/* ════════════════════════ 6. Languages + picker ═════════════════════════ */

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

  // Resolve target language (saved → preferred → es)
  const wanted = state.targetLang || state.user?.preferredTargetLang || "es";
  state.targetLang = state.languages.some((l) => l.code === wanted) ? wanted : "es";
  localStorage.setItem(STORAGE.targetLang, state.targetLang);

  // Paste-panel source-language dropdown
  const sourceOpts = `<option value="auto">Auto-detect</option>` +
    state.languages.map((l) => `<option value="${l.code}">${escapeHtml(l.name)}</option>`).join("");
  $("#paste-source-lang").innerHTML = sourceOpts;

  renderLangTrigger();
  renderRecentPills();
}

function setTargetLang(code) {
  if (!code || state.targetLang === code) return;
  if (!state.languages.some((l) => l.code === code)) return;
  state.targetLang = code;
  localStorage.setItem(STORAGE.targetLang, code);
  pushRecentLang(code);
  renderLangTrigger();
  renderRecentPills();
  api("/v1/users/me", { method: "PATCH", body: { preferredTargetLang: code } }).catch(() => {});
}

function renderLangTrigger() {
  const lang = state.languages.find((l) => l.code === state.targetLang);
  if (!lang) return;
  $("#lang-trigger-english").textContent = lang.name;
  const nativeEl = $("#lang-trigger-native");
  const native = NATIVE_NAMES[lang.code];
  if (native && native !== lang.name) {
    nativeEl.textContent = native;
    nativeEl.hidden = false;
  } else {
    nativeEl.textContent = "";
    nativeEl.hidden = true;
  }
}

function getRecentLangs() {
  const stored = safeParse(localStorage.getItem(STORAGE.recentLangs)) || [];
  if (!Array.isArray(stored)) return [];
  return stored.filter((code) => state.languages.some((l) => l.code === code));
}
function pushRecentLang(code) {
  const recent = getRecentLangs();
  const next = [code, ...recent.filter((c) => c !== code)].slice(0, 6);
  localStorage.setItem(STORAGE.recentLangs, JSON.stringify(next));
}

function renderRecentPills() {
  const recents = getRecentLangs().filter((c) => c !== state.targetLang).slice(0, 5);
  const container = $("#lang-recent");
  if (!recents.length) { container.hidden = true; return; }
  container.hidden = false;
  $("#lang-recent-pills").innerHTML = recents.map((code) => {
    const lang = state.languages.find((l) => l.code === code);
    if (!lang) return "";
    const native = NATIVE_NAMES[code];
    return `
      <button class="lang-pill-btn" data-code="${escapeHtml(code)}" type="button" title="${escapeHtml(lang.name)}">
        <span>${escapeHtml(lang.name)}</span>
        ${native && native !== lang.name ? `<em>${escapeHtml(native)}</em>` : ""}
      </button>`;
  }).join("");
}

/* ── Searchable popover ───────────────────────────────────────────────── */

let _langPickerCursor = -1;
let _langPickerResults = [];

function openLangPicker() {
  const pop = $("#lang-popover");
  pop.hidden = false;
  pop.setAttribute("aria-hidden", "false");
  $("#lang-trigger").setAttribute("aria-expanded", "true");
  const search = $("#lang-search");
  search.value = "";
  _langPickerCursor = -1;
  renderLangPickerList("");
  // Scroll active row into view
  setTimeout(() => {
    search.focus();
    const active = $("#lang-popover-list .lang-row.is-active");
    if (active) active.scrollIntoView({ block: "center" });
  }, 30);
  document.addEventListener("keydown", onLangPickerKeydown);
}
function closeLangPicker() {
  const pop = $("#lang-popover");
  if (pop.hidden) return;
  pop.hidden = true;
  pop.setAttribute("aria-hidden", "true");
  $("#lang-trigger").setAttribute("aria-expanded", "false");
  document.removeEventListener("keydown", onLangPickerKeydown);
}

function onLangPickerKeydown(e) {
  if (e.key === "Escape") { e.preventDefault(); closeLangPicker(); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); moveLangCursor(1); return; }
  if (e.key === "ArrowUp")   { e.preventDefault(); moveLangCursor(-1); return; }
  if (e.key === "Enter") {
    e.preventDefault();
    const idx = _langPickerCursor >= 0 ? _langPickerCursor : 0;
    const result = _langPickerResults[idx];
    if (result) { setTargetLang(result.code); closeLangPicker(); }
  }
}
function moveLangCursor(delta) {
  if (!_langPickerResults.length) return;
  if (_langPickerCursor < 0) {
    _langPickerCursor = delta > 0 ? 0 : _langPickerResults.length - 1;
  } else {
    _langPickerCursor = (_langPickerCursor + delta + _langPickerResults.length) % _langPickerResults.length;
  }
  const rows = $$("#lang-popover-list .lang-row");
  rows.forEach((row, i) => row.classList.toggle("is-cursor", i === _langPickerCursor));
  rows[_langPickerCursor]?.scrollIntoView({ block: "nearest" });
}

function normalizeForSearch(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "");
}

function renderLangPickerList(query) {
  const list = $("#lang-popover-list");
  const q = normalizeForSearch(query.trim());
  const all = state.languages.slice();

  if (q) {
    const matches = all.filter((l) => {
      return normalizeForSearch(l.name).includes(q)
          || normalizeForSearch(l.code).includes(q)
          || normalizeForSearch(NATIVE_NAMES[l.code] || "").includes(q);
    }).sort((a, b) => {
      // Prefix matches first, then by name
      const aPre = normalizeForSearch(a.name).startsWith(q) ? 0 : 1;
      const bPre = normalizeForSearch(b.name).startsWith(q) ? 0 : 1;
      if (aPre !== bPre) return aPre - bPre;
      return a.name.localeCompare(b.name);
    });
    _langPickerResults = matches;
    if (!matches.length) {
      list.innerHTML = `<div class="lang-popover__empty">No language matches <em>"${escapeHtml(query)}"</em>.<br/>Try a different name, native script, or ISO code.</div>`;
      return;
    }
    list.innerHTML = matches.map(renderLangRow).join("");
  } else {
    const recents  = getRecentLangs();
    const recentSet = new Set(recents);
    const popular  = POPULAR_CODES
      .filter((c) => state.languages.some((l) => l.code === c) && !recentSet.has(c));
    const popularSet = new Set(popular);
    const rest = all
      .filter((l) => !recentSet.has(l.code) && !popularSet.has(l.code))
      .sort((a, b) => a.name.localeCompare(b.name));

    const sections = [];
    if (recents.length) {
      const langs = recents.map((c) => state.languages.find((l) => l.code === c)).filter(Boolean);
      if (langs.length) sections.push({ label: "Recent", langs });
    }
    if (popular.length) {
      const langs = popular.map((c) => state.languages.find((l) => l.code === c)).filter(Boolean);
      if (langs.length) sections.push({ label: "Popular", langs });
    }
    if (rest.length) sections.push({ label: "All", langs: rest });

    _langPickerResults = sections.flatMap((s) => s.langs);
    list.innerHTML = sections.map((s) => `
      <div class="lang-popover__group">${escapeHtml(s.label)}</div>
      ${s.langs.map(renderLangRow).join("")}
    `).join("");
  }

  // Mark active
  $$("#lang-popover-list .lang-row").forEach((row) => {
    row.classList.toggle("is-active", row.dataset.code === state.targetLang);
  });
}

function renderLangRow(lang) {
  const native = NATIVE_NAMES[lang.code];
  const showNative = native && native !== lang.name;
  return `
    <button class="lang-row" data-code="${escapeHtml(lang.code)}" type="button" role="option">
      <span class="lang-row__english">${escapeHtml(lang.name)}</span>
      <span class="lang-row__native">${showNative ? escapeHtml(native) : ""}</span>
      <span class="lang-row__code">${escapeHtml(lang.code)}</span>
      <span class="lang-row__check">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </span>
    </button>`;
}


/* ════════════════════════ 7. Hero dashboard ═════════════════════════════ */

function wireWorkspaceSwitcher() {
  $("#workspace-switcher").addEventListener("click", (e) => {
    const pill = e.target.closest(".ws-pill");
    if (!pill) return;
    const ws = pill.dataset.ws;
    if (!ws || ws === state.workspace) return;
    showView(ws);
  });
  // Keep the gold thumb aligned on resize
  window.addEventListener("resize", () => requestAnimationFrame(updateWorkspaceSwitcher));
}

function wireHeroOnce() {
  // Auth tabs
  $("#tab-login").addEventListener("click", () => switchAuthTab("login"));
  $("#tab-signup").addEventListener("click", () => switchAuthTab("signup"));

  // Language trigger + popover
  $("#lang-trigger").addEventListener("click", openLangPicker);
  $("#lang-recent").addEventListener("click", (e) => {
    const btn = e.target.closest(".lang-pill-btn");
    if (!btn) return;
    setTargetLang(btn.dataset.code);
  });
  $("#lang-search").addEventListener("input", (e) => {
    _langPickerCursor = -1;
    renderLangPickerList(e.target.value);
  });
  $$("#lang-popover [data-close]").forEach((el) => el.addEventListener("click", closeLangPicker));
  $("#lang-popover-list").addEventListener("click", (e) => {
    const row = e.target.closest(".lang-row");
    if (!row) return;
    setTargetLang(row.dataset.code);
    closeLangPicker();
  });
  $("#lang-popover-list").addEventListener("mousemove", (e) => {
    const row = e.target.closest(".lang-row");
    if (!row) return;
    const rows = $$("#lang-popover-list .lang-row");
    const idx = rows.indexOf(row);
    if (idx >= 0 && idx !== _langPickerCursor) {
      _langPickerCursor = idx;
      rows.forEach((r, i) => r.classList.toggle("is-cursor", i === idx));
    }
  });
  // ⌘K / Ctrl+K shortcut
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      if (state.view !== "library") return;
      const inField = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
      if (inField && e.target.id !== "lang-search") return;
      e.preventDefault();
      openLangPicker();
    }
  });

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
    if (state.user) showView("library"); else showView("auth");
  });

  // Global paste-anywhere shortcut on hero
  document.addEventListener("paste", (e) => {
    if (state.view !== "library") return;
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
  if (state.view !== "library") return;
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
  $("#studio-back").addEventListener("click", () => showView("library"));
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
    showView("library");
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


/* ════════════════════════ 14. NEXUS canvas ══════════════════════════════ */

async function refreshCanvases() {
  try {
    const data = await api("/v1/canvases");
    state.canvases = data.canvases || [];
    renderCanvasesList();
  } catch (err) { console.error(err); }
}

function renderCanvasesList() {
  const grid = $("#nexus-grid");
  const empty = $("#nexus-empty");
  $("#nexus-list").hidden = !!state.nexus;
  $("#nexus-editor").hidden = !state.nexus;
  if (state.nexus) return;
  if (!state.canvases.length) {
    grid.innerHTML = ""; empty.hidden = false; return;
  }
  empty.hidden = true;
  grid.innerHTML = state.canvases.map((c) => {
    // Synthetic preview dots based on canvasId hash
    const dots = [];
    let h = 0; for (let i = 0; i < c.canvasId.length; i++) h = (h * 31 + c.canvasId.charCodeAt(i)) >>> 0;
    const n = Math.min(5, Math.max(2, c.nodeCount || 3));
    for (let i = 0; i < n; i++) {
      h = (h * 1664525 + 1013904223) >>> 0;
      const x = 10 + ((h >>> 0) % 80);
      h = (h * 1664525 + 1013904223) >>> 0;
      const y = 30 + ((h >>> 0) % 50);
      dots.push(`<div class="nexus-card__minihash" style="left:${x}%;top:${y}%"></div>`);
    }
    return `
      <article class="nexus-card" data-id="${c.canvasId}" tabindex="0">
        <div class="nexus-card__preview"></div>
        <div class="nexus-card__nodes">${dots.join("")}</div>
        <h3 class="nexus-card__title">${escapeHtml(c.title || "Untitled canvas")}</h3>
        <div class="nexus-card__meta">
          <span class="mono">${c.nodeCount || 0} nodes</span>
          <span>·</span>
          <span class="mono">${c.edgeCount || 0} edges</span>
          <span>·</span>
          <span>${formatRelative(c.updatedAt || c.createdAt)}</span>
        </div>
      </article>`;
  }).join("");
  $$("#nexus-grid .nexus-card").forEach((el) => {
    el.addEventListener("click", () => openCanvas(el.dataset.id));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") openCanvas(el.dataset.id); });
  });
}

async function createCanvas() {
  try {
    const data = await api("/v1/canvases", { method: "POST", body: { title: "New canvas" } });
    state.canvases.unshift(data);
    await openCanvas(data.canvasId);
  } catch (err) { toast(err.message, "error"); }
}

async function openCanvas(canvasId) {
  try {
    const data = await api(`/v1/canvases/${canvasId}`);
    state.nexus = data;
    state.nexusViewport = { x: 3000, y: 3000, scale: 1 };
    state.nexusSelected = null;
    renderCanvasesList();
    renderCanvasEditor();
  } catch (err) { toast(err.message, "error"); }
}

function closeCanvas() {
  state.nexus = null;
  renderCanvasesList();
}

function renderCanvasEditor() {
  if (!state.nexus) return;
  const c = state.nexus;
  $("#nexus-title").value = c.title || "";
  $("#nexus-node-count").textContent = `${c.nodes.length} node${c.nodes.length === 1 ? "" : "s"}`;
  $("#nexus-edge-count").textContent = `${c.edges.length} edge${c.edges.length === 1 ? "" : "s"}`;
  applyNexusTransform();
  renderNexusNodes();
  renderNexusEdges();
}

function applyNexusTransform() {
  const v = state.nexusViewport;
  const world = $("#nexus-world");
  if (world) world.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.scale})`;
  $("#nexus-zoom-pct").textContent = `${Math.round(v.scale * 100)}%`;
}

function renderNexusNodes() {
  if (!state.nexus) return;
  const host = $("#nexus-nodes");
  const sel = state.nexusSelected;
  host.innerHTML = state.nexus.nodes.map((n) => `
    <div class="nexus-node ${sel === n.nodeId ? "is-selected" : ""}" data-id="${n.nodeId}"
         style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px">
      <div class="nexus-node__head">
        <input class="nexus-node__title" data-action="title" type="text" placeholder="Untitled"
               value="${escapeHtml(n.title || "")}" maxlength="120" />
        <button class="nexus-node__action" data-action="delete" type="button" title="Delete node">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <textarea class="nexus-node__body" data-action="body" placeholder="Write a scene, a character, a quote, a question…">${escapeHtml(n.content || "")}</textarea>
      <span class="nexus-node__port" data-action="port" title="Drag to another node to connect"></span>
    </div>`).join("");
  if (!state.nexus.nodes.length) {
    host.innerHTML = `<div class="nexus-empty-tip"><strong>Begin the sprawl.</strong>Click + Node or double-click the canvas to drop your first thought.</div>`;
  }
}

function renderNexusEdges() {
  if (!state.nexus) return;
  const svg = $("#nexus-edges");
  const nodes = state.nexus.nodes;
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  let paths = "";
  for (const e of state.nexus.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const ax = a.x + a.w;
    const ay = a.y + a.h / 2;
    const bx = b.x;
    const by = b.y + b.h / 2;
    const cx = (ax + bx) / 2;
    const path = `M ${ax} ${ay} C ${cx} ${ay}, ${cx} ${by}, ${bx} ${by}`;
    paths += `<path d="${path}" data-edge="${e.edgeId}" marker-end="url(#nexus-arrow)" />`;
  }
  // Preserve <defs>
  const defs = svg.querySelector("defs");
  svg.innerHTML = "";
  if (defs) svg.appendChild(defs);
  svg.insertAdjacentHTML("beforeend", paths);
}

function wireNexusOnce() {
  $("#nexus-new").addEventListener("click", createCanvas);
  $("#nexus-back").addEventListener("click", closeCanvas);
  $("#nexus-zoom-in").addEventListener("click", () => zoomNexus(1.2));
  $("#nexus-zoom-out").addEventListener("click", () => zoomNexus(1 / 1.2));
  $("#nexus-zoom-reset").addEventListener("click", () => {
    state.nexusViewport = { x: 3000, y: 3000, scale: 1 };
    applyNexusTransform();
  });
  $("#nexus-add-node").addEventListener("click", () => addNode());
  $("#nexus-compile").addEventListener("click", agenticCompile);
  $("#nexus-title").addEventListener("change", (e) => {
    if (!state.nexus) return;
    api(`/v1/canvases/${state.nexus.canvasId}`, { method: "PATCH", body: { title: e.target.value } })
      .then((d) => { state.nexus.title = d.title; refreshCanvases(); })
      .catch((err) => toast(err.message, "error"));
  });

  const canvas = $("#nexus-canvas");
  const world  = $("#nexus-world");

  // Pan (drag empty space) and zoom (wheel)
  let pan = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".nexus-node")) return;
    pan = { x: e.clientX, y: e.clientY, ox: state.nexusViewport.x, oy: state.nexusViewport.y };
    canvas.classList.add("is-panning");
    canvas.setPointerCapture(e.pointerId);
    state.nexusSelected = null;
    renderNexusNodes();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pan) return;
    state.nexusViewport.x = pan.ox + (e.clientX - pan.x);
    state.nexusViewport.y = pan.oy + (e.clientY - pan.y);
    applyNexusTransform();
  });
  canvas.addEventListener("pointerup", (e) => {
    pan = null; canvas.classList.remove("is-panning");
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener("wheel", (e) => {
    if (!state.nexus) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 / 1.1 : 1.1;
    zoomAt(delta, e.clientX, e.clientY);
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => {
    if (e.target.closest(".nexus-node")) return;
    const rect = canvas.getBoundingClientRect();
    const v = state.nexusViewport;
    const wx = (e.clientX - rect.left - v.x) / v.scale - 120;
    const wy = (e.clientY - rect.top  - v.y) / v.scale - 70;
    addNode({ x: wx, y: wy });
  });

  // Node interactions (delegate from world)
  world.addEventListener("pointerdown", onNodePointerDown);
  world.addEventListener("input", onNodeInput);
  world.addEventListener("change", onNodeChange);
  world.addEventListener("click", onNodeClick);
  world.addEventListener("focusin", onNodeFocus);

  // Cancel pending edge on escape
  document.addEventListener("keydown", (e) => {
    if (state.view !== "nexus") return;
    if (e.key === "Escape" && state.nexusConnecting) {
      cancelEdgeConnection();
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      if (state.nexusSelected) {
        e.preventDefault();
        deleteNode(state.nexusSelected);
      }
    }
  });
}

function zoomNexus(factor) {
  const rect = $("#nexus-canvas").getBoundingClientRect();
  zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}
function zoomAt(factor, clientX, clientY) {
  const rect = $("#nexus-canvas").getBoundingClientRect();
  const v = state.nexusViewport;
  const next = clamp(v.scale * factor, 0.25, 2.5);
  const f = next / v.scale;
  // Zoom around the cursor
  v.x = clientX - rect.left - (clientX - rect.left - v.x) * f;
  v.y = clientY - rect.top  - (clientY - rect.top  - v.y) * f;
  v.scale = next;
  applyNexusTransform();
}

async function addNode(pos) {
  if (!state.nexus) return;
  const x = pos?.x ?? (3000 + Math.random() * 100 - 50);
  const y = pos?.y ?? (3000 + Math.random() * 100 - 50);
  try {
    const data = await api(`/v1/canvases/${state.nexus.canvasId}/nodes`, {
      method: "POST",
      body: { x, y, w: 240, h: 160, title: "", content: "" },
    });
    state.nexus.nodes.push(data);
    state.nexusSelected = data.nodeId;
    renderNexusNodes();
    renderNexusEdges();
    // Focus the new node's body for instant typing
    setTimeout(() => {
      const ta = $(`.nexus-node[data-id="${data.nodeId}"] textarea`);
      if (ta) ta.focus();
    }, 30);
    updateCanvasCounts();
  } catch (err) { toast(err.message, "error"); }
}

async function deleteNode(nodeId) {
  if (!state.nexus) return;
  try {
    await api(`/v1/canvases/${state.nexus.canvasId}/nodes/${nodeId}`, { method: "DELETE" });
    state.nexus.nodes = state.nexus.nodes.filter((n) => n.nodeId !== nodeId);
    state.nexus.edges = state.nexus.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
    if (state.nexusSelected === nodeId) state.nexusSelected = null;
    renderNexusNodes();
    renderNexusEdges();
    updateCanvasCounts();
  } catch (err) { toast(err.message, "error"); }
}

function onNodePointerDown(e) {
  const portEl = e.target.closest('[data-action="port"]');
  if (portEl) {
    const nodeEl = portEl.closest(".nexus-node");
    startEdgeConnection(nodeEl.dataset.id, e);
    return;
  }
  const node = e.target.closest(".nexus-node");
  if (!node) return;
  // Ignore drags that start on inputs/buttons inside the node
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "BUTTON") return;
  startNodeDrag(node, e);
}
function onNodeClick(e) {
  const node = e.target.closest(".nexus-node");
  if (!node) return;
  state.nexusSelected = node.dataset.id;
  $$("#nexus-nodes .nexus-node").forEach((n) => n.classList.toggle("is-selected", n.dataset.id === state.nexusSelected));
  // If pending edge, complete it
  if (state.nexusConnecting && state.nexusConnecting.fromNodeId !== node.dataset.id) {
    completeEdgeConnection(node.dataset.id);
  }
  // Delete button
  if (e.target.closest('[data-action="delete"]')) {
    deleteNode(node.dataset.id);
  }
}
function onNodeFocus(e) {
  const node = e.target.closest(".nexus-node");
  if (!node) return;
  state.nexusSelected = node.dataset.id;
}
function onNodeInput(e) {
  const node = e.target.closest(".nexus-node");
  if (!node) return;
  const id = node.dataset.id;
  const meta = state.nexus.nodes.find((n) => n.nodeId === id);
  if (!meta) return;
  if (e.target.dataset.action === "title") meta.title = e.target.value;
  if (e.target.dataset.action === "body")  meta.content = e.target.value;
  scheduleNodePatch(id);
}
function onNodeChange(e) {
  // Force flush patch on blur
  const node = e.target.closest(".nexus-node");
  if (!node) return;
  flushNodePatch(node.dataset.id);
}

const _nodePatchTimers = new Map();
const _nodePatchPending = new Map();
function scheduleNodePatch(nodeId) {
  if (_nodePatchTimers.has(nodeId)) clearTimeout(_nodePatchTimers.get(nodeId));
  _nodePatchTimers.set(nodeId, setTimeout(() => flushNodePatch(nodeId), 600));
}
async function flushNodePatch(nodeId, extra = {}) {
  if (!state.nexus) return;
  const meta = state.nexus.nodes.find((n) => n.nodeId === nodeId);
  if (!meta) return;
  if (_nodePatchTimers.has(nodeId)) { clearTimeout(_nodePatchTimers.get(nodeId)); _nodePatchTimers.delete(nodeId); }
  try {
    await api(`/v1/canvases/${state.nexus.canvasId}/nodes/${nodeId}`, {
      method: "PATCH",
      body: {
        title: meta.title ?? "",
        content: meta.content ?? "",
        x: meta.x, y: meta.y, w: meta.w, h: meta.h,
        ...extra,
      },
    });
  } catch (err) { console.error("node patch", err); }
}

function startNodeDrag(nodeEl, e) {
  const id = nodeEl.dataset.id;
  const meta = state.nexus.nodes.find((n) => n.nodeId === id);
  if (!meta) return;
  const start = { mx: e.clientX, my: e.clientY, x: meta.x, y: meta.y };
  const scale = state.nexusViewport.scale;
  nodeEl.classList.add("is-dragging");
  state.nexusSelected = id;
  $$("#nexus-nodes .nexus-node").forEach((n) => n.classList.toggle("is-selected", n.dataset.id === id));
  e.preventDefault();

  function move(ev) {
    meta.x = start.x + (ev.clientX - start.mx) / scale;
    meta.y = start.y + (ev.clientY - start.my) / scale;
    nodeEl.style.left = `${meta.x}px`;
    nodeEl.style.top  = `${meta.y}px`;
    renderNexusEdges();
  }
  function up() {
    nodeEl.classList.remove("is-dragging");
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    flushNodePatch(id);
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

function startEdgeConnection(fromId, e) {
  state.nexusConnecting = { fromNodeId: fromId };
  $("#nexus-canvas").classList.add("is-connecting");
  const svg = $("#nexus-pending-edge");
  svg.hidden = false;
  e.preventDefault();
  function move(ev) {
    const fromNode = state.nexus.nodes.find((n) => n.nodeId === fromId);
    if (!fromNode) return;
    const rect = $("#nexus-canvas").getBoundingClientRect();
    const v = state.nexusViewport;
    const fx = fromNode.x + fromNode.w;
    const fy = fromNode.y + fromNode.h / 2;
    const tx = (ev.clientX - rect.left - v.x) / v.scale;
    const ty = (ev.clientY - rect.top  - v.y) / v.scale;
    const cx = (fx + tx) / 2;
    svg.innerHTML = `<path d="M ${fx} ${fy} C ${cx} ${fy}, ${cx} ${ty}, ${tx} ${ty}" />`;
  }
  function up(ev) {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    const elAt = document.elementFromPoint(ev.clientX, ev.clientY);
    const toNode = elAt?.closest?.(".nexus-node");
    if (toNode && toNode.dataset.id !== fromId) {
      completeEdgeConnection(toNode.dataset.id);
    } else {
      cancelEdgeConnection();
    }
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}
function cancelEdgeConnection() {
  state.nexusConnecting = null;
  $("#nexus-canvas").classList.remove("is-connecting");
  $("#nexus-pending-edge").innerHTML = "";
  $("#nexus-pending-edge").hidden = true;
}
async function completeEdgeConnection(toNodeId) {
  if (!state.nexusConnecting || !state.nexus) { cancelEdgeConnection(); return; }
  const from = state.nexusConnecting.fromNodeId;
  cancelEdgeConnection();
  try {
    const data = await api(`/v1/canvases/${state.nexus.canvasId}/edges`, {
      method: "POST",
      body: { fromNodeId: from, toNodeId },
    });
    state.nexus.edges.push(data);
    renderNexusEdges();
    updateCanvasCounts();
  } catch (err) { toast(err.message, "error"); }
}

function updateCanvasCounts() {
  if (!state.nexus) return;
  $("#nexus-node-count").textContent = `${state.nexus.nodes.length} node${state.nexus.nodes.length === 1 ? "" : "s"}`;
  $("#nexus-edge-count").textContent = `${state.nexus.edges.length} edge${state.nexus.edges.length === 1 ? "" : "s"}`;
}

async function agenticCompile() {
  if (!state.nexus) return;
  if (!state.nexus.nodes.length) { toast("Add some nodes first", "error"); return; }
  const btn = $("#nexus-compile");
  btn.disabled = true;
  btn.classList.add("is-loading");
  const body = $("#nexus-panel-body");
  body.innerHTML = `
    <div class="nexus-panel__placeholder">
      <span class="spinner" style="width:24px;height:24px;border-width:3px"></span>
      <p><em>Compiling…</em><br/>Threading your nodes into a draft.</p>
    </div>`;
  try {
    const data = await api(`/v1/canvases/${state.nexus.canvasId}/compile`, { method: "POST" });
    renderNexusCompiled(data);
    toast("Compile complete", "success");
  } catch (err) {
    body.innerHTML = `<div class="nexus-panel__placeholder"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg><p>${escapeHtml(err.message)}</p></div>`;
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }
}

function renderNexusCompiled(data) {
  const body = $("#nexus-panel-body");
  const foot = $("#nexus-panel-foot");
  state.nexusCompiled = data;
  const draft = data.draft || "";
  const html = `
    <section class="nexus-outline">
      <p class="micro-label" style="margin-bottom:8px">Outline</p>
      <ol>
        ${(data.outline || []).map((o) => `
          <li>
            <span></span>
            <div>
              <h5>${escapeHtml(o.heading || "(untitled)")}</h5>
              <p>${escapeHtml(o.summary || "")}</p>
            </div>
          </li>`).join("")}
      </ol>
    </section>
    <section>
      <p class="micro-label" style="margin-bottom:8px">First draft</p>
      <div class="nexus-draft">${markdownToHtml(draft)}</div>
    </section>`;
  body.innerHTML = html;
  foot.hidden = false;
}

function markdownToHtml(md) {
  // Minimal Markdown: # headings, paragraphs, bold/italic, lists
  const safe = escapeHtml(md);
  let html = safe
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm,  "<h2>$1</h2>")
    .replace(/^# (.+)$/gm,   "<h1>$1</h1>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html
    .split(/\n{2,}/)
    .map((blk) => blk.startsWith("<h") ? blk : `<p>${blk.replace(/\n/g, "<br/>")}</p>`)
    .join("");
}


/* ════════════════════════ 15. VAULT journal ═════════════════════════════ */

async function refreshJournal() {
  try {
    const data = await api("/v1/journal/entries?limit=120");
    state.vaultEntries = data.entries || [];
    renderVaultTimeline();
    // If no entry is currently being composed, hydrate from the most recent
    if (!state.vaultActive && state.vaultEntries.length) {
      loadVaultEntry(state.vaultEntries[0].entryId);
    } else if (!state.vaultEntries.length) {
      resetVaultDraft();
      renderVaultEditor();
    }
  } catch (err) { console.error(err); }
}

async function refreshSurfaces() {
  try {
    const data = await api("/v1/journal/surface");
    state.vaultSurfaces = data.surfaces || [];
    // Show the freshest one once per visit
    if (state.vaultSurfaces.length) {
      const next = state.vaultSurfaces[0];
      showVaultSurface(next);
    }
  } catch (err) { console.error(err); }
}

function showVaultSurface(s) {
  if (!s?.entry) return;
  $("#vault-surface-reason").textContent = s.reason || "Memory";
  $("#vault-surface-title").textContent = s.entry.title || "Untitled entry";
  $("#vault-surface-preview").textContent = (s.entry.body || "").slice(0, 200);
  $("#vault-surface").hidden = false;
  $("#vault-surface-open").onclick = () => {
    $("#vault-surface").hidden = true;
    loadVaultEntry(s.entry.entryId);
  };
}

function renderVaultTimeline() {
  const list = $("#vault-timeline-list");
  if (!state.vaultEntries.length) {
    list.innerHTML = `<div class="library__empty" style="margin:14px;padding:20px;font-size:12px">Your vault is empty. Click <em>New</em> above and start writing.</div>`;
    return;
  }
  // Group by month label
  const groups = new Map();
  for (const e of state.vaultEntries) {
    const d = new Date(e.createdAt);
    const key = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  let html = "";
  for (const [month, entries] of groups) {
    html += `<div class="vault-month">${escapeHtml(month)}</div>`;
    for (const e of entries) {
      const d = new Date(e.createdAt);
      const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const isActive = state.vaultActive === e.entryId;
      const title = e.title || (e.body || "").slice(0, 60).trim() || "(untitled)";
      const tags = (e.tags || []).slice(0, 3);
      html += `
        <button class="vault-entry ${isActive ? "is-active" : ""}" data-id="${e.entryId}" type="button">
          <span class="vault-entry__date">${escapeHtml(date)}</span>
          <span class="vault-entry__title">${escapeHtml(title.slice(0, 60))}</span>
          <span class="vault-entry__excerpt">${escapeHtml((e.body || "").slice(0, 80))}</span>
          ${tags.length ? `<span class="vault-entry__tags">${tags.map((t) => `<span class="vault-entry__tag">${escapeHtml(t)}</span>`).join("")}</span>` : ""}
        </button>`;
    }
  }
  list.innerHTML = html;
}

function loadVaultEntry(entryId) {
  const e = state.vaultEntries.find((x) => x.entryId === entryId);
  if (!e) return;
  state.vaultActive = entryId;
  state.vaultDraft = {
    title: e.title || "",
    body:  e.body  || "",
    tags:  e.tags || [],
    mood:  e.mood,
  };
  renderVaultEditor();
  renderVaultTimeline();
}

function resetVaultDraft() {
  state.vaultActive = null;
  state.vaultDraft = { title: "", body: "", tags: [], mood: null };
}

function renderVaultEditor() {
  $("#vault-title").value = state.vaultDraft.title || "";
  $("#vault-body").value  = state.vaultDraft.body  || "";
  renderVaultChips();
  updateVaultWords();
}

function renderVaultChips() {
  const tagHost = $("#vault-tags");
  const moodEl = $("#vault-mood");
  tagHost.innerHTML = (state.vaultDraft.tags || []).map((t) => `<span class="vault-tags__pill">#${escapeHtml(t)}</span>`).join("");
  if (state.vaultDraft.mood) {
    moodEl.textContent = `mood · ${state.vaultDraft.mood}`;
    moodEl.hidden = false;
  } else {
    moodEl.hidden = true;
  }
  updateVaultSaveState(state.vaultSaveState);
}

function updateVaultSaveState(s) {
  state.vaultSaveState = s;
  const el = $("#vault-save");
  el.classList.remove("is-saving", "is-saved");
  if (s === "saving") { el.textContent = "saving…"; el.classList.add("is-saving"); }
  else if (s === "saved") { el.textContent = "saved"; el.classList.add("is-saved"); }
  else el.textContent = "";
}

function updateVaultWords() {
  const text = $("#vault-body").value || "";
  const words = (text.match(/\S+/g) || []).length;
  const el = $("#vault-words");
  el.textContent = `${words.toLocaleString()} word${words === 1 ? "" : "s"}`;
  el.classList.toggle("is-glowing", words > 200);
}

let _vaultSaveTimer = null;
function scheduleVaultSave() {
  if (_vaultSaveTimer) clearTimeout(_vaultSaveTimer);
  updateVaultSaveState("saving");
  _vaultSaveTimer = setTimeout(flushVaultSave, 900);
}

async function flushVaultSave() {
  _vaultSaveTimer = null;
  const draft = state.vaultDraft;
  const body = ($("#vault-body").value || "").trim();
  const title = ($("#vault-title").value || "").trim();
  if (!body && !title) { updateVaultSaveState(""); return; }

  draft.title = title;
  draft.body  = body;

  try {
    if (!state.vaultActive) {
      const data = await api("/v1/journal/entries", {
        method: "POST",
        body: { title, body, autotag: true },
      });
      state.vaultActive = data.entryId;
      state.vaultDraft.tags = data.tags || [];
      state.vaultDraft.mood = data.mood;
      state.vaultEntries.unshift(data);
    } else {
      const data = await api(`/v1/journal/entries/${state.vaultActive}`, {
        method: "PATCH",
        body: { title, body, retag: true },
      });
      state.vaultDraft.tags = data.tags || [];
      state.vaultDraft.mood = data.mood;
      const idx = state.vaultEntries.findIndex((e) => e.entryId === state.vaultActive);
      if (idx >= 0) state.vaultEntries[idx] = data;
    }
    renderVaultChips();
    renderVaultTimeline();
    updateVaultSaveState("saved");
    // Poll once more to pick up async auto-tags
    setTimeout(refreshVaultActive, 4000);
  } catch (err) {
    toast(err.message, "error");
    updateVaultSaveState("");
  }
}

async function refreshVaultActive() {
  if (!state.vaultActive) return;
  try {
    const data = await api(`/v1/journal/entries/${state.vaultActive}`);
    state.vaultDraft.tags = data.tags || [];
    state.vaultDraft.mood = data.mood;
    const idx = state.vaultEntries.findIndex((e) => e.entryId === state.vaultActive);
    if (idx >= 0) state.vaultEntries[idx] = data;
    renderVaultChips();
    renderVaultTimeline();
  } catch (err) { /* swallow */ }
}

function wireVaultOnce() {
  $("#vault-new").addEventListener("click", () => {
    if (_vaultSaveTimer) flushVaultSave();
    resetVaultDraft();
    renderVaultEditor();
    renderVaultTimeline();
    setTimeout(() => $("#vault-title").focus(), 30);
  });
  $("#vault-timeline-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".vault-entry");
    if (btn) loadVaultEntry(btn.dataset.id);
  });
  ["input"].forEach((ev) => {
    $("#vault-title").addEventListener(ev, scheduleVaultSave);
    $("#vault-body").addEventListener(ev, () => { updateVaultWords(); scheduleVaultSave(); });
  });
  $("#vault-surface-close").addEventListener("click", () => { $("#vault-surface").hidden = true; });

  // Flush on tab away
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && _vaultSaveTimer) flushVaultSave();
  });
  window.addEventListener("beforeunload", () => { if (_vaultSaveTimer) flushVaultSave(); });
}


/* ════════════════════════ 16. BROADCAST publishing ══════════════════════ */

async function refreshArticles() {
  try {
    const data = await api("/v1/articles");
    state.articles = data.articles || [];
    renderArticlesList();
  } catch (err) { console.error(err); }
}

function renderArticlesList() {
  $("#broadcast-list").hidden = !!state.broadcastActive;
  $("#broadcast-composer").hidden = !state.broadcastActive;
  if (state.broadcastActive) return;
  const grid = $("#broadcast-grid");
  const empty = $("#broadcast-empty");
  if (!state.articles.length) {
    grid.innerHTML = ""; empty.hidden = false; return;
  }
  empty.hidden = true;
  grid.innerHTML = state.articles.map((a) => {
    const langs = (a.languages || []).slice(0, 5);
    return `
      <article class="broadcast-card" data-id="${a.articleId}" tabindex="0">
        <div class="broadcast-card__cover">${escapeHtml(a.coverEmoji || "✦")}</div>
        <div class="broadcast-card__main">
          <h3 class="broadcast-card__title">${escapeHtml(a.title || "Untitled")}</h3>
          <div class="broadcast-card__meta">
            <span>${a.status === "published" ? `<span class="lang-pill lang-pill--gold">Live</span>` : `<span class="lang-pill">Draft</span>`}</span>
            <span class="mono">${(a.wordCount || 0).toLocaleString()} words</span>
            ${langs.length ? `<span>·</span><span class="mono">${escapeHtml(langs.join(" · "))}</span>` : ""}
            <span>·</span><span>${formatRelative(a.updatedAt || a.createdAt)}</span>
          </div>
          ${a.subtitle ? `<p class="broadcast-card__excerpt">${escapeHtml(a.subtitle)}</p>` : ""}
        </div>
      </article>`;
  }).join("");
  $$("#broadcast-grid .broadcast-card").forEach((el) => {
    el.addEventListener("click", () => openArticle(el.dataset.id));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") openArticle(el.dataset.id); });
  });
}

async function createArticle() {
  try {
    const data = await api("/v1/articles", { method: "POST", body: { title: "Untitled draft", body: "" } });
    state.articles.unshift(data);
    await openArticle(data.articleId);
  } catch (err) { toast(err.message, "error"); }
}

async function openArticle(articleId) {
  try {
    const data = await api(`/v1/articles/${articleId}`);
    state.broadcastActive = data;
    state.broadcastTab = "compose";
    renderArticlesList();
    renderComposer();
  } catch (err) { toast(err.message, "error"); }
}

function closeArticle() {
  if (_broadcastSaveTimer) flushBroadcastSave();
  state.broadcastActive = null;
  state.broadcastStats = null;
  renderArticlesList();
}

function renderComposer() {
  const a = state.broadcastActive;
  if (!a) return;
  $("#broadcast-emoji").textContent = a.coverEmoji || "✦";
  $("#broadcast-title").value = a.title || "";
  $("#broadcast-subtitle").value = a.subtitle || "";
  $("#broadcast-body").value = a.body || "";
  $("#broadcast-status").textContent = a.status === "published" ? "Published" : "Draft";
  $("#broadcast-status").classList.toggle("broadcast-status--published", a.status === "published");
  $("#broadcast-status").classList.toggle("broadcast-status--draft", a.status !== "published");
  $("#broadcast-publish").innerHTML = a.status === "published"
    ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12l5 5L20 7"/></svg><span>Republish</span>'
    : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12l5 5L20 7"/></svg><span>Publish</span>';
  $("#broadcast-unpublish").hidden = a.status !== "published";
  switchBroadcastTab(state.broadcastTab);
}

function switchBroadcastTab(tab) {
  state.broadcastTab = tab;
  $$(".broadcast-bar__tabs .ws-pill").forEach((p) => p.classList.toggle("is-active", p.dataset.tab === tab));
  $("#broadcast-tab-compose").hidden = tab !== "compose";
  $("#broadcast-tab-global").hidden  = tab !== "global";
  $("#broadcast-tab-stats").hidden   = tab !== "stats";
  if (tab === "global") {
    renderGlobalPicker();
    renderPreviews();
  }
  if (tab === "stats") {
    loadStats();
  }
}

let _broadcastSaveTimer = null;
function scheduleBroadcastSave() {
  if (_broadcastSaveTimer) clearTimeout(_broadcastSaveTimer);
  $("#broadcast-save-state").textContent = "saving…";
  $("#broadcast-save-state").classList.remove("is-saved");
  $("#broadcast-save-state").classList.add("is-saving");
  _broadcastSaveTimer = setTimeout(flushBroadcastSave, 900);
}
async function flushBroadcastSave() {
  _broadcastSaveTimer = null;
  const a = state.broadcastActive;
  if (!a) return;
  const updates = {
    title:      $("#broadcast-title").value,
    subtitle:   $("#broadcast-subtitle").value,
    body:       $("#broadcast-body").value,
    coverEmoji: $("#broadcast-emoji").textContent || "✦",
  };
  try {
    const data = await api(`/v1/articles/${a.articleId}`, { method: "PATCH", body: updates });
    Object.assign(state.broadcastActive, data);
    const idx = state.articles.findIndex((x) => x.articleId === a.articleId);
    if (idx >= 0) state.articles[idx] = { ...state.articles[idx], ...data };
    $("#broadcast-save-state").textContent = "saved";
    $("#broadcast-save-state").classList.remove("is-saving");
    $("#broadcast-save-state").classList.add("is-saved");
  } catch (err) {
    toast(err.message, "error");
    $("#broadcast-save-state").textContent = "";
  }
}

const BROADCAST_LANG_OPTIONS = ["es", "fr", "de", "it", "pt", "ar", "ja", "ko", "zh", "hi", "tr", "ru"];

function renderGlobalPicker() {
  const host = $("#broadcast-langs");
  const active = new Set(state.broadcastLangs);
  host.innerHTML = BROADCAST_LANG_OPTIONS.map((code) => {
    const lang = state.languages.find((l) => l.code === code);
    const glyph = (NATIVE_NAMES[code] || lang?.name || code).slice(0, 4);
    return `
      <button class="broadcast-lang ${active.has(code) ? "is-on" : ""}" data-code="${code}" type="button" title="${escapeHtml(lang?.name || code)}">
        <span class="broadcast-lang__glyph">${escapeHtml(glyph)}</span>
        <span class="broadcast-lang__code">${escapeHtml(code)}</span>
      </button>`;
  }).join("");
  $$("#broadcast-langs .broadcast-lang").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.code;
      const set = new Set(state.broadcastLangs);
      if (set.has(code)) set.delete(code); else set.add(code);
      state.broadcastLangs = Array.from(set);
      localStorage.setItem(STORAGE.broadcastLangs, JSON.stringify(state.broadcastLangs));
      btn.classList.toggle("is-on", set.has(code));
    });
  });
}

const RTL_CODES = new Set(["ar", "fa", "he", "ur"]);

function renderPreviews() {
  const host = $("#broadcast-previews");
  const a = state.broadcastActive;
  if (!a) { host.innerHTML = ""; return; }
  const translations = new Map((a.translations || []).map((t) => [t.lang, t]));

  const all = [["__source__", null], ...state.broadcastLangs.map((c) => [c, c])];
  host.innerHTML = all.map(([key, code]) => {
    if (key === "__source__") {
      return previewCard({
        code: a.sourceLang === "auto" ? "src" : a.sourceLang,
        title: a.title, subtitle: a.subtitle, body: a.body,
        nativeName: "Source",
        rtl: false,
      });
    }
    const t = translations.get(code);
    if (!t || t.status === "translating") {
      return previewCard({
        code, nativeName: NATIVE_NAMES[code] || code,
        title: "Translating…", subtitle: "", body: "Threading sentences across the world.",
        rtl: RTL_CODES.has(code), state: "translating",
      });
    }
    if (t.status === "failed") {
      return previewCard({
        code, nativeName: NATIVE_NAMES[code] || code,
        title: t.title || a.title, subtitle: "", body: "Translation failed.",
        rtl: RTL_CODES.has(code), state: "failed",
      });
    }
    return previewCard({
      code, nativeName: NATIVE_NAMES[code] || code,
      title: t.title || a.title, subtitle: t.subtitle || "", body: t.body || "",
      rtl: RTL_CODES.has(code),
    });
  }).join("");
}

function previewCard({ code, nativeName, title, subtitle, body, rtl, state: cardState }) {
  const cls = cardState === "translating" ? "is-translating" : cardState === "failed" ? "is-failed" : "";
  return `
    <article class="broadcast-preview ${cls} ${rtl ? "is-rtl" : ""}">
      <header class="broadcast-preview__head">
        <span class="broadcast-preview__lang">${escapeHtml(code)}</span>
        <span class="broadcast-preview__native">${escapeHtml(nativeName)}</span>
      </header>
      <div class="broadcast-preview__cover">${escapeHtml(state.broadcastActive?.coverEmoji || "✦")}</div>
      <h3 class="broadcast-preview__title">${escapeHtml(title || "")}</h3>
      ${subtitle ? `<p class="broadcast-preview__subtitle">${escapeHtml(subtitle)}</p>` : ""}
      <div class="broadcast-preview__body">${escapeHtml((body || "").slice(0, 800))}</div>
    </article>`;
}

async function translatePreviews() {
  const a = state.broadcastActive;
  if (!a) return;
  if (!state.broadcastLangs.length) { toast("Pick at least one language", "error"); return; }
  // Flush any pending body save first
  if (_broadcastSaveTimer) await flushBroadcastSave();
  const btn = $("#broadcast-translate");
  btn.disabled = true;
  try {
    await api(`/v1/articles/${a.articleId}/translate`, {
      method: "POST",
      body: { targetLangs: state.broadcastLangs, model: TONES[state.tone].model },
    });
    // Optimistically mark languages as translating
    state.broadcastActive.translations = state.broadcastLangs.map((c) => ({ lang: c, status: "translating" }));
    renderPreviews();
    pollArticle(a.articleId);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

const _articlePollHandles = new Map();
function pollArticle(articleId) {
  if (_articlePollHandles.has(articleId)) clearTimeout(_articlePollHandles.get(articleId));
  const tick = async () => {
    try {
      const data = await api(`/v1/articles/${articleId}`);
      if (state.broadcastActive?.articleId === articleId) {
        Object.assign(state.broadcastActive, data);
        renderPreviews();
      }
      const pending = (data.translations || []).filter((t) => t.status === "translating").length;
      if (pending === 0) {
        _articlePollHandles.delete(articleId);
        toast("Previews ready", "success");
        return;
      }
    } catch (err) { console.error(err); }
    _articlePollHandles.set(articleId, setTimeout(tick, 2200));
  };
  _articlePollHandles.set(articleId, setTimeout(tick, 1200));
}

async function publishArticle() {
  const a = state.broadcastActive;
  if (!a) return;
  if (!($("#broadcast-body").value || "").trim()) { toast("Write something first", "error"); return; }
  if (_broadcastSaveTimer) await flushBroadcastSave();
  try {
    const data = await api(`/v1/articles/${a.articleId}/publish`, { method: "POST" });
    Object.assign(state.broadcastActive, data);
    const idx = state.articles.findIndex((x) => x.articleId === a.articleId);
    if (idx >= 0) state.articles[idx] = { ...state.articles[idx], ...data };
    renderComposer();
    toast(`Live at ${data.publicUrl || "/r/" + data.slug}`, "success");
  } catch (err) { toast(err.message, "error"); }
}

async function unpublishArticle() {
  const a = state.broadcastActive;
  if (!a) return;
  try {
    const data = await api(`/v1/articles/${a.articleId}/unpublish`, { method: "POST" });
    Object.assign(state.broadcastActive, data);
    renderComposer();
    toast("Article unpublished");
  } catch (err) { toast(err.message, "error"); }
}

async function deleteArticle() {
  const a = state.broadcastActive;
  if (!a) return;
  if (!confirm(`Delete "${a.title || "this article"}" permanently?`)) return;
  try {
    await api(`/v1/articles/${a.articleId}`, { method: "DELETE" });
    state.articles = state.articles.filter((x) => x.articleId !== a.articleId);
    state.broadcastActive = null;
    renderArticlesList();
    toast("Article deleted");
  } catch (err) { toast(err.message, "error"); }
}

async function loadStats() {
  const a = state.broadcastActive;
  if (!a) return;
  try {
    const data = await api(`/v1/articles/${a.articleId}/stats`);
    state.broadcastStats = data;
    renderStats(data);
  } catch (err) { toast(err.message, "error"); }
}

function renderStats(s) {
  $("#stats-total").textContent     = (s.totalViews || 0).toLocaleString();
  $("#stats-unique").textContent    = (s.uniqueReaders || 0).toLocaleString();
  $("#stats-avgread").textContent   = (s.avgReadMinutes || 0).toFixed(1) + "m";
  $("#stats-completion").textContent= (s.completionRate || 0).toFixed(0) + "%";
  $("#stats-trend").textContent = s.status === "published" ? "↗ live" : "draft — synthetic preview";

  const series = s.series || [];
  const max = Math.max(1, ...series.map((d) => d.views || 0));
  $("#stats-chart").innerHTML = series.map((d) => {
    const h = Math.max(4, Math.round((d.views / max) * 100));
    return `<div class="stats-chart__bar" style="height:${h}%" data-tip="${escapeHtml(d.date)} · ${d.views} views"></div>`;
  }).join("");

  const geo = s.byCountry || [];
  const gmax = Math.max(1, ...geo.map((g) => g.views));
  $("#stats-geo").innerHTML = geo.map((g) => {
    const intensity = (g.views / gmax);
    const bg = `rgba(232,192,99,${(0.05 + intensity * 0.18).toFixed(3)})`;
    const border = `rgba(232,192,99,${(0.18 + intensity * 0.35).toFixed(3)})`;
    const glow = `rgba(232,192,99,${(0.15 + intensity * 0.45).toFixed(3)})`;
    return `
      <div class="stats-geo__cell" style="--cell-bg:${bg};--cell-border:${border};--cell-glow:${glow}">
        <span class="stats-geo__country">${escapeHtml(g.country)}</span>
        <strong class="stats-geo__views">${g.views.toLocaleString()}</strong>
      </div>`;
  }).join("");
}

const EMOJI_POOL = ["✦", "✧", "❋", "❉", "✺", "✿", "❀", "✶", "✷", "✤", "☾", "☉", "⚘", "❄", "❃", "❂"];
function cycleEmoji() {
  const cur = $("#broadcast-emoji").textContent || "✦";
  const idx = EMOJI_POOL.indexOf(cur);
  const next = EMOJI_POOL[(idx + 1) % EMOJI_POOL.length];
  $("#broadcast-emoji").textContent = next;
  scheduleBroadcastSave();
}

function wireBroadcastOnce() {
  $("#broadcast-new").addEventListener("click", createArticle);
  $("#broadcast-back").addEventListener("click", closeArticle);
  $("#broadcast-emoji").addEventListener("click", cycleEmoji);
  ["input"].forEach((ev) => {
    $("#broadcast-title").addEventListener(ev, scheduleBroadcastSave);
    $("#broadcast-subtitle").addEventListener(ev, scheduleBroadcastSave);
    $("#broadcast-body").addEventListener(ev, scheduleBroadcastSave);
  });
  $$(".broadcast-bar__tabs .ws-pill").forEach((p) => p.addEventListener("click", () => switchBroadcastTab(p.dataset.tab)));
  $("#broadcast-translate").addEventListener("click", translatePreviews);
  $("#broadcast-publish").addEventListener("click", publishArticle);
  $("#broadcast-unpublish").addEventListener("click", unpublishArticle);
  $("#broadcast-delete").addEventListener("click", deleteArticle);
}


/* ════════════════════════ 17. Boot ══════════════════════════════════════ */

document.addEventListener("DOMContentLoaded", () => {
  const isAuthed = !!(state.accessToken && state.user);
  document.documentElement.classList.toggle("is-authed", isAuthed);
  document.documentElement.classList.toggle("is-anon", !isAuthed);

  wireHeroOnce();
  wireStudioOnce();
  wireWorkspaceSwitcher();
  wireNexusOnce();
  wireVaultOnce();
  wireBroadcastOnce();
  renderNav();

  if (!isAuthed) {
    showView("auth");
  } else {
    const startView = WORKSPACES.includes(state.workspace) ? state.workspace : "library";
    showView(startView);
  }
});
