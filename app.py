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
from doc_parser import extract_text, parse_tasks
from jira_client import Jira, JiraError, clean_url, map_kinds, normalize

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

ALLOWED_EXT = (".txt", ".md", ".text", ".docx", ".pdf", ".log", ".csv")


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
    return render_template("index.html")


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


# ---------- document parsing ----------

@app.post("/api/parse")
def api_parse():
    if "file" in request.files and request.files["file"].filename:
        f = request.files["file"]
        name = f.filename
        if not name.lower().endswith(ALLOWED_EXT):
            return error("Unsupported file type. Upload .txt, .md, .docx or .pdf.")
        try:
            text = extract_text(name, f.read())
        except ValueError as e:
            return error(str(e))
        except Exception as e:  # corrupt file etc.
            return error(f"Could not read the document: {e}")
    else:
        text = (request.form.get("text") or "").strip()
        name = "pasted text"
        if not text:
            return error("Upload a file or paste some text.")
    tasks = parse_tasks(text)
    return jsonify({"ok": True, "filename": name, "tasks": tasks, "raw_lines": len(text.splitlines())})


# ---------- ticket creation ----------

@app.post("/api/create")
def api_create():
    profile = current_profile()
    if not profile:
        return error("Your session has ended. Sign in again.", 401)
    body = request.get_json(force=True) or {}
    project = body.get("project")
    issuetype = body.get("issuetype")
    tasks = body.get("tasks") or []
    opts = body.get("options") or {}
    if not project or not (issuetype or all(t.get("issuetype") for t in tasks)):
        return error("Choose a project and a default issue type.")
    if not tasks:
        return error("No tasks selected.")

    jira = jira_for(profile)
    assignee = None
    if opts.get("assign_to_me", True):
        try:
            assignee = Jira.user_ref(jira.myself())
        except JiraError as e:
            return error(f"Could not look up your Jira account for assigning: {e}", 502)
    sprint_id = opts.get("sprint_id")
    existing: set[str] = set()
    if opts.get("skip_duplicates", True):
        try:
            existing = jira.existing_summaries(project)
        except JiraError as e:
            return error(f"Could not check for duplicates: {e}", 502)

    results = []
    seen_in_batch: set[str] = set()
    for t in tasks:
        summary = " ".join((t.get("summary") or "").split())
        if not summary:
            continue
        date = t.get("date")
        if opts.get("prefix_date") and date:
            summary = f"{date} - {summary}"
        key_norm = normalize(summary)
        if key_norm in existing or key_norm in seen_in_batch:
            results.append({"summary": summary, "status": "skipped", "reason": "Already exists in Jira"})
            continue
        seen_in_batch.add(key_norm)

        full_summary = summary
        if len(summary) > 255:
            summary = summary[:252] + "..."
        desc_lines = [full_summary]
        if date:
            desc_lines.append(f"Work date: {date}")
        desc_lines.append(f"Created from document via Jira Task Uploader.")
        fields = {
            "project": {"key": project},
            "issuetype": {"id": str(t.get("issuetype") or issuetype)},
            "summary": summary,
            "description": "\n".join(desc_lines),
        }
        labels = [l.strip() for l in (opts.get("labels") or "").split(",") if l.strip()]
        if labels:
            fields["labels"] = [l.replace(" ", "-") for l in labels]
        if opts.get("set_due_date") and date:
            fields["duedate"] = date
        if assignee:
            fields["assignee"] = assignee
        try:
            created = jira.create_issue(fields)
        except JiraError as e:
            results.append({"summary": summary, "status": "failed", "reason": str(e)})
            continue
        existing.add(key_norm)
        notes = []
        dropped = created.get("dropped_fields", [])
        if "assignee" in dropped:
            # Assignee is not on the create screen: assign in a second step.
            dropped.remove("assignee")
            try:
                jira.assign(created["key"], assignee)
            except JiraError as e:
                notes.append(f"not assigned: {e}")
        if dropped:
            notes.append("created without: " + ", ".join(dropped))
        results.append({
            "summary": summary, "status": "created", "key": created["key"],
            "issuetype": t.get("issuetype_name"),
            "url": jira.issue_url(created["key"]), "notes": notes,
        })

    sprint_note = None
    new_keys = [r["key"] for r in results if r["status"] == "created"]
    if sprint_id and new_keys:
        try:
            jira.add_to_sprint(int(sprint_id), new_keys)
            sprint_note = f"Added {len(new_keys)} ticket(s) to the sprint."
        except JiraError as e:
            sprint_note = f"Tickets were created but could not be added to the sprint: {e}"
            for r in results:
                if r["status"] == "created":
                    r["notes"].append("not in sprint")

    counts = {s: sum(1 for r in results if r["status"] == s) for s in ("created", "skipped", "failed")}
    return jsonify({"ok": True, "results": results, "counts": counts, "sprint_note": sprint_note})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    if not HOSTED and os.environ.get("WERKZEUG_RUN_MAIN") != "true" and not os.environ.get("NO_BROWSER"):
        Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    app.run(host="0.0.0.0" if HOSTED else "127.0.0.1", port=port, debug=False)
