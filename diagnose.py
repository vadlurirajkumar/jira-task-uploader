"""Check a Jira login step by step and print exactly what Jira answers.

Run:  python diagnose.py
The token is typed hidden and is never saved or printed.
"""
import getpass

import requests

from jira_client import clean_url, cloud_api_base

INTERESTING_HEADERS = ("X-Seraph-LoginReason", "X-Authentication-Denied-Reason",
                       "WWW-Authenticate", "X-AAccountId")


def show(label, r):
    print(f"\n== {label}: HTTP {r.status_code}")
    for h in INTERESTING_HEADERS:
        if h in r.headers:
            print(f"   {h}: {r.headers[h]}")
    body = r.text.strip().replace("\n", " ")
    print("   body:", body[:400] or "(empty)")


def main():
    base = clean_url(input("Jira URL (e.g. https://yourcompany.atlassian.net): "))
    project = input("Project key to check (e.g. PROD, optional): ").strip().upper()
    email = input("Atlassian email: ").strip()
    token = getpass.getpass("API token (hidden): ").strip()
    print(f"\nSite: {base}   email: {email}   token length: {len(token)}")

    s = requests.Session()
    s.auth = (email, token)
    s.headers["Accept"] = "application/json"

    show("Server info (no login needed)", s.get(f"{base}/rest/api/2/serverInfo", auth=None, timeout=30))
    me = s.get(f"{base}/rest/api/2/myself", timeout=30)
    show("Who am I (site address)", me)
    if not me.ok and base.endswith(".atlassian.net"):
        gateway = cloud_api_base(base)
        if gateway:
            base = gateway
            me = s.get(f"{base}/rest/api/2/myself", timeout=30)
            show("Who am I (scoped-token gateway)", me)
    if me.ok:
        show("Projects", s.get(f"{base}/rest/api/2/project", timeout=30))
        if project:
            show(f"{project} project", s.get(f"{base}/rest/api/2/project/{project}", timeout=30))
            show(f"Create permission on {project}",
                 s.get(f"{base}/rest/api/2/mypermissions",
                       params={"projectKey": project, "permissions": "BROWSE_PROJECTS,CREATE_ISSUES"}, timeout=30))


if __name__ == "__main__":
    main()
