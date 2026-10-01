/* Jira Task Uploader - front-end */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const KIND_LABEL = { bug: "Bug", feature: "Feature", task: "Task" };
const SOURCE_LABEL = {
  tag: "a tag on the line", section: "a heading above it", keyword: "a keyword in the text",
  manual: "your choice", default: "the default issue type", subtask: "the sub-task type (it sits under a parent)",
};

const state = {
  profile: null,
  profiles: [],
  issuetypes: [],
  kindMap: {},
  sprints: [],
  statuses: [],        // project statuses ordered To Do -> In Progress -> Done
  statusRank: {},
  statusByType: {},    // issue type id -> status ids its workflow has
  tasks: [],
  groups: {},          // category -> { name, statusOverride, match }: its parent ticket
  structure: "flat",   // "subtask" | "epic" | "flat"
  groupBy: "category",
  collapsed: new Set(),
  title: null,
  expected: null,      // counts from the document's own summary table
  match: "idle",       // what is already in Jira: idle | loading | done | error
  matchSeq: 0,
  creating: false,
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
// Landing-page button; optional so an older cached page can't break the app.
$("#cta-connect")?.addEventListener("click", (e) => {
  e.preventDefault();
  window.scrollTo({ top: 0, behavior: "smooth" });
  $("#f-url").focus({ preventScroll: true });
});
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

/* ---------------- projects, types, statuses, sprints ---------------- */

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
  // What exists in Jira depends on the project, so forget the previous project's matches.
  state.tasks.forEach((t) => (t.match = null));
  Object.values(state.groups).forEach((g) => (g.match = null));
  state.match = "idle";
  await Promise.all([loadIssueTypes(), loadSprints(), loadStatuses()]);
  scheduleMatch(0);
}
$("#project").addEventListener("change", onProjectChange);

const typeOpt = (t, selectedId) => `<option value="${esc(t.id)}"${t.id === selectedId ? " selected" : ""}>${esc(t.name)}</option>`;

async function loadIssueTypes() {
  const key = $("#project").value;
  const sel = $("#issuetype");
  if (!key) return;
  sel.innerHTML = "<option>Loading...</option>";
  try {
    const r = await api(`/api/issuetypes?project=${encodeURIComponent(key)}`);
    state.issuetypes = r.issuetypes;
    state.kindMap = r.kind_map || {};
    const normal = r.issuetypes.filter((t) => !t.subtask);
    const subtasks = r.issuetypes.filter((t) => t.subtask);
    sel.innerHTML = normal.map((t) => typeOpt(t)).join("");
    const saved = store(`defaultType:${key}`);
    if (saved && normal.some((t) => t.id === saved)) sel.value = saved;
    else if (state.kindMap.task) sel.value = state.kindMap.task;
    // Manual overrides that do not exist in the new project fall back to detection.
    for (const t of state.tasks) {
      if (t.typeOverride && !typeById(t.typeOverride)) t.typeOverride = null;
    }
    $("#bulk-type").innerHTML = `<option value="">Set type for selected...</option>` + normal.map((t) => typeOpt(t)).join("") +
      (subtasks.length ? `<optgroup label="Sub-task types">${subtasks.map((t) => typeOpt(t)).join("")}</optgroup>` : "");
    renderStructureOptions();
    renderMapping();
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

const STATUS_CATS = ["new", "indeterminate", "done"];
const STATUS_CAT_LABEL = { new: "To do", indeterminate: "In progress", done: "Done" };

async function loadStatuses() {
  const key = $("#project").value;
  const sel = $("#default-status");
  if (!key) return;
  sel.innerHTML = "<option value=''>Loading...</option>";
  try {
    const r = await api(`/api/statuses?project=${encodeURIComponent(key)}`);
    state.statuses = r.statuses.map((s) => ({ ...s, category: STATUS_CATS.includes(s.category) ? s.category : "indeterminate" }));
    state.statusRank = Object.fromEntries(state.statuses.map((s, i) => [s.id, i]));
    state.statusByType = r.by_type || {};
    sel.innerHTML = statusOptions();
    // Work logs describe finished work, so the default is the first "done" status unless you chose another.
    const saved = store(`defaultStatus:${key}`);
    sel.value = saved && statusById(saved) ? saved : (state.statuses.find((s) => s.category === "done") || state.statuses[0])?.id || "";
    for (const t of state.tasks) if (t.statusOverride && !statusById(t.statusOverride)) t.statusOverride = null;
    for (const g of Object.values(state.groups)) if (g.statusOverride && !statusById(g.statusOverride)) g.statusOverride = null;
    $("#bulk-status").innerHTML = `<option value="">Set status for selected...</option>` + statusOptions();
  } catch (e) {
    state.statuses = [];
    sel.innerHTML = "<option value=''>Could not load statuses</option>";
    toast(e, "error");
  }
  renderTasks();
}
$("#default-status").addEventListener("change", () => {
  store(`defaultStatus:${$("#project").value}`, $("#default-status").value);
  renderTasks();
});
$("#apply-status").addEventListener("change", renderTasks);

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
function statusById(id) { return state.statuses.find((s) => s.id === String(id)); }

function renderMapping() {
  const def = typeById($("#issuetype").value);
  $("#mapping").innerHTML = ["bug", "feature", "task"].map((k) => {
    const t = typeById(state.kindMap[k]);
    const target = t ? `<span class="target">${esc(t.name)}</span>`
                     : `<span class="missing">No match, uses ${esc(def ? def.name : "default")}</span>`;
    return `<li><span class="dot ${k}"></span>${KIND_LABEL[k]}<span class="arrow">&rarr;</span>${target}</li>`;
  }).join("");
}

/* ---------------- parent tickets (one per category) ---------------- */

const STRUCTURE_HELP = {
  subtask: "One parent ticket per category, with each task as a sub-task under it. Sub-tasks follow their parent into the sprint.",
  epic: "One epic per category. Each task keeps its own type (Bug, Story, Task), is linked to the epic and joins the sprint.",
  flat: "No parent tickets. Each task gets its category as a label.",
};
const CHILD_NOUN = { subtask: "sub-tasks", epic: "child issues", flat: "tasks" };

function epicType() { return state.issuetypes.find((t) => t.epic && !t.subtask); }

function renderStructureOptions() {
  const key = $("#project").value;
  const subtaskTypes = state.issuetypes.filter((t) => t.subtask);
  const parentTypes = state.issuetypes.filter((t) => !t.subtask && !t.epic);
  const sel = $("#structure");
  sel.querySelector("[value=subtask]").disabled = !subtaskTypes.length;
  sel.querySelector("[value=epic]").disabled = !epicType();
  const usable = (v) => v && !sel.querySelector(`[value=${v}]`)?.disabled;
  const saved = store(`structure:${key}`);
  sel.value = usable(saved) ? saved : subtaskTypes.length ? "subtask" : epicType() ? "epic" : "flat";

  $("#parent-type").innerHTML = parentTypes.map((t) => typeOpt(t)).join("");
  const savedParent = store(`parentType:${key}`);
  const preferred = parentTypes.find((t) => t.id === savedParent) || parentTypes.find((t) => /^story$/i.test(t.name))
    || parentTypes.find((t) => /^task$/i.test(t.name)) || parentTypes[0];
  if (preferred) $("#parent-type").value = preferred.id;
  $("#child-type").innerHTML = subtaskTypes.map((t) => typeOpt(t)).join("");
  applyStructure();
}

function applyStructure() {
  state.structure = $("#structure").value || "flat";
  $("#parent-type-row").classList.toggle("hidden", state.structure !== "subtask");
  $("#child-type-row").classList.toggle("hidden", state.structure !== "subtask");
  $("#suffix-row").classList.toggle("hidden", state.structure === "flat");
  $("#structure-help").textContent = STRUCTURE_HELP[state.structure];
  renderTasks();
}
$("#structure").addEventListener("change", () => {
  store(`structure:${$("#project").value}`, $("#structure").value);
  applyStructure();
  scheduleMatch();
});
$("#parent-type").addEventListener("change", () => { store(`parentType:${$("#project").value}`, $("#parent-type").value); renderTasks(); });
$("#child-type").addEventListener("change", renderTasks);
$("#parent-suffix").addEventListener("input", () => { renderTasks(); scheduleMatch(800); });

function parentTypeId() { return state.structure === "epic" ? epicType()?.id : $("#parent-type").value; }

/** Categories in the order they first appear in the document. */
function categories() { return [...new Set(state.tasks.map((t) => t.category).filter(Boolean))]; }
function useParents() { return state.structure !== "flat" && categories().length > 0; }

function groupOf(cat) {
  if (!state.groups[cat]) state.groups[cat] = { name: cat, statusOverride: null, match: null };
  return state.groups[cat];
}
function parentSummary(cat) {
  const suffix = $("#parent-suffix").value.trim();
  return [groupOf(cat).name.trim() || cat, suffix].filter(Boolean).join(" - ");
}

/** "September 2026" from the document title, or from the dates when they all fall in one month. */
function periodLabel(title, tasks) {
  const m = (title || "").match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{4})\b/i);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`;
  const months = new Set(tasks.map((t) => (t.date || "").slice(0, 7)).filter(Boolean));
  if (months.size !== 1) return "";
  return new Date(`${[...months][0]}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/* ---------------- task model ---------------- */

function hasParent(t) { return state.structure !== "flat" && !!t.category; }
function isSubtaskChild(t) { return state.structure === "subtask" && hasParent(t); }
function allowedTypes(t) { const sub = isSubtaskChild(t); return state.issuetypes.filter((x) => !!x.subtask === sub); }

function effectiveTypeId(t) {
  const allowed = allowedTypes(t);
  if (t.typeOverride && allowed.some((x) => x.id === t.typeOverride)) return t.typeOverride;
  if (isSubtaskChild(t)) return $("#child-type").value || allowed[0]?.id;
  if (t.kind && state.kindMap[t.kind]) return state.kindMap[t.kind];
  return $("#issuetype").value;
}

// Colour/category of a task, based on the issue type it will actually get.
function displayKind(t) {
  if (isSubtaskChild(t)) return t.kind || "task";
  const id = effectiveTypeId(t);
  for (const k of ["bug", "feature", "task"]) if (state.kindMap[k] && state.kindMap[k] === id) return k;
  const name = (typeById(id)?.name || "").toLowerCase();
  if (/bug|defect/.test(name)) return "bug";
  if (/feature|story|improvement/.test(name)) return "feature";
  return "task";
}

function sourceOf(t) {
  if (t.typeOverride && allowedTypes(t).some((x) => x.id === t.typeOverride)) return "manual";
  if (isSubtaskChild(t)) return "subtask";
  if (t.kind && state.kindMap[t.kind]) return t.kind_source;
  return "default";
}

function finalSummary(t) {
  const s = t.summary.replace(/\s+/g, " ").trim();
  return $("#prefix-date").checked && t.date && s ? `${t.date} - ${s}` : s;
}

/** The Jira ticket a task or parent matches, when existing tickets are skipped. */
function existing(x) { return $("#skip-dupes").checked ? x.match : null; }

/** Jira status a status hint from the document points to: same name first, then same category. */
function statusFromHint(h) {
  if (!h || !state.statuses.length) return null;
  if (h.name) {
    const s = state.statuses.find((x) => x.name.toLowerCase() === h.name.trim().toLowerCase());
    if (s) return s.id;
  }
  if (!h.category) return null;
  const def = statusById($("#default-status").value);
  if (def && def.category === h.category) return def.id;
  return state.statuses.find((s) => s.category === h.category)?.id || null;
}

/** Statuses an issue type's workflow has (sub-tasks often lack "QA" or "Prod"). */
function typeStatuses(typeId) {
  const ids = state.statusByType[typeId];
  return ids ? state.statuses.filter((s) => ids.includes(s.id)) : state.statuses;
}
/** The status itself if the issue type has it, else the type's first status in the same category. */
function fitStatus(id, typeId) {
  const list = typeStatuses(typeId);
  if (!id || list.some((s) => s.id === id)) return id;
  const cat = statusById(id)?.category;
  return list.find((s) => s.category === cat)?.id || id;
}
function taskTypeId(t) { return existing(t)?.issuetype || effectiveTypeId(t); }

// Existing tickets keep their Jira status unless you pick another one, so nothing moves by surprise.
function effectiveStatusId(t) {
  const id = t.statusOverride || existing(t)?.status_id || statusFromHint(t.status_hint) || $("#default-status").value || null;
  return fitStatus(id, taskTypeId(t));
}
function statusSourceOf(t) {
  if (t.statusOverride) return "manual";
  if (existing(t)?.status_id) return "jira";
  if (statusFromHint(t.status_hint)) return "doc";
  return "default";
}
const STATUS_SOURCE = { manual: "Set by you", jira: "Its current status in Jira", doc: "From the document", default: "The default status" };

/** A parent is only as far along as its least advanced task. */
function rollupStatusId(tasks) {
  const ids = tasks.map(effectiveStatusId).filter(Boolean);
  if (!ids.length) return null;
  return ids.reduce((a, b) => ((state.statusRank[b] ?? 99) < (state.statusRank[a] ?? 99) ? b : a));
}
function groupTasks(cat) { return state.tasks.filter((t) => t.category === cat); }
function groupTypeId(cat) { return existing(groupOf(cat))?.issuetype || parentTypeId(); }
function groupStatusId(cat) {
  const g = groupOf(cat);
  if (g.statusOverride) return fitStatus(g.statusOverride, groupTypeId(cat));
  if (existing(g)?.status_id) return g.match.status_id;
  const all = groupTasks(cat);
  const picked = all.filter((t) => t.selected);
  return fitStatus(rollupStatusId(picked.length ? picked : all), groupTypeId(cat));
}

function statusMix(tasks) {
  const mix = { new: 0, indeterminate: 0, done: 0 };
  for (const t of tasks) { const s = statusById(effectiveStatusId(t)); if (s) mix[s.category]++; }
  return mix;
}

function visibleTasks() {
  const q = state.filter.q.trim().toLowerCase();
  return state.tasks.filter((t) =>
    (state.filter.kind === "all" || displayKind(t) === state.filter.kind) &&
    (!q || t.summary.toLowerCase().includes(q) || (t.category || "").toLowerCase().includes(q)));
}

/* ---------------- what already exists in Jira ---------------- */

let matchTimer;
function scheduleMatch(delay = 500) {
  clearTimeout(matchTimer);
  matchTimer = setTimeout(() => refreshMatches().catch(() => {}), delay);
}

/** Look up every task and parent summary in Jira; rejects when Jira cannot be checked. */
async function refreshMatches() {
  clearTimeout(matchTimer);
  const project = $("#project").value;
  if (!project || !state.tasks.length || !state.profile) return;
  const seq = ++state.matchSeq;
  const cats = useParents() ? categories() : [];
  const summaries = state.tasks.map(finalSummary).concat(cats.map(parentSummary));
  state.match = "loading";
  renderMatchState();
  try {
    const r = await api("/api/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, summaries }),
    });
    if (seq !== state.matchSeq) return;  // a newer check has started
    state.tasks.forEach((t, i) => (t.match = r.matches[i] || null));
    Object.values(state.groups).forEach((g) => (g.match = null));
    cats.forEach((c, i) => (groupOf(c).match = r.matches[state.tasks.length + i] || null));
    state.match = "done";
  } catch (e) {
    if (seq === state.matchSeq) { state.match = "error"; state.matchError = e.message; }
    throw e;
  } finally {
    if (seq === state.matchSeq) { renderMatchState(); renderTasks(); }
  }
}
function renderMatchState() { $("#match-spin").classList.toggle("hidden", state.match !== "loading"); }

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

const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;

async function runParse(fd, name, meta) {
  try {
    const r = await api("/api/parse", { method: "POST", body: fd });
    state.filename = name;
    state.tasks = r.tasks.map((t) => ({ ...t, uid: state.nextUid++, selected: !t.leave, typeOverride: null, statusOverride: null, match: null }));
    state.groups = {};
    state.collapsed = new Set();
    state.title = r.title;
    state.expected = r.expected;
    state.match = "idle";
    state.filter = { kind: "all", q: "" };
    const cats = categories();
    state.groupBy = cats.length ? "category" : "date";
    $("#search").value = "";
    $$("#kind-filter button").forEach((b) => b.classList.toggle("on", b.dataset.kind === "all"));
    $$("#group-by button").forEach((b) => b.classList.toggle("on", b.dataset.group === state.groupBy));
    $("#parent-suffix").value = cats.length ? periodLabel(r.title, r.tasks) : "";
    const work = r.tasks.filter((t) => !t.leave).length;
    const found = plural(work, "task") + (cats.length ? ` in ${plural(cats.length, "category", "categories")}` : "");
    $("#file-name").textContent = name;
    $("#file-meta").textContent = `${meta} · ${found}` + (r.duplicates ? ` · ${plural(r.duplicates, "repeated row")} ignored` : "");
    $("#file-chip").classList.remove("hidden");
    dz.classList.add("hidden");
    $("#results").classList.add("hidden");
    setStep(r.tasks.length ? 2 : 1);
    renderTasks();
    if (r.tasks.length) toast(`Found ${found} in ${name}`, "ok");
    else toast({ title: `No tasks found in ${name}`, description: 'Start each task line with a bullet such as "->", "-" or "1.", or use a table with Date and Task columns.' }, "warn");
    scheduleMatch(0);
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

const ICON_CARET = '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const byDate = (a, b) => (a.date || "9999").localeCompare(b.date || "9999") || a.uid - b.uid;
const fmtShort = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });

function dateRange(tasks) {
  const d = tasks.map((t) => t.date).filter(Boolean).sort();
  if (!d.length) return "";
  return d[0] === d[d.length - 1] ? fmtShort(d[0]) : `${fmtShort(d[0])} – ${fmtShort(d[d.length - 1])}`;
}

function statusOptions(selectedId, first = "", statuses = state.statuses) {
  return first + STATUS_CATS.map((cat) => {
    const list = statuses.filter((s) => s.category === cat);
    return list.length ? `<optgroup label="${STATUS_CAT_LABEL[cat]}">${list.map((s) =>
      `<option value="${esc(s.id)}"${s.id === selectedId ? " selected" : ""}>${esc(s.name)}</option>`).join("")}</optgroup>` : "";
  }).join("");
}

function statusCell(cls, id, title, typeId, first = "") {
  if (!state.statuses.length) return `<span class="muted">–</span>`;
  const cat = statusById(id)?.category || "new";
  return `<div class="status-cell"><span class="sdot s-${cat}"></span><select class="cell ${cls}" title="${esc(title)}">${statusOptions(id, first, typeStatuses(typeId))}</select></div>`;
}

function mixBar(mix) {
  const n = mix.new + mix.indeterminate + mix.done;
  if (!n) return "";
  return `<span class="mix" title="${mix.done} done, ${mix.indeterminate} in progress, ${mix.new} to do">` +
    ["done", "indeterminate", "new"].map((k) => (mix[k] ? `<i class="s-${k}" style="flex:${mix[k]}"></i>` : "")).join("") + "</span>";
}

function jiraCell(m, targetId) {
  if (!m) {
    if (state.match === "loading") return `<span class="muted">Checking...</span>`;
    if (state.match === "error") return `<span class="muted" title="${esc(state.matchError || "")}">Not checked</span>`;
    return state.match === "done" ? `<span class="new-tag">New</span>` : "";
  }
  const cat = statusById(m.status_id)?.category || m.category || "new";
  const target = statusById(targetId);
  const moving = $("#apply-status").checked && target && target.id !== m.status_id;
  return `<a class="issue-key" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.key)}</a>
    <span class="lozenge s-${cat}">${esc(m.status || "")}</span>${moving ? `<span class="move">&rarr; ${esc(target.name)}</span>` : ""}`;
}

/** Re-render while keeping the cursor in the field being edited. */
function keepFocus(render) {
  const a = document.activeElement;
  const row = a && a.closest ? a.closest("#task-table tr[data-key]") : null;
  const cls = row && [...a.classList].find((c) => c !== "cell");
  const pos = a && a.selectionStart;
  render();
  if (!row || !cls) return;
  const el = $(`#task-table tr[data-key="${CSS.escape(row.dataset.key)}"] .${cls}`);
  if (!el) return;
  el.focus();
  try { if (pos != null) el.setSelectionRange(pos, pos); } catch { /* not a text field */ }
}

function renderTasks() {
  keepFocus(() => {
    const has = state.tasks.length > 0;
    const cats = categories();
    $("#review").classList.toggle("hidden", !has);
    $("#kpis").classList.toggle("hidden", !has);
    $("#group-by").classList.toggle("hidden", !cats.length);
    $("#structure-panel").classList.toggle("hidden", !cats.length);
    $("#task-table").classList.toggle("status-off", !$("#apply-status").checked);
    const tbody = $("#task-table tbody");
    tbody.innerHTML = "";
    const rows = visibleTasks().sort(byDate);
    $("#empty-filter").classList.toggle("hidden", rows.length > 0 || !has);
    if (cats.length && state.groupBy === "category") {
      for (const cat of [...cats, null]) {
        const list = rows.filter((t) => (t.category || null) === cat);
        if (!list.length) continue;
        tbody.appendChild(cat ? categoryRow(cat) : plainGroupRow("No category", list.length));
        if (cat && state.collapsed.has(cat)) continue;
        list.forEach((t) => tbody.appendChild(taskRow(t, !!cat)));
      }
    } else {
      let lastDate;
      for (const t of rows) {
        if (t.date !== lastDate) {
          lastDate = t.date;
          tbody.appendChild(plainGroupRow(fmtDate(t.date), rows.filter((x) => x.date === t.date).length));
        }
        tbody.appendChild(taskRow(t, false));
      }
    }
  });
  renderSummary();
}

function plainGroupRow(label, n) {
  const g = document.createElement("tr");
  g.className = "group";
  g.innerHTML = `<td colspan="7">${esc(label)} <span class="muted">· ${plural(n, "task")}</span></td>`;
  return g;
}

function categoryRow(cat) {
  const all = groupTasks(cat);
  const g = groupOf(cat);
  const parent = useParents();
  const picked = all.filter((t) => t.selected).length;
  const collapsed = state.collapsed.has(cat);
  const suffix = $("#parent-suffix").value.trim();
  const ex = existing(g);
  const sid = groupStatusId(cat);
  const auto = ex ? `Keep: ${ex.status}` : `Auto: ${statusById(rollupStatusId(all.filter((t) => t.selected).length ? all.filter((t) => t.selected) : all))?.name || "–"}`;
  const tr = document.createElement("tr");
  tr.className = "group cat" + (picked ? "" : " off");
  tr.dataset.key = `g:${cat}`;
  tr.innerHTML = `
    <td class="col-check"><input type="checkbox" class="gsel" aria-label="Include every task in ${esc(cat)}"></td>
    <td colspan="3"><div class="cat-head">
      <button type="button" class="caret-btn${collapsed ? " closed" : ""}" aria-expanded="${!collapsed}" aria-label="Show or hide the tasks in ${esc(cat)}">${ICON_CARET}</button>
      ${parent ? `<input class="cell cat-name" value="${esc(g.name)}" size="${Math.max(6, g.name.length)}" aria-label="Parent ticket name" title="Parent ticket summary">${suffix ? `<span class="cat-suffix">- ${esc(suffix)}</span>` : ""}`
               : `<strong class="cat-label">${esc(cat)}</strong>`}
      ${parent ? `<span class="parent-type" title="Issue type of the parent ticket">${esc(typeById(parentTypeId())?.name || "Parent")}</span>` : ""}
      <span class="cat-count">${picked === all.length ? plural(all.length, "task") : `${picked} of ${plural(all.length, "task")}`}</span>
      <span class="cat-range">${esc(dateRange(all))}</span>
      ${mixBar(statusMix(all.filter((t) => t.selected)))}
    </div></td>
    <td>${parent ? statusCell("gstatus", sid, g.statusOverride ? "Set by you" : ex ? "Its current status in Jira" : "The least advanced task's status", groupTypeId(cat), `<option value="">${esc(auto)}</option>`) : ""}</td>
    <td class="jira-cell">${parent ? jiraCell(ex, sid) : ""}</td>
    <td><button type="button" class="row-del add-in" title="Add a task to ${esc(cat)}" aria-label="Add a task to ${esc(cat)}">${ICON_PLUS}</button></td>`;
  const box = tr.querySelector(".gsel");
  box.checked = picked === all.length;
  box.indeterminate = picked > 0 && picked < all.length;
  box.onchange = () => { all.forEach((t) => (t.selected = box.checked)); renderTasks(); };
  tr.querySelector(".caret-btn").onclick = () => {
    if (collapsed) state.collapsed.delete(cat); else state.collapsed.add(cat);
    renderTasks();
  };
  const name = tr.querySelector(".cat-name");
  if (name) {
    name.oninput = () => { g.name = name.value; name.size = Math.max(6, name.value.length); renderActionBar(); };
    name.onchange = () => scheduleMatch(0);
  }
  const st = tr.querySelector(".gstatus");
  if (st) {
    if (!g.statusOverride) st.value = "";
    st.onchange = () => { g.statusOverride = st.value || null; renderTasks(); };
  }
  tr.querySelector(".add-in").onclick = () => addTask(cat);
  return tr;
}

function taskRow(t, nested) {
  const kind = displayKind(t);
  const src = sourceOf(t);
  const sid = effectiveStatusId(t);
  const tr = document.createElement("tr");
  tr.className = (t.selected ? "" : "off") + (nested ? " nested" : "");
  tr.dataset.key = `t:${t.uid}`;
  tr.innerHTML = `
    <td class="col-check"><input type="checkbox" class="sel" ${t.selected ? "checked" : ""} aria-label="Include task"></td>
    <td><input class="cell date" type="date" value="${t.date || ""}"></td>
    <td><div class="sum-cell"><input class="cell summary" value="${esc(t.summary)}" placeholder="Task summary">${t.leave ? '<span class="leave-tag" title="Leave days are not created unless you tick them">Leave</span>' : ""}</div></td>
    <td><div class="type-cell" title="Type from ${esc(SOURCE_LABEL[src] || SOURCE_LABEL.default)}"><span class="dot ${kind}"></span><select class="cell type">${allowedTypes(t).map((x) => typeOpt(x, effectiveTypeId(t))).join("")}</select></div></td>
    <td>${statusCell("status", sid, STATUS_SOURCE[statusSourceOf(t)], taskTypeId(t))}</td>
    <td class="jira-cell">${jiraCell(existing(t), sid)}</td>
    <td><button type="button" class="row-del" title="Remove task" aria-label="Remove task">${ICON_X}</button></td>`;
  tr.querySelector(".sel").onchange = (e) => { t.selected = e.target.checked; renderTasks(); };
  tr.querySelector(".date").onchange = (e) => { t.date = e.target.value || null; renderTasks(); if ($("#prefix-date").checked) scheduleMatch(); };
  const sum = tr.querySelector(".summary");
  sum.oninput = () => { t.summary = sum.value; renderActionBar(); };
  sum.onchange = () => scheduleMatch(0);
  tr.querySelector(".type").onchange = (e) => { t.typeOverride = e.target.value; renderTasks(); };
  const st = tr.querySelector(".status");
  if (st) st.onchange = () => { t.statusOverride = st.value; renderTasks(); };
  tr.querySelector(".row-del").onclick = () => { state.tasks = state.tasks.filter((x) => x !== t); renderTasks(); };
  return tr;
}

function renderSummary() {
  const work = state.tasks.filter((t) => !t.leave);
  const leave = state.tasks.length - work.length;
  $("#k-total").textContent = work.length;
  const dates = work.map((t) => t.date).filter(Boolean).sort();
  $("#k-range").textContent = [dates.length ? `${fmtDate(dates[0])} to ${fmtDate(dates[dates.length - 1])}` : "",
    leave ? `+ ${plural(leave, "leave day")}` : ""].filter(Boolean).join(" · ");

  const cats = categories().filter((c) => groupTasks(c).some((t) => !t.leave));
  if (cats.length) {
    $("#k-groups-label").textContent = "Categories";
    $("#k-groups").textContent = cats.length;
    $("#k-groups-sub").textContent = state.structure === "subtask" ? `${cats.length} parents, ${work.length} sub-tasks`
      : state.structure === "epic" ? `${cats.length} epics, ${work.length} child issues` : "Added to tasks as labels";
  } else {
    $("#k-groups-label").textContent = "Days";
    $("#k-groups").textContent = new Set(dates).size;
    $("#k-groups-sub").textContent = "One ticket per task";
  }

  const picked = state.tasks.filter((t) => t.selected);
  const mix = statusMix(picked);
  $("#k-done").textContent = state.statuses.length ? `${mix.done} / ${picked.length}` : "–";
  $("#k-status-bar").innerHTML = mixBar(mix);
  $("#k-status-sub").textContent = state.statuses.length ? `done · ${mix.indeterminate} in progress · ${mix.new} to do` : "Load a project to see statuses";

  const matched = state.tasks.filter((t) => existing(t));
  const moving = matched.filter((t) => $("#apply-status").checked && t.selected && effectiveStatusId(t) !== t.match.status_id).length;
  $("#k-jira").textContent = state.match === "done" ? matched.length : state.match === "loading" ? "..." : "–";
  $("#k-jira-sub").textContent = state.match === "loading" ? "Checking Jira..."
    : state.match === "error" ? "Could not check Jira"
    : state.match !== "done" ? "" : !$("#skip-dupes").checked ? "Existing tickets will be created again"
    : matched.length ? (moving ? `${plural(moving, "status change")} to apply` : "Will not be created again") : "Every task is new";

  const counts = { bug: 0, feature: 0, task: 0 };
  for (const t of state.tasks) counts[displayKind(t)]++;
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
  renderVerify();
  renderActionBar();
}

/** Compare what was found with the document's own summary table, if it has one. */
function renderVerify() {
  const el = $("#verify");
  const ex = state.expected;
  if (!ex || !state.tasks.length) { el.classList.add("hidden"); return; }
  const found = {};
  for (const t of state.tasks) if (t.category) found[t.category.toLowerCase()] = (found[t.category.toLowerCase()] || 0) + 1;
  const diffs = Object.entries(ex.categories).filter(([name, n]) => (found[name.toLowerCase()] || 0) !== n);
  const total = state.tasks.length;
  const ncat = Object.keys(ex.categories).length;
  if (!diffs.length && (ex.total == null || ex.total === total)) {
    showAlert(el, `Every task is accounted for: the document's summary lists ${plural(ex.total, "task")} in ${plural(ncat, "category", "categories")}, and all ${total} are here.`, "ok");
  } else {
    showAlert(el, `The document's summary lists ${plural(ex.total, "task")}, but ${total} are here.` +
      (diffs.length ? ` Check ${diffs.map(([n, c]) => `${n} (${c} listed, ${found[n.toLowerCase()] || 0} here)`).join(", ")}.` : ""), "warn");
  }
}

/* ---------------- plan: what will be created, reused and moved ---------------- */

function taskSpec(t, apply) {
  const ex = existing(t);
  const type = effectiveTypeId(t);
  return {
    summary: finalSummary(t), date: t.date, category: t.category,
    issuetype: type, issuetype_name: typeById(type)?.name,
    existing_key: ex?.key || null, existing_type: ex?.issuetype || null,
    current_status_id: ex?.status_id || null, current_status: ex?.status || null,
    status_id: apply ? effectiveStatusId(t) : null,
  };
}

function buildPlan() {
  const apply = $("#apply-status").checked;
  const selected = state.tasks.filter((t) => t.selected && t.summary.trim());
  const batches = [];
  const parents = useParents();
  if (parents) {
    for (const cat of categories()) {
      const tasks = selected.filter((t) => t.category === cat);
      if (!tasks.length) continue;
      const g = groupOf(cat);
      const ex = existing(g);
      batches.push({
        label: parentSummary(cat), mode: state.structure, tasks,
        parent: {
          summary: parentSummary(cat), category: cat, issuetype: parentTypeId(), issuetype_name: typeById(parentTypeId())?.name,
          existing_key: ex?.key || null, existing_type: ex?.issuetype || null,
          current_status_id: ex?.status_id || null, current_status: ex?.status || null,
          status_id: apply ? groupStatusId(cat) : null,
        },
      });
    }
  }
  const rest = selected.filter((t) => !parents || !t.category);
  for (let i = 0; i < rest.length; i += 10) {
    batches.push({ label: rest.length > 10 ? `Tasks ${i + 1}-${Math.min(i + 10, rest.length)}` : "Tasks", mode: "flat", parent: null, tasks: rest.slice(i, i + 10) });
  }
  const moves = (spec) => spec.existing_key && spec.status_id && spec.status_id !== spec.current_status_id;
  const plan = { batches, selected, parents: 0, newParents: 0, children: 0, newChildren: 0, existing: 0, moves: 0, byType: {} };
  for (const b of batches) {
    b.specs = b.tasks.map((t) => taskSpec(t, apply));
    if (b.parent) {
      plan.parents++;
      if (!b.parent.existing_key) plan.newParents++;
      else if (moves(b.parent)) plan.moves++;
    }
    for (const s of b.specs) {
      plan.children++;
      if (s.existing_key) { plan.existing++; if (moves(s)) plan.moves++; continue; }
      plan.newChildren++;
      plan.byType[s.issuetype_name || "?"] = (plan.byType[s.issuetype_name || "?"] || 0) + 1;
    }
  }
  return plan;
}

function createLabel(p) {
  const n = p.newParents + p.newChildren;
  if (n && p.moves) return `Create ${n} · update ${p.moves}`;
  if (n) return `Create ${plural(n, "ticket")}`;
  if (p.moves) return `Update ${plural(p.moves, "status", "statuses")}`;
  return "Nothing new to create";
}

function renderActionBar() {
  $("#actionbar").classList.toggle("hidden", state.tasks.length === 0 || !state.profile);
  const p = buildPlan();
  const sprintSel = $("#sprint");
  const sprint = sprintSel.value ? sprintSel.options[sprintSel.selectedIndex].text.split(" · ")[0] : "Backlog";
  const parts = [`<strong>${plural(p.selected.length, "task")} selected</strong>`];
  if (p.parents) parts.push(`<span>${plural(p.parents, "parent")} + ${p.children} ${CHILD_NOUN[state.structure]}</span>`);
  if (p.existing || p.moves) parts.push(`<span>${p.existing} already in Jira${p.moves ? ` · ${plural(p.moves, "status change")}` : ""}</span>`);
  parts.push(`<span>${esc($("#project").value)} · ${esc(sprint)}</span>`);
  if ($("#assign-me").checked && state.profile) parts.push(`<span>Assignee: ${esc(state.profile.display_name)}</span>`);
  $("#actionbar-info").innerHTML = parts.join('<span class="sep"></span>');
  const btn = $("#create-btn");
  if (!state.creating) btn.disabled = !(p.newParents + p.newChildren + p.moves);
  btn.textContent = createLabel(p);
}
$("#assign-me").addEventListener("change", renderActionBar);
$("#skip-dupes").addEventListener("change", renderTasks);
$("#prefix-date").addEventListener("change", () => { renderActionBar(); scheduleMatch(0); });

$("#check-all").onchange = (e) => { visibleTasks().forEach((t) => (t.selected = e.target.checked)); renderTasks(); };
$("#search").addEventListener("input", (e) => { state.filter.q = e.target.value; renderTasks(); });
$$("#kind-filter button").forEach((b) => b.onclick = () => {
  state.filter.kind = b.dataset.kind;
  $$("#kind-filter button").forEach((x) => x.classList.toggle("on", x === b));
  renderTasks();
});
$$("#group-by button").forEach((b) => b.onclick = () => {
  state.groupBy = b.dataset.group;
  $$("#group-by button").forEach((x) => x.classList.toggle("on", x === b));
  renderTasks();
});
$("#bulk-type").onchange = (e) => {
  const id = e.target.value;
  if (!id) return;
  const sub = !!typeById(id)?.subtask;
  const targets = visibleTasks().filter((t) => t.selected && isSubtaskChild(t) === sub);
  targets.forEach((t) => (t.typeOverride = id));
  e.target.value = "";
  renderTasks();
  toast(targets.length ? `Set ${plural(targets.length, "task")} to ${typeById(id)?.name}`
    : { title: "No task changed", description: sub ? "Sub-task types only apply to tasks under a parent." : "Tasks under a parent are sub-tasks; pick a sub-task type." }, targets.length ? "ok" : "warn");
};
$("#bulk-status").onchange = (e) => {
  const id = e.target.value;
  if (!id) return;
  const targets = visibleTasks().filter((t) => t.selected);
  targets.forEach((t) => (t.statusOverride = id));
  e.target.value = "";
  renderTasks();
  toast(`Set ${plural(targets.length, "task")} to ${statusById(id)?.name}`, "ok");
};

function addTask(category = null) {
  const siblings = category ? groupTasks(category) : state.tasks;
  const date = siblings.length ? siblings[siblings.length - 1].date : new Date().toISOString().slice(0, 10);
  const t = { uid: state.nextUid++, date, summary: "", kind: null, kind_source: null, category, status_hint: null, leave: false,
              selected: true, typeOverride: null, statusOverride: null, match: null };
  state.tasks.push(t);
  state.filter = { kind: "all", q: "" };
  $("#search").value = "";
  $$("#kind-filter button").forEach((b) => b.classList.toggle("on", b.dataset.kind === "all"));
  if (category) state.collapsed.delete(category);
  renderTasks();
  $(`#task-table tr[data-key="t:${t.uid}"] .summary`)?.focus();
}
$("#add-row").onclick = () => addTask(null);

/* ---------------- create ---------------- */

function failedResults(b, reason) {
  const out = [];
  if (b.parent) out.push({ summary: b.parent.summary, role: "parent", category: b.parent.category, status: "failed", reason, notes: [] });
  for (const s of b.specs) out.push({ summary: s.summary, role: "child", category: s.category, issuetype: s.issuetype_name, status: "failed", reason, notes: [] });
  return out;
}

$("#create-btn").onclick = async () => {
  const project = $("#project").value;
  if (!project) { toast("Choose a project.", "error"); return; }
  const btn = $("#create-btn");
  state.creating = true;
  btn.disabled = true;
  try {
    // Check Jira again right before creating, so nothing is created twice.
    if ($("#skip-dupes").checked) {
      try { await refreshMatches(); } catch (e) {
        toast({ title: "Could not check Jira for existing tickets", description: e.message }, "error");
        return;
      }
    }
    const plan = buildPlan();
    if (!plan.newParents && !plan.newChildren && !plan.moves) {
      toast("Everything selected is already in Jira with the chosen status.", "info");
      return;
    }
    const sprintSel = $("#sprint");
    const sprintName = sprintSel.value ? sprintSel.options[sprintSel.selectedIndex].text : "Backlog (no sprint)";
    const li = (k, v) => `<li><span class="k">${k}</span><span class="v">${v}</span></li>`;
    const ok = await modal({
      title: createLabel(plan) + "?",
      body: `<ul class="summary-list">
        ${li("Project", esc($("#project").options[$("#project").selectedIndex].text))}
        ${li("Sprint", esc(sprintName))}
        ${li("Assignee", $("#assign-me").checked ? esc(state.profile.display_name) : "Unassigned")}
        ${plan.parents ? li(state.structure === "epic" ? "Epics" : "Parent tickets", `${plan.parents} <span class="muted">(${plan.newParents} new)</span>`) : ""}
        ${li(plan.parents ? CHILD_NOUN[state.structure][0].toUpperCase() + CHILD_NOUN[state.structure].slice(1) : "Tasks", `${plan.children} <span class="muted">(${plan.newChildren} new)</span>`)}
        ${Object.entries(plan.byType).map(([n, c]) => li(`<span class="muted">New ${esc(n)}</span>`, c)).join("")}
        ${plan.existing ? li("Already in Jira", `${plan.existing}${plan.moves ? ` <span class="muted">(${plural(plan.moves, "status change")})</span>` : ""}`) : ""}
        ${li("Status", $("#apply-status").checked ? "Moved to the chosen status" : "Left at the first workflow status")}
      </ul>`,
      okText: createLabel(plan),
    });
    if (!ok) return;

    modal({ title: "Working in Jira", busy: true, body: `<p class="muted" id="prog-label"></p>
      <div class="progress determinate"><span id="prog-bar"></span></div>
      <p class="help">Each category is created with its tasks, then moved to the chosen status. Keep this tab open.</p>` });
    const results = [];
    let sprintAdded = 0;
    const sprintErrors = new Set();
    for (const [i, b] of plan.batches.entries()) {
      $("#prog-label").textContent = `${i + 1} of ${plan.batches.length} · ${b.label}`;
      $("#prog-bar").style.width = `${(i / plan.batches.length) * 100}%`;
      try {
        const r = await api("/api/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project, mode: b.mode, parent: b.parent, tasks: b.specs,
            options: {
              labels: $("#labels").value,
              set_due_date: $("#set-due").checked,
              assign_to_me: $("#assign-me").checked,
              apply_status: $("#apply-status").checked,
              sprint_id: sprintSel.value || null,
            },
          }),
        });
        results.push(...r.results);
        sprintAdded += r.sprint_added || 0;
        if (r.sprint_error) sprintErrors.add(r.sprint_error);
      } catch (e) {
        results.push(...failedResults(b, e.message));
        if (e.status === 401) break;
      }
    }
    $("#prog-bar").style.width = "100%";
    closeModal();
    // Untick what was sent so a second click cannot resend the same tasks.
    plan.selected.forEach((t) => (t.selected = false));
    renderResults(results, project, sprintName, sprintAdded, [...sprintErrors]);
    setStep(3);
    const c = countResults(results);
    toast({ title: c.failed ? "Some tickets failed" : "Done", description: `${c.created} created, ${c.updated} status updated, ${c.skipped} already in Jira, ${c.failed} failed` }, c.failed ? "error" : "ok");
    refreshMatches().catch(() => {});
  } finally {
    state.creating = false;
    renderTasks();
  }
};

function countResults(results) {
  const c = { created: 0, updated: 0, skipped: 0, failed: 0 };
  results.forEach((r) => c[r.status]++);
  return c;
}

const RESULT_LABEL = { created: "Created", updated: "Updated", skipped: "In Jira", failed: "Failed" };

function renderResults(results, project, sprintName, sprintAdded, sprintErrors) {
  state.results = results;
  const c = countResults(results);
  $("#results").classList.remove("hidden");
  $("#r-created").textContent = c.created;
  $("#r-updated").textContent = c.updated;
  $("#r-skipped").textContent = c.skipped;
  $("#r-failed").textContent = c.failed;
  $("#results-sub").textContent = `${state.filename || "Document"} → ${project} · ${sprintName} · ${new Date().toLocaleString()}`;

  // The tally: every ticket this upload now has in Jira, parents and children counted separately.
  const inJira = results.filter((r) => r.key);
  const parents = inJira.filter((r) => r.role === "parent").length;
  const children = inJira.length - parents;
  const byStatus = {};
  inJira.filter((r) => r.role === "child" && r.jira_status).forEach((r) => (byStatus[r.jira_status] = (byStatus[r.jira_status] || 0) + 1));
  const tally = $("#tally");
  tally.classList.toggle("hidden", !inJira.length);
  tally.innerHTML = `<div><strong>${plural(inJira.length, "ticket")} in Jira for this upload</strong>
      <span>${parents ? `${plural(parents, "parent")} + ${children} ${CHILD_NOUN[state.structure]}` : `${plural(children, "task")}`}</span></div>
    <div class="tally-chips">${Object.entries(byStatus).map(([s, n]) =>
      `<span class="lozenge s-${state.statuses.find((x) => x.name === s)?.category || "new"}">${esc(s)} · ${n}</span>`).join("")}</div>`;

  const keys = inJira.map((r) => r.key);
  const open = $("#open-jira");
  open.classList.toggle("hidden", !keys.length);
  if (keys.length) open.href = `${state.profile.base_url}/issues/?jql=${encodeURIComponent(`key in (${keys.join(",")}) ORDER BY key ASC`)}`;

  const note = $("#sprint-note");
  if (sprintErrors.length) showAlert(note, `Tickets were created but some could not be added to the sprint: ${sprintErrors.join(" ")}`, "warn");
  else if (sprintAdded) showAlert(note, `Added ${plural(sprintAdded, "ticket")} to ${sprintName.split(" · ")[0]}.`, "ok");
  else note.classList.add("hidden");

  $("#results-table tbody").innerHTML = results.map((x) => `
    <tr class="${x.role === "parent" ? "result-parent" : x.parent ? "nested" : ""}">
      <td><span class="badge ${x.status}">${RESULT_LABEL[x.status] || x.status}</span></td>
      <td>${x.key ? `<a class="issue-key" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.key)}</a>` : "<span class='muted'>–</span>"}</td>
      <td>${esc(x.issuetype || "")}</td>
      <td>${x.role === "parent" ? `<strong>${esc(x.summary)}</strong>` : esc(x.summary)}</td>
      <td>${x.jira_status ? `<span class="lozenge s-${state.statuses.find((s) => s.name === x.jira_status)?.category || "new"}">${esc(x.jira_status)}</span>` : ""}</td>
      <td class="detail">${esc([x.reason, ...(x.notes || [])].filter(Boolean).join("; "))}</td>
    </tr>`).join("");
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#copy-keys").onclick = async () => {
  const keys = state.results.filter((x) => x.key).map((x) => x.key).join(", ");
  if (!keys) { toast("No tickets in Jira yet.", "error"); return; }
  try { await navigator.clipboard.writeText(keys); toast("Issue keys copied", "ok"); }
  catch { toast({ title: "Copy these issue keys", description: keys }); }
};

$("#export-csv").onclick = () => {
  const rows = [["category", "role", "parent", "result", "key", "type", "summary", "jira_status", "url", "details"]].concat(
    state.results.map((x) => [x.category || "", x.role || "", x.parent || "", x.status, x.key || "", x.issuetype || "", x.summary,
      x.jira_status || "", x.url || "", [x.reason, ...(x.notes || [])].filter(Boolean).join("; ")]));
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
