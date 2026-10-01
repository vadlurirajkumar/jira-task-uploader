"""Jira Task Uploader - upload a daily-tasks document and create Jira tickets from it.

Run locally:  python app.py   (then open http://127.0.0.1:5000)
Hosted:       gunicorn app:app  with JIRA_TOOL_HOSTED=1 and SECRET_KEY set

Local mode keeps saved accounts encrypted on this computer and signs you in automatically.
Hosted mode keeps each visitor's accounts encrypted in their own browser cookie instead,
so visitors never share an account.
"""
import ipaddress
import logging
import os
import re
import secrets
import socket
import webbrowser
from datetime import timedelta
from threading import Timer
from urllib.parse import urlsplit

from flask import Flask, g, jsonify, render_template, request, session
from werkzeug.exceptions import HTTPException

import browser_store
import store as local_store
from doc_parser import parse_document, parse_text
from jira_client import Jira, JiraError, clean_url, fit_summary, map_kinds, normalize

HOSTED = os.environ.get("JIRA_TOOL_HOSTED", "").lower() in ("1", "true", "yes") or bool(os.environ.get("RENDER"))

app = Flask(__name__)
if os.environ.get("SECRET_KEY"):
    app.secret_key = os.environ["SECRET_KEY"]
elif HOSTED:
    raise RuntimeError("Set the SECRET_KEY environment variable when running hosted.")
else:
    SECRET_FILE = local_store.DATA_DIR / "flask_secret"
    local_store.DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not SECRET_FILE.exists():
        SECRET_FILE.write_text(secrets.token_hex(32))
    app.secret_key = SECRET_FILE.read_text().strip()

store = browser_store if HOSTED else local_store
if HOSTED:
    app.config.update(SESSION_COOKIE_SECURE=True, SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax")
app.permanent_session_lifetime = timedelta(days=365)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB uploads

ALLOWED_EXT = (".txt", ".md", ".text", ".docx", ".pdf", ".log", ".csv", ".xlsx", ".xlsm")


# ---------- helpers ----------

def current_profile() -> dict | None:
    """Profile from the browser session, falling back to the last used saved profile."""
    temp = browser_store.decrypt(session.get("temp_profile"))
    if temp:  # signed in without "remember me" for this browser session only
        return temp
    pid = session.get("profile_id") or store.last_profile_id()
    profile = store.get_profile(pid)
    if profile:
        session.permanent = True
        session["profile_id"] = profile["id"]
    return profile


def jira_for(profile: dict) -> Jira:
    return Jira(profile["base_url"], profile["auth_type"], profile["username"], profile["secret"],
                profile.get("api_base"))


def public_https_url_error(url: str) -> str | None:
    """Hosted mode only: refuse non-HTTPS or private-network addresses, so the server
    cannot be used to reach machines inside its own network."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        return "Use an https:// Jira address."
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443)
    except socket.gaierror:
        return f"Could not find the Jira site {parts.hostname}."
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            return "This hosted app can only connect to Jira sites on the public internet."
    return None


log = logging.getLogger("jira_tool")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# Short, human titles for RFC 9457 problem responses, keyed by HTTP status.
PROBLEM_TITLES = {
    400: "Check your input",
    401: "Sign-in required",
    403: "Access denied",
    404: "Not found",
    413: "File too large",
    502: "Jira returned an error",
    500: "Something went wrong",
}


@app.before_request
def assign_request_id():
    g.request_id = request.headers.get("X-Request-ID") or secrets.token_hex(6)


@app.after_request
def add_request_id(resp):
    resp.headers["X-Request-ID"] = g.get("request_id", "")
    return resp


def error(msg: str, code: int = 400, title: str | None = None):
    """Error response in RFC 9457 Problem Details format (application/problem+json).
    `ok` and `error` are kept so older front-ends keep working."""
    rid = g.get("request_id", "")
    log.warning("request_id=%s status=%s path=%s detail=%s", rid, code, request.path, msg)
    resp = jsonify({
        "type": "about:blank",
        "title": title or PROBLEM_TITLES.get(code, "Request failed"),
        "status": code,
        "detail": msg,
        "instance": request.path,
        "request_id": rid,
        "ok": False,
        "error": msg,
    })
    resp.status_code = code
    resp.mimetype = "application/problem+json"
    return resp


@app.errorhandler(HTTPException)
def handle_http_error(e: HTTPException):
    if not request.path.startswith("/api/"):
        return e
    detail = "The file is larger than 20 MB." if e.code == 413 else e.description
    return error(detail, e.code or 500)


@app.errorhandler(Exception)
def handle_unexpected(e: Exception):
    log.exception("request_id=%s unhandled error on %s", g.get("request_id", ""), request.path)
    return error("An unexpected error occurred on the server. Try again, and share the "
                 "reference ID with your admin if it keeps happening.", 500)


# ---------- pages ----------

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/")
def index():
    return render_template("index.html", hosted=HOSTED)


# ---------- session / auth ----------

@app.get("/api/session")
def api_session():
    profile = current_profile()
    return jsonify({
        "ok": True,
        "profile": store.public(profile) if profile else None,
        "profiles": store.list_profiles(),
    })


@app.post("/api/login")
def api_login():
    body = request.get_json(force=True) or {}
    base_url = clean_url(body.get("base_url", ""))
    auth_type = body.get("auth_type", "basic")
    username = (body.get("username") or "").strip()
    secret = (body.get("secret") or "").strip()
    remember = bool(body.get("remember", True))
    if base_url.lower().endswith(".atlassian.net") and auth_type == "bearer":
        # Jira Cloud has no bearer PATs: its personal API tokens are sent with the account email.
        if not username:
            return error("On Jira Cloud (atlassian.net) a personal token must be paired with your "
                         "Atlassian email. Enter your email and try again.", title="Email required")
        auth_type = "basic"
    if not base_url or not secret or (auth_type == "basic" and not username):
        return error("Jira site, email/username and token are required.", title="Missing details")
    if HOSTED:
        problem = public_https_url_error(base_url)
        if problem:
            return error(problem, title="Jira site not allowed")
    jira = Jira(base_url, auth_type, username, secret)
    try:
        me = jira.connect()
    except JiraError as e:
        return error(str(e), 401, title="Jira rejected the sign-in")
    display = me.get("displayName") or username
    email = me.get("emailAddress") or username
    if remember:
        profile = store.save_profile(base_url, auth_type, username or email, secret, display, email,
                                     jira.api_base)
    else:
        profile = {"id": None, "base_url": base_url, "auth_type": auth_type, "username": username,
                   "secret": secret, "display_name": display, "account_email": email,
                   "api_base": jira.api_base}
        session["temp_profile"] = browser_store.encrypt(profile)
    session.permanent = True
    session["profile_id"] = profile["id"]
    if remember:
        session.pop("temp_profile", None)
    return jsonify({"ok": True, "profile": store.public(profile), "profiles": store.list_profiles()})


@app.post("/api/logout")
def api_logout():
    """Sign out of the current browser session (saved accounts are kept)."""
    session.pop("profile_id", None)
    session.pop("temp_profile", None)
    store.set_last(None)
    return jsonify({"ok": True, "profiles": store.list_profiles()})


@app.post("/api/profiles/<pid>/use")
def api_use_profile(pid):
    profile = store.get_profile(pid)
    if not profile:
        return error("Saved profile not found.", 404)
    store.set_last(pid)
    session.pop("temp_profile", None)
    session.permanent = True
    session["profile_id"] = pid
    return jsonify({"ok": True, "profile": store.public(profile)})


@app.delete("/api/profiles/<pid>")
def api_delete_profile(pid):
    store.delete_profile(pid)
    if session.get("profile_id") == pid:
        session.pop("profile_id", None)
    return jsonify({"ok": True, "profiles": store.list_profiles()})


# ---------- jira metadata ----------

@app.get("/api/projects")
def api_projects():
    profile = current_profile()
    if not profile:
        return error("Your session has ended. Sign in again.", 401)
    try:
        return jsonify({"ok": True, "projects": jira_for(profile).projects()})
    except JiraError as e:
        return error(str(e), 502)


@app.get("/api/issuetypes")
def api_issuetypes():
    profile = current_profile()
    if not profile:
        return error("Your session has ended. Sign in again.", 401)
    key = request.args.get("project", "")
    try:
        types = jira_for(profile).issue_types(key)
        return jsonify({"ok": True, "issuetypes": types, "kind_map": map_kinds(types)})
    except JiraError as e:
        return error(str(e), 502)


@app.get("/api/sprints")
def api_sprints():
    profile = current_profile()
    if not profile:
        return error("Your session has ended. Sign in again.", 401)
    key = request.args.get("project", "")
    try:
        return jsonify({"ok": True, "sprints": jira_for(profile).sprints(key)})
    except JiraError as e:
        # Projects without Jira Software boards (or tokens without board scopes) just get no sprints.
        return jsonify({"ok": True, "sprints": [], "warning": str(e)})


@app.get("/api/statuses")
def api_statuses():
    profile = current_profile()
    if not profile:
        return error("Your session has ended. Sign in again.", 401)
    try:
        return jsonify({"ok": True, **jira_for(profile).statuses(request.args.get("project", ""))})
    except JiraError as e:
        return error(str(e), 502)


@app.post("/api/match")
def api_match():
    """Which summaries already exist in Jira (reported by you), with their key and status."""
    profile = current_profile()
    if not profile:
        return error("Your session has ended. Sign in again.", 401)
    body = request.get_json(force=True) or {}
    project = body.get("project")
    if not project:
        return error("Choose a project.")
    try:
        existing = jira_for(profile).existing_issues(project)
    except JiraError as e:
        return error(f"Could not check Jira for existing tickets: {e}", 502)
    matches = [existing.get(normalize(fit_summary(s))) for s in body.get("summaries") or []]
    return jsonify({"ok": True, "matches": matches})


# ---------- document parsing ----------

@app.post("/api/parse")
def api_parse():
    if "file" in request.files and request.files["file"].filename:
        f = request.files["file"]
        name = f.filename
        if not name.lower().endswith(ALLOWED_EXT):
            return error("Unsupported file type. Upload .txt, .md, .docx or .pdf.")
        try:
            parsed = parse_document(name, f.read())
        except ValueError as e:
            return error(str(e))
        except Exception as e:  # corrupt file etc.
            return error(f"Could not read the document: {e}")
    else:
        text = (request.form.get("text") or "").strip()
        name = "pasted text"
        if not text:
            return error("Upload a file or paste some text.")
        parsed = parse_text(text)
    return jsonify({"ok": True, "filename": name, **parsed})


# ---------- ticket creation ----------

class StatusMover:
    """Moves issues to the status chosen in the app, mapping it onto each issue type's workflow."""

    def __init__(self, jira: Jira, project: str):
        info = jira.statuses(project)
        self.jira = jira
        self.by_id = {s["id"]: s for s in info["statuses"]}
        self.rank = {s["id"]: i for i, s in enumerate(info["statuses"])}
        self.by_type = info["by_type"]

    def move(self, r: dict, target_id: str, type_id: str, current_id: str | None) -> None:
        target = self.by_id.get(str(target_id))
        if not target:
            r["notes"].append("status not changed: unknown status")
            return
        allowed = self.by_type.get(str(type_id))
        if allowed and target["id"] not in allowed:
            # e.g. sub-tasks often have a simpler workflow without "QA" or "Prod".
            alt = next((self.by_id[i] for i in allowed
                        if i in self.by_id and self.by_id[i]["category"] == target["category"]), None)
            if not alt:
                r["notes"].append(f"status not changed: this issue type has no '{target['name']}' status")
                return
            r["notes"].append(f"this issue type has no '{target['name']}', used '{alt['name']}'")
            target = alt
        try:
            current_id = current_id or self.jira.initial_status(r["key"], str(type_id))
            if current_id == target["id"]:
                r["jira_status"] = r.get("jira_status") or target["name"]
                return
            before = self.by_id.get(current_id, {}).get("name")
            r["jira_status"] = self.jira.move_to_status(r["key"], current_id, target["id"], self.rank,
                                                        str(type_id)) or target["name"]
            if r["status"] == "skipped":
                r["status"] = "updated"
                r["reason"] = f"Status {before or 'changed'} → {r['jira_status']}"
        except JiraError as e:
            r["notes"].append(f"status not set to '{target['name']}': {e}")


def slug(text: str) -> str:
    """Category as a Jira label (labels cannot contain spaces): 'Design & Content' -> 'design-content'."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def task_fields(project: str, summary: str, type_id: str, description: str, date: str | None,
                opts: dict, assignee: dict | None, extra_labels: list[str] = ()) -> dict:
    fields = {
        "project": {"key": project},
        "issuetype": {"id": str(type_id)},
        "summary": fit_summary(summary),
        "description": description,
    }
    labels = [l.strip() for l in (opts.get("labels") or "").split(",") if l.strip()] + list(extra_labels)
    if labels:
        fields["labels"] = list(dict.fromkeys(l.replace(" ", "-") for l in labels))
    if opts.get("set_due_date") and date:
        fields["duedate"] = date
    if assignee:
        fields["assignee"] = assignee
    return fields


def finish_created(jira: Jira, created: dict, assignee: dict | None) -> list[str]:
    """Notes for a created issue; assigns it in a second step when the create screen has no assignee."""
    notes = []
    dropped = created.get("dropped_fields", [])
    if "assignee" in dropped:
        dropped.remove("assignee")
        try:
            jira.assign(created["key"], assignee)
        except JiraError as e:
            notes.append(f"not assigned: {e}")
    if dropped:
        notes.append("created without: " + ", ".join(dropped))
    return notes


@app.post("/api/create")
def api_create():
    """Create one batch of tickets: optionally one parent (a parent ticket for sub-tasks, or an
    epic) and its tasks. The browser sends one batch per category so progress can be shown
    and no request runs too long.

    Tasks that already exist carry `existing_key`; they are not created again, but are moved
    to their chosen status. Every result carries `role` ("parent"/"child") so the browser can
    count parents and child tasks separately."""
    profile = current_profile()
    if not profile:
        return error("Your session has ended. Sign in again.", 401)
    body = request.get_json(force=True) or {}
    project = body.get("project")
    mode = body.get("mode") or "flat"  # "subtask" | "epic" | "flat"
    parent = body.get("parent")
    tasks = body.get("tasks") or []
    opts = body.get("options") or {}
    if not project:
        return error("Choose a project.")
    if not tasks:
        return error("No tasks selected.")
    if any(not t.get("issuetype") and not t.get("existing_key") for t in tasks) \
            or (parent and not parent.get("issuetype") and not parent.get("existing_key")):
        return error("Choose an issue type for every task.")

    jira = jira_for(profile)
    assignee = None
    if opts.get("assign_to_me", True):
        try:
            assignee = Jira.user_ref(jira.myself())
        except JiraError as e:
            return error(f"Could not look up your Jira account for assigning: {e}", 502)
    mover = None
    if opts.get("apply_status", True) and (any(t.get("status_id") for t in tasks) or (parent or {}).get("status_id")):
        try:
            mover = StatusMover(jira, project)
        except JiraError as e:
            return error(f"Could not read the project's statuses: {e}", 502)

    results: list[dict] = []
    moves: list[tuple] = []  # (result, target status, issue type, current status)

    # ----- parent -----
    parent_key = None
    if parent:
        summary = fit_summary(parent.get("summary"))
        r = {"summary": summary, "role": "parent", "category": parent.get("category"),
             "issuetype": parent.get("issuetype_name"), "notes": []}
        if parent.get("existing_key"):
            r.update(status="skipped", key=parent["existing_key"], url=jira.issue_url(parent["existing_key"]),
                     reason="Already in Jira", jira_status=parent.get("current_status"))
            type_id = parent.get("existing_type") or parent.get("issuetype")
            moves.append((r, parent.get("status_id"), type_id, parent.get("current_status_id")))
        else:
            dates = sorted(t["date"] for t in tasks if t.get("date"))
            lines = [f"Tasks under {parent.get('category') or summary}:"]
            lines += ["- " + " ".join(filter(None, [t.get("date"), fit_summary(t.get("summary"))])) for t in tasks]
            lines.append("Created from document via Jira Task Uploader.")
            fields = task_fields(project, summary, parent["issuetype"], "\n".join(lines),
                                 dates[-1] if dates else None, opts, assignee)
            optional = ()
            if mode == "epic":
                name_field = jira.epic_fields().get("epic_name")  # required on Jira Server / Data Center
                if name_field:
                    fields[name_field] = summary
                    optional = (name_field,)
            try:
                created = jira.create_issue(fields, optional)
                r.update(status="created", key=created["key"], url=jira.issue_url(created["key"]),
                         notes=finish_created(jira, created, assignee))
                moves.append((r, parent.get("status_id"), parent["issuetype"], None))
            except JiraError as e:
                r.update(status="failed", reason=str(e))
        results.append(r)
        parent_key = r.get("key")
        if not parent_key:
            for t in tasks:
                results.append({"summary": fit_summary(t.get("summary")), "role": "child", "status": "failed",
                                "category": parent.get("category"), "issuetype": t.get("issuetype_name"),
                                "reason": "Not created because its parent ticket failed", "notes": []})
            return jsonify({"ok": True, "results": results, "sprint_added": 0, "sprint_error": None})

    # ----- tasks -----
    seen: set[str] = set()
    for t in tasks:
        summary = fit_summary(t.get("summary"))
        if not summary:
            continue
        r = {"summary": summary, "role": "child", "category": t.get("category"),
             "issuetype": t.get("issuetype_name"), "notes": [], "parent": parent_key}
        results.append(r)
        if t.get("existing_key"):
            r.update(status="skipped", key=t["existing_key"], url=jira.issue_url(t["existing_key"]),
                     reason="Already in Jira", jira_status=t.get("current_status"))
            moves.append((r, t.get("status_id"), t.get("existing_type") or t.get("issuetype"),
                          t.get("current_status_id")))
            continue
        key_norm = normalize(summary)
        if key_norm in seen:
            r.update(status="skipped", reason="Listed twice in this upload")
            continue
        seen.add(key_norm)
        date = t.get("date")
        desc = [" ".join(t["summary"].split())]
        if date:
            desc.append(f"Work date: {date}")
        if t.get("category"):
            desc.append(f"Category: {t['category']}")
        desc.append("Created from document via Jira Task Uploader.")
        extra = [slug(t["category"])] if t.get("category") and not parent_key else []
        fields = task_fields(project, summary, t["issuetype"], "\n".join(desc), date, opts, assignee, extra)
        try:
            created = jira.create_child(fields, parent_key) if parent_key else jira.create_issue(fields)
        except JiraError as e:
            r.update(status="failed", reason=str(e))
            continue
        r.update(status="created", key=created["key"], url=jira.issue_url(created["key"]),
                 notes=finish_created(jira, created, assignee))
        moves.append((r, t.get("status_id"), t["issuetype"], None))

    # ----- statuses: tasks first, then the parent (some workflows block closing an open parent) -----
    if mover:
        for r, target, type_id, current in sorted(moves, key=lambda m: m[0]["role"] == "parent"):
            if target and r.get("key"):
                mover.move(r, target, type_id, current)

    # ----- sprint: sub-tasks follow their parent and epics cannot join sprints -----
    sprint_added, sprint_error = 0, None
    sprint_id = opts.get("sprint_id")
    sprint_role = "parent" if mode == "subtask" and parent_key else "child"
    in_sprint = [r for r in results if r["status"] == "created" and r["role"] == sprint_role]
    if sprint_id and in_sprint:
        try:
            jira.add_to_sprint(int(sprint_id), [r["key"] for r in in_sprint])
            sprint_added = len(in_sprint)
        except JiraError as e:
            sprint_error = str(e)
            for r in in_sprint:
                r["notes"].append("not in sprint")

    return jsonify({"ok": True, "results": results, "sprint_added": sprint_added, "sprint_error": sprint_error})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    if not HOSTED and os.environ.get("WERKZEUG_RUN_MAIN") != "true" and not os.environ.get("NO_BROWSER"):
        Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    app.run(host="0.0.0.0" if HOSTED else "127.0.0.1", port=port, debug=False)
