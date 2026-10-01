"""Thin Jira REST client (API v2 works on both Jira Cloud and Server/Data Center)."""
import re
from urllib.parse import urlsplit

import requests


class JiraError(Exception):
    pass


UI_PATH_MARKERS = re.compile(
    r"/(?:jira/(?:software|servicedesk|core|your-work|projects|dashboards|people|filters|plans)\b"
    r"|browse/|secure/|projects/|issues/|plugins/|rest/|servicedesk/|login\.jsp)",
    re.I)


def clean_url(url: str) -> str:
    """Reduce any pasted Jira page URL (board, issue, backlog...) to the site base URL."""
    url = url.strip()
    if not url:
        return ""
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    parts = urlsplit(url)
    origin = f"{parts.scheme.lower()}://{parts.netloc}"
    # Jira Cloud never has a context path.
    if parts.hostname and parts.hostname.lower().endswith(".atlassian.net"):
        return origin
    # Jira Server may live under a context path like https://host/jira - keep it,
    # but cut everything from the first UI page segment onwards.
    path = parts.path
    m = UI_PATH_MARKERS.search(path)
    if m:
        path = path[:m.start()]
    return origin + path.rstrip("/")


def cloud_api_base(site_url: str) -> str | None:
    """Gateway base URL for a Jira Cloud site, needed by scoped API tokens."""
    try:
        r = requests.get(f"{site_url}/_edge/tenant_info", timeout=15)
        cloud_id = r.json().get("cloudId") if r.ok else None
    except (requests.RequestException, ValueError):
        return None
    return f"https://api.atlassian.com/ex/jira/{cloud_id}" if cloud_id else None


class Jira:
    def __init__(self, base_url: str, auth_type: str, username: str, secret: str,
                 api_base: str | None = None):
        self.base_url = clean_url(base_url)          # used for links to issues
        self.api_base = api_base or self.base_url    # used for REST calls
        self.auth_type = auth_type
        self._fields: dict | None = None
        self._initial_status: dict[str, str] = {}   # issue type id -> status id of a new issue
        self._paths: dict[tuple, list] = {}         # (from, to, type) -> transitions that worked
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json", "Content-Type": "application/json"})
        if auth_type == "bearer":
            self.session.headers["Authorization"] = f"Bearer {secret}"
        else:
            self.session.auth = (username, secret)

    # ----- helpers -----
    def _req(self, method: str, path: str, api: str = "api/2", **kw):
        url = f"{self.api_base}/rest/{api}/{path.lstrip('/')}"
        try:
            r = self.session.request(method, url, timeout=30, **kw)
        except requests.RequestException as e:
            raise JiraError(f"Could not reach {self.api_base}: {e}") from e
        if r.status_code in (401, 403):
            raise JiraError(self._auth_error(r, method, f"/rest/{api}/{path.lstrip('/')}"))
        if r.status_code >= 400:
            raise JiraError(self._error_text(r))
        if r.status_code == 204 or not r.content:
            return None
        try:
            return r.json()
        except ValueError:
            raise JiraError(
                f"Unexpected non-JSON response from {url}. Use your Jira site address, "
                f"e.g. https://yourcompany.atlassian.net")

    def _auth_error(self, r: requests.Response, method: str, path: str) -> str:
        where = f"{method} {path}"
        denied = (r.headers.get("X-Authentication-Denied-Reason") or "").upper()
        if "CAPTCHA" in denied:
            return ("Jira locked this account behind a CAPTCHA after failed logins. Log out of Jira "
                    "in your browser, log back in and solve the CAPTCHA, then try again here.")
        detail = self._error_text(r)
        if r.status_code == 401:
            if self.auth_type == "bearer":
                hint = ("Check the personal access token is complete and not expired or revoked. "
                        "Create a new one in Jira under Profile > Personal Access Tokens.")
            elif (urlsplit(self.base_url).hostname or "").lower().endswith(".atlassian.net"):
                hint = "Use your Atlassian email and an API token, not your account password."
            else:
                hint = "Check your username and password or token."
            return f"Authentication failed (401) on {where}. {hint} {detail}"
        return (f"Forbidden (403) on {where}. Jira says: {detail}. If this happens at sign-in, check the "
                f"token was copied fully and your account has Jira access on this site. If it happens "
                f"later, your token or account is missing the permission or scope for this action.")

    @staticmethod
    def _error_text(r: requests.Response) -> str:
        try:
            body = r.json()
            msgs = list(body.get("errorMessages", []))
            msgs += [f"{k}: {v}" for k, v in body.get("errors", {}).items()]
            if msgs:
                return f"Jira error {r.status_code}: " + "; ".join(msgs)
        except ValueError:
            pass
        return f"Jira error {r.status_code}: {r.text[:300]}"

    # ----- API -----
    def myself(self) -> dict:
        return self._req("GET", "myself")

    def connect(self) -> dict:
        """Verify the login. Scoped API tokens are refused at the site address, so for
        Jira Cloud fall back to the api.atlassian.com gateway before giving up."""
        try:
            return self.myself()
        except JiraError as site_error:
            is_cloud = (urlsplit(self.base_url).hostname or "").lower().endswith(".atlassian.net")
            if not is_cloud or self.api_base != self.base_url:
                raise
            gateway = cloud_api_base(self.base_url)
            if not gateway:
                raise
            self.api_base = gateway
            try:
                return self.myself()
            except JiraError as gateway_error:
                self.api_base = self.base_url
                raise JiraError(f"{site_error} Also tried the scoped-token gateway: {gateway_error}")

    def projects(self) -> list[dict]:
        data = self._req("GET", "project")
        return sorted(
            [{"key": p["key"], "name": p["name"], "id": p["id"]} for p in data],
            key=lambda p: p["name"].lower(),
        )

    def issue_types(self, project_key: str) -> list[dict]:
        """All issue types of the project, sub-task types included (flagged)."""
        data = self._req("GET", f"project/{project_key}")
        return [
            {"id": t["id"], "name": t["name"], "subtask": bool(t.get("subtask")),
             "epic": t.get("hierarchyLevel") == 1 or t["name"].strip().lower() == "epic"}
            for t in data.get("issueTypes", [])
        ]

    def statuses(self, project_key: str) -> dict:
        """Statuses of the project's workflows ordered To Do -> In Progress -> Done,
        plus the status ids each issue type can use."""
        data = self._req("GET", f"project/{project_key}/statuses")
        found: dict[str, dict] = {}
        by_type: dict[str, list[str]] = {}
        for it in data:
            ids = []
            for s in it.get("statuses", []):
                cat = (s.get("statusCategory") or {}).get("key") or "indeterminate"
                found.setdefault(s["id"], {"id": s["id"], "name": s["name"], "category": cat})
                ids.append(s["id"])
            by_type[it["id"]] = ids
        ordered = sorted(found.values(), key=lambda s: STATUS_CATEGORY_ORDER.get(s["category"], 1))
        return {"statuses": ordered, "by_type": by_type}

    def existing_issues(self, project_key: str) -> dict[str, dict]:
        """Issues in the project reported by the current user, keyed by normalized summary
        (for de-duplication and for showing what is already in Jira)."""
        jql = f'project = "{project_key}" AND reporter = currentUser() ORDER BY created DESC'
        fields = "summary,status,issuetype"
        found: dict[str, dict] = {}

        def add(issues):
            for issue in issues:
                f = issue["fields"]
                st = f.get("status") or {}
                found.setdefault(normalize(f["summary"]), {
                    "key": issue["key"], "url": self.issue_url(issue["key"]),
                    "status": st.get("name"), "status_id": st.get("id"),
                    "category": (st.get("statusCategory") or {}).get("key"),
                    "issuetype": (f.get("issuetype") or {}).get("id"),
                })

        # New endpoint (Jira Cloud): /search/jql with nextPageToken paging.
        try:
            token = None
            while True:
                params = {"jql": jql, "fields": fields, "maxResults": 100}
                if token:
                    params["nextPageToken"] = token
                data = self._req("GET", "search/jql", params=params)
                add(data.get("issues", []))
                token = data.get("nextPageToken")
                if not token or data.get("isLast", True):
                    break
            return found
        except JiraError as e:
            if "404" not in str(e) and "410" not in str(e):
                raise
        # Legacy endpoint (Jira Server / Data Center): /search with startAt paging.
        start = 0
        while True:
            data = self._req("GET", "search", params={
                "jql": jql, "fields": fields, "maxResults": 100, "startAt": start})
            issues = data.get("issues", [])
            add(issues)
            start += len(issues)
            if not issues or start >= data.get("total", 0):
                break
        return found

    def create_issue(self, fields: dict, optional: tuple = ()) -> dict:
        """Create an issue. If optional fields (duedate/labels/description/assignee, plus any
        passed in `optional`) are rejected because they are not on the project's create
        screen, retry without them."""
        dropped: list[str] = []
        attempt = dict(fields)
        for _ in range(4):
            try:
                data = self._req("POST", "issue", json={"fields": attempt})
                data["dropped_fields"] = dropped
                return data
            except JiraError as e:
                msg = str(e)
                removable = [f for f in ("duedate", "labels", "description", "assignee", *optional)
                             if f in attempt and f in msg]
                if not removable:
                    raise
                for f in removable:
                    attempt.pop(f, None)
                    dropped.append(f)
        raise JiraError("Could not create issue after removing optional fields.")

    def epic_fields(self) -> dict:
        """Ids of the Jira Server/Data Center 'Epic Link' and 'Epic Name' fields, if present."""
        if self._fields is None:
            try:
                data = self._req("GET", "field")
            except JiraError:
                data = []
            self._fields = {}
            for f in data:
                custom = (f.get("schema") or {}).get("custom") or ""
                if custom.endswith(":gh-epic-link"):
                    self._fields["epic_link"] = f["id"]
                elif custom.endswith(":gh-epic-label"):
                    self._fields["epic_name"] = f["id"]
        return self._fields

    def create_child(self, fields: dict, parent_key: str) -> dict:
        """Create an issue under a parent: a sub-task, or an issue in an epic. Jira Server /
        Data Center links issues to epics with the 'Epic Link' field instead of 'parent'."""
        try:
            return self.create_issue({**fields, "parent": {"key": parent_key}})
        except JiraError as e:
            link = self.epic_fields().get("epic_link")
            if not link or "parent" not in str(e).lower():
                raise
        return self.create_issue({**fields, link: parent_key})

    # ----- workflow status -----
    def initial_status(self, key: str, type_id: str) -> str:
        """Status id a newly created issue starts in (fetched once per issue type)."""
        if type_id not in self._initial_status:
            data = self._req("GET", f"issue/{key}", params={"fields": "status"})
            self._initial_status[type_id] = data["fields"]["status"]["id"]
        return self._initial_status[type_id]

    def _transition(self, key: str, transition_id: str) -> None:
        self._req("POST", f"issue/{key}/transitions", json={"transition": {"id": str(transition_id)}})

    def move_to_status(self, key: str, current: str, target: str, rank: dict[str, int],
                       type_id: str = "", max_steps: int = 8) -> str:
        """Walk the workflow from status `current` to status `target`; returns the final status name.
        Jira only lists the transitions out of the current status, so when the target is not one
        step away this takes the step that gets closest to it (statuses ranked To Do -> Done)
        without revisiting a status. A path that worked is replayed for the next issue."""
        memo = (current, target, type_id)
        name = None
        for tid, to_id, to_name in self._paths.get(memo, []):
            try:
                self._transition(key, tid)
            except JiraError:
                break
            current, name = to_id, to_name
        if current == target:
            return name
        start, path, visited = current, [], {current}
        goal = rank.get(target, 0)
        for _ in range(max_steps):
            options = self._req("GET", f"issue/{key}/transitions").get("transitions", [])
            pick = next((t for t in options if t["to"]["id"] == target), None)
            if not pick:
                here = rank.get(current, goal)
                fresh = [t for t in options if t["to"]["id"] not in visited]
                if not fresh:
                    break

                def closeness(t):
                    r = rank.get(t["to"]["id"], here)
                    between = min(here, goal) < r < max(here, goal)
                    return (0 if between else 1, abs(goal - r))
                pick = min(fresh, key=closeness)
            self._transition(key, pick["id"])
            current, name = pick["to"]["id"], pick["to"]["name"]
            path.append((pick["id"], current, name))
            if current == target:
                if start == memo[0]:
                    self._paths[memo] = path
                return name
            visited.add(current)
        where = f" It is now in '{name}'." if name else ""
        raise JiraError(f"The workflow has no path to that status from here.{where}")

    # ----- assignee -----
    @staticmethod
    def user_ref(me: dict) -> dict:
        """Assignee reference: accountId on Jira Cloud, username on Server/Data Center."""
        if me.get("accountId"):
            return {"accountId": me["accountId"]}
        return {"name": me.get("name") or me.get("key")}

    def assign(self, key: str, user_ref: dict) -> None:
        self._req("PUT", f"issue/{key}/assignee", json=user_ref)

    # ----- sprints (Jira Software Agile API) -----
    def boards(self, project_key: str) -> list[dict]:
        boards, start = [], 0
        while True:
            data = self._req("GET", "board", api="agile/1.0",
                             params={"projectKeyOrId": project_key, "startAt": start, "maxResults": 50})
            values = data.get("values", [])
            boards += values
            start += len(values)
            if data.get("isLast", True) or not values:
                return boards

    def sprints(self, project_key: str) -> list[dict]:
        """Active and future sprints on the project's boards: newest active sprint first,
        then future sprints in order."""
        found: dict[int, dict] = {}
        for board in self.boards(project_key):
            if board.get("type") == "kanban":
                continue  # kanban boards have no sprints; scrum and team-managed ("simple") boards may
            start = 0
            while True:
                try:
                    data = self._req("GET", f"board/{board['id']}/sprint", api="agile/1.0",
                                     params={"state": "active,future", "startAt": start, "maxResults": 50})
                except JiraError:
                    break
                values = data.get("values", [])
                for s in values:
                    # Boards can share sprints; keep sprints that belong to this project's boards.
                    found.setdefault(s["id"], {
                        "id": s["id"], "name": s["name"], "state": s["state"],
                        "board": board.get("name", ""),
                        "own_board": s.get("originBoardId") in (None, board["id"]),
                    })
                start += len(values)
                if data.get("isLast", True) or not values:
                    break
        order = {"active": 0, "future": 1}
        return sorted(found.values(), key=lambda s: (
            order.get(s["state"], 2), not s["own_board"], -s["id"] if s["state"] == "active" else s["id"]))

    def add_to_sprint(self, sprint_id: int, keys: list[str]) -> None:
        for i in range(0, len(keys), 50):  # Jira accepts at most 50 issues per call
            self._req("POST", f"sprint/{sprint_id}/issue", api="agile/1.0", json={"issues": keys[i:i + 50]})

    def issue_url(self, key: str) -> str:
        return f"{self.base_url}/browse/{key}"


# Issue type names tried, in order, for each kind detected in the document.
KIND_TYPE_NAMES = {
    "bug": ["Bug", "Defect", "Problem"],
    "feature": ["Feature", "New Feature", "Story", "User Story", "Improvement", "Enhancement"],
    "task": ["Task"],
}


STATUS_CATEGORY_ORDER = {"new": 0, "indeterminate": 1, "done": 2}


def map_kinds(issue_types: list[dict]) -> dict[str, str | None]:
    """Map bug/feature/task to the id of the best matching (non sub-task) issue type in a project."""
    by_name = {t["name"].strip().lower(): t["id"] for t in issue_types if not t.get("subtask")}
    return {
        kind: next((by_name[n.lower()] for n in names if n.lower() in by_name), None)
        for kind, names in KIND_TYPE_NAMES.items()
    }


def fit_summary(summary: str) -> str:
    """Summary as Jira stores it: one line, at most 255 characters."""
    summary = " ".join((summary or "").split())
    return summary[:252] + "..." if len(summary) > 255 else summary


def normalize(summary: str) -> str:
    return re.sub(r"\s+", " ", summary).strip().lower()
