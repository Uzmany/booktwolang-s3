/* BookTwoLang client.
 *
 * Talks to https://api.booktwolang.com in production and http://localhost:8001
 * during local development. Access tokens live in localStorage; everything
 * else is fetched on demand from the API.
 *
 * Interaction model: pick a target language once, then drop / pick / paste —
 * each translation kicks off automatically and appears as a card below.
 */

const API_BASE = location.hostname === "localhost" || location.hostname === "127.0.0.1"
  ? "http://localhost:8001"
  : "https://api.booktwolang.com";

const TOKEN_KEY = "booktwolang_access_token_v1";
const USER_KEY = "booktwolang_user_v1";
const TARGET_LANG_KEY = "booktwolang_target_lang_v1";

const state = {
  accessToken: localStorage.getItem(TOKEN_KEY) || null,
  user: JSON.parse(localStorage.getItem(USER_KEY) || "null"),
  documents: [],
  languages: [],
  targetLang: localStorage.getItem(TARGET_LANG_KEY) || null,
  expandedDocId: null,
  pollHandles: new Map(),
  contentCache: new Map(),
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ─────────────────────────── API helper ─────────────────────────────────

async function api(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { ...headers } };
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
    renderNav();
    showAuth();
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

// ─────────────────────────── Auth + nav ─────────────────────────────────

function setAuth(token, user) {
  state.accessToken = token;
  state.user = user;
  if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user)); else localStorage.removeItem(USER_KEY);
}

function renderNav() {
  const nav = $("#nav-actions");
  if (!state.user) { nav.innerHTML = ""; return; }
  const initials = (state.user.displayName || state.user.email || "?").trim().slice(0, 2).toUpperCase();
  nav.innerHTML = `
    <button id="profile-btn" class="flex items-center gap-2 pl-2 pr-1 py-1 rounded-full border border-white/[0.08] hover:bg-white/[0.04] transition-colors">
      <span class="hidden sm:inline text-zinc-300 text-sm max-w-[150px] truncate">${escapeHtml(state.user.displayName || state.user.email)}</span>
      <span class="grid place-items-center w-7 h-7 rounded-full bg-brand-500/15 text-brand-300 text-xs font-medium">${escapeHtml(initials)}</span>
    </button>`;
  $("#profile-btn").addEventListener("click", () => {
    if (confirm("Log out?")) handleLogout();
  });
}

function showAuth() {
  $("#view-auth").hidden = false;
  $("#view-app").hidden = true;
}

async function showApp() {
  $("#view-auth").hidden = true;
  $("#view-app").hidden = false;
  await refreshLanguages();
  await refreshDocuments();
}

$("#tab-login").addEventListener("click", () => switchAuthTab("login"));
$("#tab-signup").addEventListener("click", () => switchAuthTab("signup"));

function switchAuthTab(which) {
  const login = which === "login";
  $("#tab-login").className = `flex-1 px-3 py-1.5 rounded-md transition-colors ${login ? "text-white bg-white/[0.06]" : "text-zinc-400 hover:text-white"}`;
  $("#tab-signup").className = `flex-1 px-3 py-1.5 rounded-md transition-colors ${!login ? "text-white bg-white/[0.06]" : "text-zinc-400 hover:text-white"}`;
  $("#form-login").hidden = !login;
  $("#form-signup").hidden = login;
}

window.handleLogin = async () => {
  const form = $("#form-login");
  $("#login-error").hidden = true;
  try {
    const data = await api("/v1/auth/login", {
      method: "POST",
      body: { email: form.email.value.trim(), password: form.password.value },
    });
    setAuth(data.accessToken, data.user);
    if (data.user?.preferredTargetLang && !state.targetLang) {
      state.targetLang = data.user.preferredTargetLang;
      localStorage.setItem(TARGET_LANG_KEY, state.targetLang);
    }
    renderNav();
    showApp();
  } catch (err) {
    const el = $("#login-error");
    el.textContent = err.message;
    el.hidden = false;
  }
};

window.handleSignup = async () => {
  const form = $("#form-signup");
  $("#signup-error").hidden = true;
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
    renderNav();
    showApp();
  } catch (err) {
    const el = $("#signup-error");
    el.textContent = err.message;
    el.hidden = false;
  }
};

async function handleLogout() {
  try { await api("/v1/auth/logout", { method: "POST" }); } catch (_) {}
  setAuth(null, null);
  for (const id of state.pollHandles.keys()) clearPoll(id);
  state.documents = [];
  state.contentCache.clear();
  renderNav();
  showAuth();
}

// ─────────────────────────── Languages ──────────────────────────────────

async function refreshLanguages() {
  if (state.languages.length) {
    populateLanguageSelectors();
    return;
  }
  try {
    const data = await api("/v1/languages");
    state.languages = data.languages;
    populateLanguageSelectors();
  } catch (err) {
    console.error("Could not load languages", err);
  }
}

function populateLanguageSelectors() {
  const targetOptions = state.languages.map((l) => `<option value="${l.code}">${escapeHtml(l.name)}</option>`).join("");
  const sourceOptions = `<option value="auto">Auto-detect</option>` + targetOptions;
  $("#global-target-lang").innerHTML = targetOptions;
  $("#paste-source-lang").innerHTML = sourceOptions;

  const wanted = state.targetLang || state.user?.preferredTargetLang || "es";
  if (state.languages.some((l) => l.code === wanted)) {
    $("#global-target-lang").value = wanted;
    state.targetLang = wanted;
  } else {
    $("#global-target-lang").value = "es";
    state.targetLang = "es";
  }
  localStorage.setItem(TARGET_LANG_KEY, state.targetLang);
}

$("#global-target-lang").addEventListener("change", (e) => {
  state.targetLang = e.target.value;
  localStorage.setItem(TARGET_LANG_KEY, state.targetLang);
  api("/v1/users/me", { method: "PATCH", body: { preferredTargetLang: state.targetLang } }).catch(() => {});
});

function languageName(code) {
  if (code === "auto") return "auto";
  const lang = state.languages.find((l) => l.code === code);
  return lang ? lang.name : code;
}

// ─────────────────────────── Documents ──────────────────────────────────

async function refreshDocuments() {
  try {
    const data = await api("/v1/documents");
    state.documents = data.documents;
    renderDocuments();
    state.documents.filter((d) => d.status === "translating").forEach(startPoll);
  } catch (err) {
    console.error(err);
  }
}

function upsertDoc(meta) {
  const idx = state.documents.findIndex((d) => d.docId === meta.docId);
  if (idx >= 0) {
    state.documents[idx] = { ...state.documents[idx], ...meta };
  } else {
    state.documents.unshift(meta);
  }
  renderDocuments();
}

function renderDocuments() {
  const container = $("#doc-cards");
  const empty = $("#empty-state");
  const count = $("#history-count");
  if (!state.documents.length) {
    container.innerHTML = "";
    empty.hidden = false;
    count.textContent = "";
    return;
  }
  empty.hidden = true;
  count.textContent = `${state.documents.length} document${state.documents.length === 1 ? "" : "s"}`;
  container.innerHTML = state.documents.map(renderDocCard).join("");
  wireDocCardHandlers();
}

function renderDocCard(d) {
  const expanded = d.docId === state.expandedDocId;
  const statusBadge = renderStatusBadge(d);
  const progressPct = d.totalChunks ? Math.round((d.completedChunks / d.totalChunks) * 100) : 0;
  const isTranslating = d.status === "translating";
  const isComplete = d.status === "complete";
  const isFailed = d.status === "failed";
  const langPair = `<span class="font-mono text-xs text-zinc-500">${escapeHtml(d.sourceLang === "auto" ? "auto" : d.sourceLang)}</span>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-zinc-600 inline-block mx-1"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
    <span class="font-mono text-xs text-zinc-300">${escapeHtml(d.targetLang || "—")}</span>`;
  const cached = state.contentCache.get(d.docId);

  return `
    <article data-id="${d.docId}" class="doc-card rounded-2xl border border-white/[0.08] bg-white/[0.02] animate-slide-up overflow-hidden">
      <button data-action="toggle" data-id="${d.docId}" class="w-full text-left p-5 flex items-start gap-4">
        <div class="grid place-items-center w-9 h-9 rounded-xl bg-white/[0.04] border border-white/[0.06] flex-shrink-0 mt-0.5">
          ${docGlyph(d)}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 class="text-white font-medium truncate">${escapeHtml(d.title || "Untitled")}</h3>
            ${langPair}
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
            <span class="font-mono">${d.sourceChars.toLocaleString()} chars</span>
            <span class="text-zinc-700">·</span>
            <span class="font-mono">${d.totalChunks} chunk${d.totalChunks === 1 ? "" : "s"}</span>
            <span class="text-zinc-700">·</span>
            <span>${formatRelative(d.createdAt)}</span>
          </div>
          ${isTranslating ? `
            <div class="mt-3 flex items-center gap-3">
              <div class="flex-1 h-1 rounded-full bg-white/[0.05] overflow-hidden">
                <div class="h-full bg-brand-400 transition-all duration-500" style="width: ${progressPct}%"></div>
              </div>
              <span class="text-xs font-mono text-brand-300">${d.completedChunks}/${d.totalChunks}</span>
            </div>` : ""}
          ${isFailed ? `<p class="mt-2 text-sm text-red-300">${escapeHtml(d.error || "Translation failed.")}</p>` : ""}
          ${isComplete && cached?.translated ? `<p class="mt-2 text-sm text-zinc-300 italic line-clamp-2">${escapeHtml(cached.translated.slice(0, 220))}${cached.translated.length > 220 ? "…" : ""}</p>` : ""}
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          ${statusBadge}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="text-zinc-500 transition-transform ${expanded ? "rotate-180" : ""}"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </button>

      ${expanded ? `
      <div class="border-t border-white/[0.06] animate-fade-in">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/[0.06]">
          <div class="bg-[#0a0a0a] p-5">
            <div class="flex items-center justify-between mb-2 text-xs uppercase tracking-wider text-zinc-500">
              <span>Source</span>
              <span class="font-mono">${escapeHtml(d.sourceLang === "auto" ? "auto" : d.sourceLang)}</span>
            </div>
            <pre class="whitespace-pre-wrap text-sm text-zinc-300 leading-relaxed max-h-[60vh] overflow-auto scrollbar font-sans">${escapeHtml(cached?.source || "Loading…")}</pre>
          </div>
          <div class="bg-[#0a0a0a] p-5">
            <div class="flex items-center justify-between mb-2 text-xs uppercase tracking-wider text-zinc-500">
              <span>Translation</span>
              <span class="font-mono">${escapeHtml(d.targetLang || "—")}</span>
            </div>
            <pre class="whitespace-pre-wrap text-sm text-white leading-relaxed max-h-[60vh] overflow-auto scrollbar font-sans">${escapeHtml(cached?.translated || (isComplete ? "(empty)" : "Translating…"))}</pre>
          </div>
        </div>
        <div class="flex items-center justify-end gap-2 p-3 border-t border-white/[0.06] bg-white/[0.01]">
          <button data-action="download" data-id="${d.docId}" class="px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-zinc-200 text-xs font-medium transition-colors">Download .txt</button>
          <button data-action="delete" data-id="${d.docId}" class="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs font-medium transition-colors">Delete</button>
        </div>
      </div>` : ""}
    </article>`;
}

function docGlyph(d) {
  if (d.status === "translating") return `<span class="spinner"></span>`;
  if (d.status === "failed") return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="text-red-400"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>`;
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="text-brand-400"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

function renderStatusBadge(d) {
  if (d.status === "translating") {
    return `<span class="hidden sm:inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-brand-500/10 text-brand-300 font-medium">Translating</span>`;
  }
  if (d.status === "complete") {
    return `<span class="hidden sm:inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-300 font-medium">Done</span>`;
  }
  if (d.status === "failed") {
    return `<span class="hidden sm:inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-red-500/10 text-red-300 font-medium">Failed</span>`;
  }
  return `<span class="hidden sm:inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-white/[0.04] text-zinc-400 font-medium">Ready</span>`;
}

function wireDocCardHandlers() {
  $$("#doc-cards [data-action='toggle']").forEach((btn) => {
    btn.addEventListener("click", () => toggleDoc(btn.dataset.id));
  });
  $$("#doc-cards [data-action='download']").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); downloadDoc(btn.dataset.id); });
  });
  $$("#doc-cards [data-action='delete']").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); deleteDoc(btn.dataset.id); });
  });
}

async function toggleDoc(docId) {
  if (state.expandedDocId === docId) {
    state.expandedDocId = null;
    renderDocuments();
    return;
  }
  state.expandedDocId = docId;
  renderDocuments();
  await loadDocContent(docId);
  renderDocuments();
}

async function loadDocContent(docId) {
  try {
    const [src, trn] = await Promise.all([
      api(`/v1/documents/${docId}/source`),
      api(`/v1/documents/${docId}/translated`),
    ]);
    state.contentCache.set(docId, { source: src.text, translated: trn.text });
  } catch (err) {
    console.error("loadDocContent", err);
  }
}

async function downloadDoc(docId) {
  let cached = state.contentCache.get(docId);
  if (!cached?.translated) {
    const trn = await api(`/v1/documents/${docId}/translated`);
    cached = { ...(cached || {}), translated: trn.text };
    state.contentCache.set(docId, cached);
  }
  const meta = state.documents.find((d) => d.docId === docId);
  const filename = ((meta?.title || "translation") + `_${meta?.targetLang || "translated"}.txt`).replace(/[^\w.\- ]+/g, "_");
  const blob = new Blob([cached.translated || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function deleteDoc(docId) {
  if (!confirm("Delete this translation?")) return;
  try {
    await api(`/v1/documents/${docId}`, { method: "DELETE" });
    state.documents = state.documents.filter((d) => d.docId !== docId);
    state.contentCache.delete(docId);
    if (state.expandedDocId === docId) state.expandedDocId = null;
    clearPoll(docId);
    renderDocuments();
    toast("Translation deleted");
  } catch (err) {
    toast(err.message, "error");
  }
}

// ─────────────────────────── Polling ────────────────────────────────────

function clearPoll(docId) {
  const handle = state.pollHandles.get(docId);
  if (handle) { clearTimeout(handle); state.pollHandles.delete(docId); }
}

function startPoll(doc) {
  clearPoll(doc.docId);
  const tick = async () => {
    try {
      const meta = await api(`/v1/documents/${doc.docId}`);
      upsertDoc(meta);
      if (meta.status === "complete" || meta.status === "failed") {
        clearPoll(doc.docId);
        if (meta.status === "complete") {
          await loadDocContent(doc.docId);
          renderDocuments();
          toast(`"${meta.title}" translated`);
        } else if (meta.status === "failed") {
          toast(meta.error || "Translation failed", "error");
        }
        return;
      }
    } catch (err) {
      console.error("poll", err);
    }
    state.pollHandles.set(doc.docId, setTimeout(tick, 1800));
  };
  state.pollHandles.set(doc.docId, setTimeout(tick, 1200));
}

// ─────────────────────────── Upload + translate ─────────────────────────

const dropzone = $("#dropzone");
const fileInput = $("#file-input");

["dragenter", "dragover"].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.add("is-dragging");
  });
});
["dragleave", "drop"].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove("is-dragging");
  });
});
dropzone.addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer?.files || []);
  handleFiles(files);
});
fileInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  handleFiles(files);
  e.target.value = "";
});

async function handleFiles(files) {
  if (!files.length) return;
  if (!state.targetLang) { toast("Pick a target language first", "error"); return; }
  dropzone.classList.add("is-uploading");
  try {
    for (const file of files) {
      await uploadAndTranslate(file);
    }
  } finally {
    dropzone.classList.remove("is-uploading");
  }
}

async function uploadAndTranslate(file) {
  const allowed = [".txt", ".docx"];
  const lower = file.name.toLowerCase();
  if (!allowed.some((ext) => lower.endsWith(ext))) {
    toast(`${file.name}: unsupported file type`, "error");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast(`${file.name}: too large (max 5MB)`, "error");
    return;
  }

  const fd = new FormData();
  fd.append("file", file);
  fd.append("title", file.name.replace(/\.(txt|docx)$/i, ""));
  fd.append("sourceLang", "auto");

  let doc;
  try {
    doc = await api("/v1/documents/upload", { method: "POST", body: fd });
  } catch (err) {
    toast(`${file.name}: ${err.message}`, "error");
    return;
  }
  upsertDoc(doc);

  try {
    const result = await api(`/v1/documents/${doc.docId}/translate`, {
      method: "POST",
      body: { targetLang: state.targetLang },
    });
    upsertDoc({ ...doc, ...result });
    startPoll({ docId: doc.docId });
  } catch (err) {
    toast(`${file.name}: ${err.message}`, "error");
  }
}

// ─────────────────────────── Paste panel ────────────────────────────────

$("#toggle-paste").addEventListener("click", () => {
  const panel = $("#paste-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) $("#paste-text").focus();
});

$("#paste-translate").addEventListener("click", async () => {
  const text = $("#paste-text").value.trim();
  if (!text) { toast("Paste some text first", "error"); return; }
  if (!state.targetLang) { toast("Pick a target language first", "error"); return; }
  const btn = $("#paste-translate");
  btn.disabled = true;
  try {
    const title = text.split(/\s+/).slice(0, 6).join(" ").slice(0, 60) || "Pasted text";
    const sourceLang = $("#paste-source-lang").value || "auto";
    const doc = await api("/v1/documents", {
      method: "POST",
      body: { title, sourceLang, sourceText: text },
    });
    upsertDoc(doc);
    const result = await api(`/v1/documents/${doc.docId}/translate`, {
      method: "POST",
      body: { targetLang: state.targetLang },
    });
    upsertDoc({ ...doc, ...result });
    startPoll({ docId: doc.docId });
    $("#paste-text").value = "";
    $("#paste-panel").hidden = true;
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
});

// ─────────────────────────── Toasts ─────────────────────────────────────

function toast(text, tone = "info") {
  const el = document.createElement("div");
  const toneCls = tone === "error"
    ? "bg-red-500/15 border-red-500/30 text-red-200"
    : "bg-white/[0.06] border-white/[0.1] text-zinc-100";
  el.className = `pointer-events-auto px-3.5 py-2.5 rounded-xl border ${toneCls} text-sm shadow-lg backdrop-blur animate-slide-up max-w-sm`;
  el.textContent = text;
  $("#toasts").appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity 200ms ease, transform 200ms ease";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 220);
  }, 3500);
}

// ─────────────────────────── Utils ──────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatRelative(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 30) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ─────────────────────────── Boot ───────────────────────────────────────

renderNav();
if (state.accessToken && state.user) {
  showApp();
} else {
  showAuth();
}
