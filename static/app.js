/* Jira Task Uploader - front-end */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const KIND_LABEL = { bug: "Bug", feature: "Feature", task: "Task" };
const SOURCE_LABEL = { tag: "Tag", section: "Heading", keyword: "Keyword", manual: "Manual", default: "Default" };

const state = {
  profile: null,
  profiles: [],
  issuetypes: [],
  kindMap: {},
  sprints: [],
  tasks: [],
  filter: { kind: "all", q: "" },
  filename: "",
  results: [],
  nextUid: 1,
};

/* ---------------- utilities ---------------- */

/** Error carrying an RFC 9457 problem response from the server. */
class ApiError extends Error {
  constructor(problem, status) {
    super(problem.detail || problem.error || `Request failed (${status})`);
    this.title = problem.title || "Request failed";
    this.status = problem.status || status;
    this.requestId = problem.request_id || "";
  }
}

async function api(path, opts = {}) {
  let res;
  try { res = await fetch(path, opts); }
  catch { throw new ApiError({ title: "You appear to be offline", detail: "Could not reach the server. Check your connection and try again." }, 0); }
  let body;
  try { body = await res.json(); }
  catch {
    const waking = res.status === 502 || res.status === 503;
    throw new ApiError({
      title: waking ? "Server is starting up" : "Server error",
      detail: waking ? "The server is waking up after being idle. Wait a minute and try again."
        : `The server returned an unexpected response (${res.status}).`,
      request_id: res.headers.get("X-Request-ID") || "",
    }, res.status);
  }
  if (!res.ok || !body.ok) throw new ApiError(body, res.status);
  return body;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function store(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { return null; }
}

/* Notifications: Sonner-style stacked toasts with title, description, reference ID and close. */
const TOAST_ICONS = {
  ok: '<path d="M20 6 9 17l-5-5"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4m0 4h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>',
};
const TOAST_MAX = 4;

/** toast("Saved", "ok"), toast(error, "error") or toast({ title, description }, "warn"). */
function toast(msg, kind = "info") {
  kind = kind || "info";
  const n = msg instanceof ApiError ? { title: msg.title, description: msg.message, requestId: msg.requestId }
    : msg instanceof Error ? { title: "Something went wrong", description: msg.message }
    : typeof msg === "object" ? msg : { title: msg };
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 24 24" aria-hidden="true">${TOAST_ICONS[kind] || TOAST_ICONS.info}</svg>
    <div class="toast-body">
      <div class="toast-title">${esc(n.title)}</div>
      ${n.description ? `<div class="toast-desc">${esc(n.description)}</div>` : ""}
      ${n.requestId ? `<button type="button" class="toast-ref" title="Copy reference ID">Ref: ${esc(n.requestId)}</button>` : ""}
    </div>
    <button type="button" class="toast-close" aria-label="Dismiss">&times;</button>`;
  const box = $("#toasts");
  box.prepend(el);
  while (box.children.length > TOAST_MAX) box.lastElementChild.remove();

  // Auto-dismiss, paused while hovered so long errors can be read.
  let remaining = kind === "error" ? 9000 : 4500, started, timer;
  const close = () => { clearTimeout(timer); el.classList.add("leaving"); setTimeout(() => el.remove(), 180); };
  const start = () => { started = Date.now(); timer = setTimeout(close, remaining); };
  el.addEventListener("mouseenter", () => { clearTimeout(timer); remaining -= Date.now() - started; });
  el.addEventListener("mouseleave", start);
  el.querySelector(".toast-close").onclick = close;
  const ref = el.querySelector(".toast-ref");
  if (ref) ref.onclick = async () => {
    try { await navigator.clipboard.writeText(n.requestId); ref.textContent = "Copied"; } catch { /* clipboard blocked */ }
  };
  start();
}

/** Inline alert; accepts a string or an ApiError (shown with its title and reference ID). */
function showAlert(el, msg, kind = "error") {
  if (msg instanceof ApiError) {
    el.innerHTML = `<strong class="alert-title">${esc(msg.title)}</strong><div>${esc(msg.message)}</div>`
      + (msg.requestId ? `<small class="alert-ref">Reference ID: ${esc(msg.requestId)}</small>` : "");
  } else {
    el.textContent = msg instanceof Error ? msg.message : msg;
  }
  el.className = `alert ${kind}`;
}

function initials(name) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

function fmtDate(iso) {
  if (!iso) return "No date";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

const ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/* ---------------- modal ---------------- */

function modal({ title, body, okText = "Confirm", cancelText = "Cancel", busy = false }) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  $("#modal-actions").classList.toggle("hidden", busy);
  $("#modal-ok").textContent = okText;
  $("#modal-cancel").textContent = cancelText;
  $("#modal").classList.remove("hidden");
  return new Promise((resolve) => {
    const close = (v) => { if (!busy) $("#modal").classList.add("hidden"); resolve(v); };
    $("#modal-ok").onclick = () => close(true);
    $("#modal-cancel").onclick = () => close(false);
    $("#modal").onclick = (e) => { if (e.target.id === "modal" && !busy) close(false); };
  });
}
function closeModal() { $("#modal").classList.add("hidden"); }

/* ---------------- theme ---------------- */

$("#theme-toggle").onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  store("theme", root.dataset.theme);
};

/* ---------------- session / views ---------------- */

function renderShell() {
  const p = state.profile;
  $("#view-login").classList.toggle("hidden", !!p);
  $("#view-app").classList.toggle("hidden", !p);
  $("#user-menu").classList.toggle("hidden", !p);
  $("#site-chip").classList.toggle("hidden", !p);
  if (p) {
    $("#avatar").textContent = initials(p.display_name);
    $("#user-name").textContent = p.display_name;
    $("#dd-name").textContent = p.display_name;
    $("#dd-email").textContent = p.account_email || p.username;
    $("#site-chip").textContent = p.base_url.replace(/^https?:\/\//, "");
    loadProjects();
  }
  renderProfiles();
}

function renderProfiles() {
  const list = $("#profile-list");
  list.innerHTML = "";
  $("#saved-profiles").classList.toggle("hidden", state.profiles.length === 0);
  for (const p of state.profiles) {
    const li = document.createElement("li");
    li.className = "profile-item";
    li.innerHTML = `
      <span class="avatar">${esc(initials(p.display_name))}</span>
      <span class="grow"><div><strong>${esc(p.display_name)}</strong></div>
        <div class="sub">${esc(p.username)} · ${esc(p.base_url.replace(/^https?:\/\//, ""))}</div></span>
      <button class="btn btn-primary btn-sm use">Continue</button>
      <button class="remove" title="Remove saved account" aria-label="Remove saved account">${ICON_X}</button>`;
    li.querySelector(".use").onclick = async () => {
      try {
        const r = await api(`/api/profiles/${p.id}/use`, { method: "POST" });
        state.profile = r.profile;
        renderShell();
      } catch (e) { showAlert($("#login-msg"), e); }
    };
    li.querySelector(".remove").onclick = async () => {
      const ok = await modal({ title: "Remove saved account?", body: `<p>The saved sign-in for <strong>${esc(p.username)}</strong> will be deleted from this computer. You can add it again later.</p>`, okText: "Remove" });
      if (!ok) return;
      const r = await api(`/api/profiles/${p.id}`, { method: "DELETE" });
      state.profiles = r.profiles;
      renderProfiles();
    };
    list.appendChild(li);
  }
}

async function loadSession() {
  const r = await api("/api/session");
  state.profile = r.profile;
  state.profiles = r.profiles;
  renderShell();
}

async function signOut() {
  $("#user-dropdown").classList.add("hidden");
  await api("/api/logout", { method: "POST" });
  state.profile = null;
  await loadSession();
}
$("#logout").onclick = signOut;
$("#switch-account").onclick = signOut;

$("#user-btn").onclick = (e) => {
  e.stopPropagation();
  const dd = $("#user-dropdown");
  dd.classList.toggle("hidden");
  $("#user-btn").setAttribute("aria-expanded", String(!dd.classList.contains("hidden")));
};
document.addEventListener("click", () => $("#user-dropdown").classList.add("hidden"));

/* ---------------- login form ---------------- */

function syncAuthType() {
  const f = $("#login-form");
  const isCloud = /\.atlassian\.net/i.test(f.base_url.value);
  const pat = f.auth_type.value === "bearer";
  // Jira Cloud has no bearer PATs: a personal token there is sent with the account email.
  $("#username-row").classList.toggle("hidden", pat && !isCloud);
  $("label[for=f-user]").textContent = isCloud || !f.base_url.value ? "Email" : "Email / Username";
  $("label[for=f-secret]").textContent = pat ? "Personal access token" : (isCloud || !f.base_url.value ? "API token" : "API token / Password");
  $("#auth-hint").textContent = !pat ? ""
    : isCloud ? "Jira Cloud signs in personal tokens with your Atlassian email, so enter it above."
    : "For Jira Server / Data Center. Create one in Jira under Profile > Personal Access Tokens.";
  $("#auth-hint").classList.toggle("hidden", !pat);
  $("#secret-help").classList.toggle("hidden", pat && !isCloud);
}
$("#login-form").auth_type.addEventListener("change", syncAuthType);
$("#login-form").base_url.addEventListener("input", syncAuthType);

$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const btn = $("#login-btn");
  $("#login-msg").classList.add("hidden");
  if (!f.base_url.value.trim() || !f.secret.value.trim()) {
    showAlert($("#login-msg"), "Enter your Jira site and token.");
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Verifying...';
  try {
    const r = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_url: f.base_url.value, auth_type: f.auth_type.value,
        username: f.username.value, secret: f.secret.value, remember: f.remember.checked,
      }),
    });
    state.profile = r.profile;
    state.profiles = r.profiles;
    f.secret.value = "";
    renderShell();
    toast(`Signed in as ${r.profile.display_name}`, "ok");
  } catch (e) {
    showAlert($("#login-msg"), e);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

/* ---------------- projects, types, sprints ---------------- */

async function loadProjects() {
  const sel = $("#project");
  sel.innerHTML = "<option>Loading projects...</option>";
  try {
    const r = await api("/api/projects");
    sel.innerHTML = r.projects.map((p) => `<option value="${esc(p.key)}">${esc(p.name)} (${esc(p.key)})</option>`).join("");
    const last = store("lastProject");
    if (last && r.projects.some((p) => p.key === last)) sel.value = last;
    await onProjectChange();
  } catch (e) {
    sel.innerHTML = "<option value=''>Could not load projects</option>";
    toast(e, "error");
  }
}

async function onProjectChange() {
  store("lastProject", $("#project").value);
  await Promise.all([loadIssueTypes(), loadSprints()]);
}
$("#project").addEventListener("change", onProjectChange);

async function loadIssueTypes() {
  const key = $("#project").value;
  const sel = $("#issuetype");
  if (!key) return;
  sel.innerHTML = "<option>Loading...</option>";
  try {
    const r = await api(`/api/issuetypes?project=${encodeURIComponent(key)}`);
    state.issuetypes = r.issuetypes;
    state.kindMap = r.kind_map || {};
    sel.innerHTML = r.issuetypes.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
    const saved = store(`defaultType:${key}`);
    if (saved && r.issuetypes.some((t) => t.id === saved)) sel.value = saved;
    else if (state.kindMap.task) sel.value = state.kindMap.task;
    // Manual overrides that do not exist in the new project fall back to detection.
    for (const t of state.tasks) {
      if (t.typeOverride && !typeById(t.typeOverride)) t.typeOverride = null;
    }
    $("#bulk-type").innerHTML = `<option value="">Set type for selected...</option>` +
      r.issuetypes.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
    renderMapping();
    renderTasks();
  } catch (e) {
    sel.innerHTML = "<option value=''>Could not load issue types</option>";
    toast(e, "error");
  }
}

$("#issuetype").addEventListener("change", () => {
  store(`defaultType:${$("#project").value}`, $("#issuetype").value);
  renderMapping();
  renderTasks();
});

async function loadSprints() {
  const key = $("#project").value;
  const sel = $("#sprint");
  const hint = $("#sprint-hint");
  sel.innerHTML = "<option value=''>Loading sprints...</option>";
  hint.textContent = "";
  try {
    const r = await api(`/api/sprints?project=${encodeURIComponent(key)}`);
    state.sprints = r.sprints;
    sel.innerHTML = ["<option value=''>Backlog (no sprint)</option>"].concat(r.sprints.map((s) =>
      `<option value="${s.id}">${esc(s.name)} · ${s.state === "active" ? "Active" : "Future"}</option>`)).join("");
    const active = r.sprints.find((s) => s.state === "active");
    if (active) sel.value = String(active.id);
    if (r.warning) hint.textContent = "Could not read sprints: " + r.warning;
    else if (!r.sprints.length) hint.textContent = "No active or future sprint in this project.";
    else if (r.sprints.filter((s) => s.state === "active").length > 1) hint.textContent = "More than one sprint is active. Check the selection.";
  } catch (e) {
    state.sprints = [];
    sel.innerHTML = "<option value=''>Backlog (no sprint)</option>";
    hint.textContent = e.message;
  }
  renderActionBar();
}
$("#sprint").addEventListener("change", renderActionBar);

function typeById(id) { return state.issuetypes.find((t) => t.id === String(id)); }

function renderMapping() {
  const def = typeById($("#issuetype").value);
  $("#mapping").innerHTML = ["bug", "feature", "task"].map((k) => {
    const t = typeById(state.kindMap[k]);
    const target = t ? `<span class="target">${esc(t.name)}</span>`
                     : `<span class="missing">No match, uses ${esc(def ? def.name : "default")}</span>`;
    return `<li><span class="dot ${k}"></span>${KIND_LABEL[k]}<span class="arrow">&rarr;</span>${target}</li>`;
  }).join("");
}

/* ---------------- task model ---------------- */

function effectiveTypeId(t) {
  if (t.typeOverride) return t.typeOverride;
  if (t.kind && state.kindMap[t.kind]) return state.kindMap[t.kind];
  return $("#issuetype").value;
}

// Colour/category of a task, based on the issue type it will actually get.
function displayKind(t) {
  const id = effectiveTypeId(t);
  for (const k of ["bug", "feature", "task"]) if (state.kindMap[k] && state.kindMap[k] === id) return k;
  const name = (typeById(id)?.name || "").toLowerCase();
  if (/bug|defect/.test(name)) return "bug";
  if (/feature|story|improvement/.test(name)) return "feature";
  return "task";
}

function sourceOf(t) {
  if (t.typeOverride) return "manual";
  if (t.kind && state.kindMap[t.kind]) return t.kind_source;
  return "default";
}

function visibleTasks() {
  const q = state.filter.q.trim().toLowerCase();
  return state.tasks.filter((t) =>
    (state.filter.kind === "all" || displayKind(t) === state.filter.kind) &&
    (!q || t.summary.toLowerCase().includes(q)));
}

/* ---------------- upload & parse ---------------- */

const dz = $("#dropzone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", (e) => { if (e.dataTransfer.files[0]) parseFile(e.dataTransfer.files[0]); });
$("#file-input").addEventListener("change", (e) => { if (e.target.files[0]) parseFile(e.target.files[0]); });
$("#file-clear").onclick = () => {
  $("#file-input").value = "";
  $("#file-chip").classList.add("hidden");
  dz.classList.remove("hidden");
  $("#file-input").click();
};

$("#upload-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#paste-text").value.trim();
  if (!text) { toast("Paste some text first.", "error"); return; }
  const fd = new FormData();
  fd.append("text", text);
  await runParse(fd, "Pasted text", `${text.split("\n").length} lines`);
});

async function parseFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  await runParse(fd, file.name, `${(file.size / 1024).toFixed(1)} KB`);
}

async function runParse(fd, name, meta) {
  try {
    const r = await api("/api/parse", { method: "POST", body: fd });
    state.filename = name;
    state.tasks = r.tasks.map((t) => ({ ...t, uid: state.nextUid++, selected: true, typeOverride: null }));
    state.filter = { kind: "all", q: "" };
    $("#search").value = "";
    $$("#kind-filter button").forEach((b) => b.classList.toggle("on", b.dataset.kind === "all"));
    $("#file-name").textContent = name;
    $("#file-meta").textContent = `${meta} · ${r.tasks.length} tasks`;
    $("#file-chip").classList.remove("hidden");
    dz.classList.add("hidden");
    $("#results").classList.add("hidden");
    setStep(r.tasks.length ? 2 : 1);
    renderTasks();
    if (r.tasks.length) toast(`Found ${r.tasks.length} tasks in ${name}`, "ok");
    else toast({ title: `No tasks found in ${name}`, description: 'Start each task line with a bullet such as "->", "-" or "1."' }, "warn");
  } catch (e) {
    toast(e, "error");
  }
}

function setStep(n) {
  $$("#stepper li").forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle("active", s === n);
    li.classList.toggle("done", s < n);
  });
}

/* ---------------- review table ---------------- */

function typeOptions(selectedId) {
  return state.issuetypes.map((t) => `<option value="${esc(t.id)}"${t.id === selectedId ? " selected" : ""}>${esc(t.name)}</option>`).join("");
}

function renderTasks() {
  const has = state.tasks.length > 0;
  $("#review").classList.toggle("hidden", !has);
  $("#kpis").classList.toggle("hidden", !has);
  const tbody = $("#task-table tbody");
  tbody.innerHTML = "";
  const rows = visibleTasks();
  $("#empty-filter").classList.toggle("hidden", rows.length > 0 || !has);
  let lastDate;
  for (const t of rows) {
    if (t.date !== lastDate) {
      lastDate = t.date;
      const g = document.createElement("tr");
      g.className = "group";
      const n = rows.filter((x) => x.date === t.date).length;
      g.innerHTML = `<td colspan="6">${esc(fmtDate(t.date))} <span class="muted">· ${n} task${n === 1 ? "" : "s"}</span></td>`;
      tbody.appendChild(g);
    }
    const kind = displayKind(t);
    const src = sourceOf(t);
    const tr = document.createElement("tr");
    tr.className = t.selected ? "" : "off";
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="sel" ${t.selected ? "checked" : ""} aria-label="Include task"></td>
      <td><input class="cell date" type="date" value="${t.date || ""}"></td>
      <td><input class="cell summary" value="${esc(t.summary)}" placeholder="Task summary"></td>
      <td><div class="type-cell"><span class="dot ${kind}"></span><select class="cell type">${typeOptions(effectiveTypeId(t))}</select></div></td>
      <td><span class="src ${src}">${SOURCE_LABEL[src] || "Default"}</span></td>
      <td><button class="row-del" title="Remove task" aria-label="Remove task">${ICON_X}</button></td>`;
    tr.querySelector(".sel").onchange = (e) => { t.selected = e.target.checked; tr.className = t.selected ? "" : "off"; renderSummary(); };
    tr.querySelector(".date").onchange = (e) => { t.date = e.target.value || null; sortTasks(); renderTasks(); };
    tr.querySelector(".summary").oninput = (e) => { t.summary = e.target.value; };
    tr.querySelector(".type").onchange = (e) => { t.typeOverride = e.target.value; renderTasks(); };
    tr.querySelector(".row-del").onclick = () => { state.tasks = state.tasks.filter((x) => x !== t); renderTasks(); };
    tbody.appendChild(tr);
  }
  renderSummary();
}

function sortTasks() {
  state.tasks.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || a.uid - b.uid);
}

function renderSummary() {
  const counts = { bug: 0, feature: 0, task: 0 };
  let defaults = 0;
  for (const t of state.tasks) {
    counts[displayKind(t)]++;
    if (sourceOf(t) === "default") defaults++;
  }
  $("#k-total").textContent = state.tasks.length;
  $("#k-bug").textContent = counts.bug;
  $("#k-feature").textContent = counts.feature;
  $("#k-task").textContent = counts.task;
  $("#k-default").textContent = defaults ? `${defaults} using the default type` : "";
  const dates = state.tasks.map((t) => t.date).filter(Boolean).sort();
  $("#k-range").textContent = dates.length ? `${fmtDate(dates[0])} to ${fmtDate(dates[dates.length - 1])}` : "";

  $$("#kind-filter button").forEach((b) => {
    const k = b.dataset.kind;
    const n = k === "all" ? state.tasks.length : counts[k];
    let c = b.querySelector(".count");
    if (!c) { c = document.createElement("span"); c.className = "count"; b.appendChild(c); }
    c.textContent = n;
  });
  const vis = visibleTasks();
  const all = $("#check-all");
  all.checked = vis.length > 0 && vis.every((t) => t.selected);
  all.indeterminate = !all.checked && vis.some((t) => t.selected);
  renderActionBar();
}

function renderActionBar() {
  const sel = state.tasks.filter((t) => t.selected && t.summary.trim());
  $("#actionbar").classList.toggle("hidden", state.tasks.length === 0 || !state.profile);
  const byType = {};
  for (const t of sel) {
    const name = typeById(effectiveTypeId(t))?.name || "?";
    byType[name] = byType[name] || { n: 0, kind: displayKind(t) };
    byType[name].n++;
  }
  const sprintSel = $("#sprint");
  const sprint = sprintSel.value ? sprintSel.options[sprintSel.selectedIndex].text.split(" · ")[0] : "Backlog";
  const typesHtml = Object.entries(byType).map(([name, v]) => `<span class="pill"><span class="dot ${v.kind}"></span>${v.n} ${esc(name)}</span>`).join("");
  $("#actionbar-info").innerHTML = `
    <strong>${sel.length} selected</strong>${typesHtml ? `<span class="sep"></span>${typesHtml}` : ""}
    <span class="sep"></span><span>${esc($("#project").value)} · ${esc(sprint)}</span>
    ${$("#assign-me").checked && state.profile ? `<span class="sep"></span><span>Assignee: ${esc(state.profile.display_name)}</span>` : ""}`;
  const btn = $("#create-btn");
  btn.disabled = sel.length === 0;
  btn.textContent = sel.length ? `Create ${sel.length} ticket${sel.length === 1 ? "" : "s"}` : "Create tickets";
}
$("#assign-me").addEventListener("change", renderActionBar);

$("#check-all").onchange = (e) => { visibleTasks().forEach((t) => (t.selected = e.target.checked)); renderTasks(); };
$("#search").addEventListener("input", (e) => { state.filter.q = e.target.value; renderTasks(); });
$$("#kind-filter button").forEach((b) => b.onclick = () => {
  state.filter.kind = b.dataset.kind;
  $$("#kind-filter button").forEach((x) => x.classList.toggle("on", x === b));
  renderTasks();
});
$("#bulk-type").onchange = (e) => {
  const id = e.target.value;
  if (!id) return;
  const targets = visibleTasks().filter((t) => t.selected);
  targets.forEach((t) => (t.typeOverride = id));
  e.target.value = "";
  renderTasks();
  toast(`Set ${targets.length} task(s) to ${typeById(id)?.name}`, "ok");
};
$("#add-row").onclick = () => {
  const lastDate = state.tasks.length ? state.tasks[state.tasks.length - 1].date : new Date().toISOString().slice(0, 10);
  state.tasks.push({ uid: state.nextUid++, date: lastDate, summary: "", kind: null, kind_source: null, selected: true, typeOverride: null });
  state.filter = { kind: "all", q: "" };
  $("#search").value = "";
  $$("#kind-filter button").forEach((b) => b.classList.toggle("on", b.dataset.kind === "all"));
  renderTasks();
  const inputs = $$("#task-table .summary");
  inputs[inputs.length - 1]?.focus();
};

/* ---------------- create ---------------- */

$("#create-btn").onclick = async () => {
  const tasks = state.tasks.filter((t) => t.selected && t.summary.trim());
  if (!tasks.length) return;
  const project = $("#project").value;
  if (!project) { toast("Choose a project.", "error"); return; }
  const sprintSel = $("#sprint");
  const sprintName = sprintSel.value ? sprintSel.options[sprintSel.selectedIndex].text : "Backlog (no sprint)";

  const byType = {};
  tasks.forEach((t) => { const n = typeById(effectiveTypeId(t))?.name || "?"; byType[n] = (byType[n] || 0) + 1; });
  const ok = await modal({
    title: `Create ${tasks.length} ticket${tasks.length === 1 ? "" : "s"}?`,
    body: `<ul class="summary-list">
      <li><span class="k">Project</span><span class="v">${esc($("#project").options[$("#project").selectedIndex].text)}</span></li>
      <li><span class="k">Sprint</span><span class="v">${esc(sprintName)}</span></li>
      <li><span class="k">Assignee</span><span class="v">${$("#assign-me").checked ? esc(state.profile.display_name) : "Unassigned"}</span></li>
      ${Object.entries(byType).map(([n, c]) => `<li><span class="k">${esc(n)}</span><span class="v">${c}</span></li>`).join("")}
      <li><span class="k">Existing tickets</span><span class="v">${$("#skip-dupes").checked ? "Skipped" : "Created again"}</span></li>
    </ul>`,
    okText: "Create tickets",
  });
  if (!ok) return;

  modal({ title: "Creating tickets", body: `<p class="muted">Creating ${tasks.length} ticket(s) in ${esc(project)}. This can take a minute for large files.</p><div class="progress"></div>`, busy: true });
  $("#create-btn").disabled = true;
  try {
    const r = await api("/api/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project,
        issuetype: $("#issuetype").value,
        tasks: tasks.map((t) => ({
          summary: t.summary, date: t.date,
          issuetype: effectiveTypeId(t), issuetype_name: typeById(effectiveTypeId(t))?.name,
        })),
        options: {
          labels: $("#labels").value,
          skip_duplicates: $("#skip-dupes").checked,
          set_due_date: $("#set-due").checked,
          prefix_date: $("#prefix-date").checked,
          assign_to_me: $("#assign-me").checked,
          sprint_id: sprintSel.value || null,
        },
      }),
    });
    closeModal();
    // Untick what was sent so a second click cannot resend the same tasks.
    tasks.forEach((t) => (t.selected = false));
    renderTasks();
    renderResults(r, project, sprintName);
    setStep(3);
    const c = r.counts;
    toast({ title: c.failed ? "Some tickets failed" : "Tickets created", description: `${c.created} created, ${c.skipped} skipped, ${c.failed} failed` }, c.failed ? "error" : "ok");
  } catch (e) {
    closeModal();
    toast(e, "error");
  } finally {
    renderActionBar();
  }
};

function renderResults(r, project, sprintName) {
  state.results = r.results;
  $("#results").classList.remove("hidden");
  $("#r-created").textContent = r.counts.created;
  $("#r-skipped").textContent = r.counts.skipped;
  $("#r-failed").textContent = r.counts.failed;
  $("#results-sub").textContent = `${state.filename || "Document"} → ${project} · ${sprintName} · ${new Date().toLocaleString()}`;
  const note = $("#sprint-note");
  if (r.sprint_note) {
    showAlert(note, r.sprint_note, r.sprint_note.startsWith("Tickets were created but") ? "warn" : "ok");
  } else note.classList.add("hidden");
  $("#results-table tbody").innerHTML = r.results.map((x) => `
    <tr>
      <td><span class="badge ${x.status}">${x.status[0].toUpperCase() + x.status.slice(1)}</span></td>
      <td>${x.key ? `<a class="issue-key" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.key)}</a>` : "<span class='muted'>–</span>"}</td>
      <td>${esc(x.issuetype || "")}</td>
      <td>${esc(x.summary)}</td>
      <td class="detail">${esc(x.reason || (x.notes || []).join("; "))}</td>
    </tr>`).join("");
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#copy-keys").onclick = async () => {
  const keys = state.results.filter((x) => x.key).map((x) => x.key).join(", ");
  if (!keys) { toast("No tickets were created.", "error"); return; }
  try { await navigator.clipboard.writeText(keys); toast("Issue keys copied", "ok"); }
  catch { toast({ title: "Copy these issue keys", description: keys }); }
};

$("#export-csv").onclick = () => {
  const rows = [["status", "key", "type", "summary", "url", "details"]].concat(
    state.results.map((x) => [x.status, x.key || "", x.issuetype || "", x.summary, x.url || "", x.reason || (x.notes || []).join("; ")]));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `jira-import-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal").classList.contains("hidden") && !$("#modal-actions").classList.contains("hidden")) $("#modal-cancel").click();
});

/* ---------------- boot ---------------- */
syncAuthType();
loadSession().catch((e) => { $("#view-login").classList.remove("hidden"); showAlert($("#login-msg"), e); });
