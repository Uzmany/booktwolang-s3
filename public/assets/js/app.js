/* BookTwoLang single-page client.
 *
 * Talks to https://api.booktwolang.com in production and http://localhost:8001
 * during local development. Access tokens live in localStorage; everything
 * else is fetched on demand from the API.
 */

const API_BASE = location.hostname === "localhost" || location.hostname === "127.0.0.1"
  ? "http://localhost:8001"
  : "https://api.booktwolang.com";

const TOKEN_KEY = "booktwolang_access_token_v1";
const USER_KEY = "booktwolang_user_v1";

const state = {
  accessToken: localStorage.getItem(TOKEN_KEY) || null,
  user: JSON.parse(localStorage.getItem(USER_KEY) || "null"),
  documents: [],
  activeDocId: null,
  pollTimer: null,
  languages: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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

function setAuth(token, user) {
  state.accessToken = token;
  state.user = user;
  if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user)); else localStorage.removeItem(USER_KEY);
}

function renderNav() {
  const nav = $("#nav-actions");
  if (state.user) {
    nav.innerHTML = `
      <span class="text-ink-200 hidden sm:inline">${escapeHtml(state.user.displayName || state.user.email)}</span>
      <button id="logout-btn" class="px-3 py-1.5 rounded-md text-ink-200 hover:bg-white/5" type="button">Log out</button>`;
    $("#logout-btn").addEventListener("click", handleLogout);
  } else {
    nav.innerHTML = "";
  }
}

function showAuth() {
  $("#view-auth").hidden = false;
  $("#view-app").hidden = true;
}

function showApp() {
  $("#view-auth").hidden = true;
  $("#view-app").hidden = false;
  refreshLanguages();
  refreshDocuments();
}

$("#tab-login").addEventListener("click", () => switchAuthTab("login"));
$("#tab-signup").addEventListener("click", () => switchAuthTab("signup"));

function switchAuthTab(which) {
  const login = which === "login";
  $("#tab-login").className = `px-3 py-1.5 rounded-md ${login ? "bg-white/10 text-white" : "text-ink-200 hover:bg-white/5"}`;
  $("#tab-signup").className = `px-3 py-1.5 rounded-md ${!login ? "bg-white/10 text-white" : "text-ink-200 hover:bg-white/5"}`;
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
  renderNav();
  showAuth();
}

async function refreshLanguages() {
  if (state.languages.length) return;
  try {
    const data = await api("/v1/languages");
    state.languages = data.languages;
    const tgt = $("#new-target-lang");
    const src = $("#new-source-lang");
    tgt.innerHTML = state.languages.map((l) => `<option value="${l.code}">${escapeHtml(l.name)}</option>`).join("");
    src.insertAdjacentHTML("beforeend", state.languages.map((l) => `<option value="${l.code}">${escapeHtml(l.name)}</option>`).join(""));
    const preferred = state.user?.preferredTargetLang;
    if (preferred && state.languages.some((l) => l.code === preferred)) {
      tgt.value = preferred;
    } else {
      tgt.value = "es";
    }
  } catch (err) {
    console.error("Could not load languages", err);
  }
}

async function refreshDocuments() {
  try {
    const data = await api("/v1/documents");
    state.documents = data.documents;
    renderDocList();
  } catch (err) {
    console.error(err);
  }
}

function renderDocList() {
  const ul = $("#doc-list");
  if (!state.documents.length) {
    ul.innerHTML = "";
    $("#doc-list-empty").hidden = false;
    return;
  }
  $("#doc-list-empty").hidden = true;
  ul.innerHTML = state.documents.map((d) => {
    const isActive = d.docId === state.activeDocId;
    const statusColor = statusToColor(d.status);
    return `
      <li>
        <button data-id="${d.docId}" class="doc-row w-full text-left px-3 py-2 rounded-md ${isActive ? "bg-white/10" : "hover:bg-white/5"}" type="button">
          <div class="flex items-center justify-between gap-2">
            <span class="truncate text-sm text-white">${escapeHtml(d.title)}</span>
            <span class="text-[10px] uppercase tracking-wider ${statusColor}">${escapeHtml(d.status)}</span>
          </div>
          <div class="mt-0.5 text-xs text-ink-400">
            ${d.sourceChars.toLocaleString()} chars
            ${d.targetLang ? `· → ${escapeHtml(languageName(d.targetLang))}` : ""}
          </div>
        </button>
      </li>`;
  }).join("");
  $$("#doc-list .doc-row").forEach((btn) => {
    btn.addEventListener("click", () => openDoc(btn.dataset.id));
  });
}

function statusToColor(status) {
  if (status === "complete") return "text-brand-400";
  if (status === "translating") return "text-amber-300";
  if (status === "failed") return "text-red-400";
  return "text-ink-400";
}

function languageName(code) {
  const lang = state.languages.find((l) => l.code === code);
  return lang ? lang.name : code;
}

$("#new-doc-btn").addEventListener("click", () => {
  state.activeDocId = null;
  renderDocList();
  $("#doc-detail").hidden = true;
});

$("#new-translate-btn").addEventListener("click", async () => {
  const btn = $("#new-translate-btn");
  const statusEl = $("#new-status");
  btn.disabled = true;
  statusEl.textContent = "Uploading…";
  try {
    const title = $("#new-title").value.trim() || "Untitled";
    const sourceLang = $("#new-source-lang").value || "auto";
    const targetLang = $("#new-target-lang").value;
    const file = $("#new-file").files[0];
    let doc;
    if (file) {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", title);
      fd.append("sourceLang", sourceLang);
      doc = await api("/v1/documents/upload", { method: "POST", body: fd });
    } else {
      const sourceText = $("#new-text").value.trim();
      if (!sourceText) throw new Error("Paste some text or pick a file first.");
      doc = await api("/v1/documents", {
        method: "POST",
        body: { title, sourceLang, sourceText },
      });
    }
    statusEl.textContent = "Translating…";
    await api(`/v1/documents/${doc.docId}/translate`, {
      method: "POST",
      body: { targetLang },
    });
    $("#new-text").value = "";
    $("#new-file").value = "";
    $("#new-title").value = "";
    await refreshDocuments();
    openDoc(doc.docId);
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

async function openDoc(docId) {
  state.activeDocId = docId;
  renderDocList();
  $("#doc-detail").hidden = false;
  await renderDocDetail();
}

async function renderDocDetail() {
  if (!state.activeDocId) return;
  try {
    const [meta, source, translated] = await Promise.all([
      api(`/v1/documents/${state.activeDocId}`),
      api(`/v1/documents/${state.activeDocId}/source`),
      api(`/v1/documents/${state.activeDocId}/translated`),
    ]);
    $("#doc-title").textContent = meta.title;
    $("#doc-meta").textContent = `${meta.sourceChars.toLocaleString()} chars · ${meta.totalChunks} chunks · ${formatLangPair(meta)}`;
    const pill = $("#doc-status-pill");
    pill.textContent = meta.status;
    pill.className = `px-2 py-1 rounded-md bg-white/5 ${statusToColor(meta.status)}`;
    $("#doc-source-pre").textContent = source.text;
    $("#doc-translated-pre").textContent = translated.text || (meta.status === "failed" ? `Failed: ${meta.error || "unknown"}` : "Translating…");
    const progressVisible = meta.status === "translating" || (meta.status === "complete" && meta.totalChunks > 0);
    $("#doc-progress-row").hidden = !progressVisible;
    if (progressVisible) {
      const pct = meta.totalChunks ? Math.round((meta.completedChunks / meta.totalChunks) * 100) : 0;
      $("#doc-progress-bar").style.width = pct + "%";
      $("#doc-progress-text").textContent = `${meta.completedChunks} / ${meta.totalChunks} chunks (${pct}%)`;
    }
    if (state.pollTimer) clearTimeout(state.pollTimer);
    if (meta.status === "translating") {
      state.pollTimer = setTimeout(renderDocDetail, 1800);
    } else {
      refreshDocuments();
    }
  } catch (err) {
    console.error(err);
  }
}

function formatLangPair(meta) {
  const src = meta.sourceLang === "auto" ? "auto" : languageName(meta.sourceLang);
  const tgt = meta.targetLang ? languageName(meta.targetLang) : "(no target yet)";
  return `${src} → ${tgt}`;
}

$("#doc-download").addEventListener("click", async () => {
  if (!state.activeDocId) return;
  const data = await api(`/v1/documents/${state.activeDocId}/translated`);
  const meta = state.documents.find((d) => d.docId === state.activeDocId);
  const filename = ((meta?.title || "translation") + ".txt").replace(/[^\w.\- ]+/g, "_");
  const blob = new Blob([data.text || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

$("#doc-delete").addEventListener("click", async () => {
  if (!state.activeDocId) return;
  if (!confirm("Delete this document and its translation?")) return;
  await api(`/v1/documents/${state.activeDocId}`, { method: "DELETE" });
  state.activeDocId = null;
  $("#doc-detail").hidden = true;
  await refreshDocuments();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

renderNav();
if (state.accessToken && state.user) showApp(); else showAuth();
