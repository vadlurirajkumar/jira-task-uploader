# Jira Task Uploader

Upload a daily-tasks document (`.txt`, `.md`, `.docx`, `.pdf`, `.xlsx` or `.csv`), review the
tasks it contains, and create one Jira ticket per task, grouped under one parent ticket per
category and moved to the status you choose. Sign in once; the tool remembers your
Jira account (encrypted on this computer) so the next run needs no password.

## Run locally

```
pip install -r requirements.txt
python app.py
```

The browser opens at http://127.0.0.1:5000 (or double-click `run.bat` on Windows).
Try it with `examples/sample-tasks.txt`.

## Deploy for free (Render)

The repo includes a Render Blueprint, `render.yaml`.

1. Sign in at https://render.com with GitHub.
2. Click **New > Blueprint** and pick this repository.
3. Click **Apply**. Render builds the app and gives you a `https://<name>.onrender.com` address.

The free plan sleeps after 15 minutes without visits. The first visit after that takes
about a minute to wake up.

**Hosted mode is different from local mode.** When `JIRA_TOOL_HOSTED=1` is set (the Blueprint
sets it), each visitor's saved Jira accounts are kept encrypted in their own browser cookie,
never on the server. Visitors never share an account. The server key comes from `SECRET_KEY`,
which the Blueprint generates. Hosted mode only connects to `https://` Jira sites on the public
internet, so self-hosted Jira inside a company network needs the local version.

## Sign in

| Jira type | Authentication | Username field | Token field |
|-----------|----------------|----------------|-------------|
| Jira Cloud (`*.atlassian.net`) | Email + API token | your Atlassian email | API token from https://id.atlassian.com/manage-profile/security/api-tokens |
| Jira Server / Data Center | Username + password | your Jira username | your password |
| Jira Server / Data Center | Personal access token | (not needed) | PAT from your Jira profile |

Both classic API tokens and scoped API tokens work on Jira Cloud. A scoped token is refused at the
site address, so the tool detects this and routes calls through `api.atlassian.com` automatically.
A scoped token needs the scopes `read:jira-user`, `read:jira-work` and `write:jira-work`, plus
`read:board-scope:jira-software`, `read:sprint:jira-software` and `write:sprint:jira-software` for sprints.

Tick **Remember me** and the account is saved to `~/.jira_tool/profiles.enc`
(encrypted with a key in `~/.jira_tool/key`). Next time the tool starts, you are
signed in automatically. Use **Sign out** to forget the current account, or
**Remove** on a saved account to delete it.

## Document format

Two layouts are understood.

### Category report (tables)

A report with one `Date | Task` table per work area, like a PDF or Word export:

```
Daily Tasks - September 2026          <- title (ignored)
Summary                               <- summary table, used only to check counts
| Category | No. of Tasks |
1. AWS Integration & Dashboard        <- numbered heading = category
| Date       | Task                          |
| 01/09/2026 | Hid findings overview and events |
```

* A numbered heading (`1. Reports`), a Markdown heading (`## Reports`) or a Word heading above a
  table sets the category for its rows. A table at the top of a page with no heading continues
  the previous category.
* Optional columns: `Category`, `Status`, `Type`. Excel sheets with `Category | Date | Task`
  columns work too; rows repeated on another sheet are ignored.
* If the document has a summary table (`Category | No. of Tasks`), the review screen confirms
  every task was found, or names the categories whose counts differ.
* Rows such as `On Leave` are listed but not selected.

### Daily log (bullets)

The parser understands:

* Date headers such as `Date:- 01/09/2026`, `1 Sep 2026`, `September 1, 2026`, `2026-09-01`
  (numeric dates are read as day/month/year when ambiguous). The date applies to every task below it.
* Bullets: `->`, `-`, `*`, `•`, `1.`, `1)`, `[ ]`.
* Separator lines (`=====`, `-----`) and titles are ignored.
* If a document has no bullets at all, each non-empty line is treated as a task.

Example:

```
Date:- 01/09/2026
 -> hide view details button for passed guardrails
 -> rescan disabled for viewer
Date:- 02/09/2026
 -> ui bugs for internal reports
```

### Bug / Feature / Task detection

Each task gets an issue type automatically, checked in this order:

1. **A tag on the line**: `[Bug] login broken`, `(feature) dark mode`, `Task: update docs`, `export report #bug`.
2. **A heading above it**: lines under `Bugs:`, `Features` or `## Tasks` (until the next date).
3. **A keyword in the text**: bug, defect, hotfix → Bug. feature, enhancement, story → Feature. task, chore → Task.
4. Otherwise the **default issue type** chosen in the sidebar.

Kinds map to the project's issue types by name. Bug maps to *Bug* or *Defect*. Feature maps to
*Feature*, *New Feature* or *Story*, whichever the project has first. Task maps to *Task*. The
sidebar shows the mapping for the selected project, and you can change any row's type in the table.

After parsing you can edit summaries and dates, untick tasks, or add rows before creating tickets.

### Parent tickets and child tasks

When the document has categories, each category becomes a parent and its tasks become children,
so 54 tasks in 11 categories become 11 parents + 54 child tasks (65 tickets). Choose how in
**Parent tickets**:

| Option | Parent | Tasks | Sprint |
|--------|--------|-------|--------|
| Parent ticket with sub-tasks (default) | Story or Task | Sub-tasks | The parent joins the sprint; sub-tasks follow it |
| Epic with child issues | Epic | Keep their Bug/Story/Task type, linked to the epic | The tasks join the sprint |
| No parent | none | One ticket each, category added as a label | The tasks join the sprint |

The **parent name suffix** (filled from the document, e.g. `September 2026`) is added to every
parent name. Clear it to reuse the same parents every month. Click a parent name to rename it.

### Status

Each row has a status picked from the project's real workflow (for example Dev, QA, Prod,
Completed). It comes from, in order: your choice in the row, the ticket's current status if it
is already in Jira, a `Status` column or phrase in the task (`in progress`, `incomplete`,
`pending`, `completed`, `moved to prod`, `[done]`, `(wip)`), or the **Default status**. A parent's
status follows its least advanced task unless you set one.

After creating, the tool walks each ticket through the workflow to its status, one transition at
a time if the workflow has no direct step. Sub-tasks with a simpler workflow get the nearest
status of the same kind (e.g. `Done` for `Completed`).

### Already in Jira

The **In Jira** column shows which tasks and parents already exist (issues you reported in the
project with the same summary), with their key and status. Existing tickets are not created
again; if you change their status in the table, re-uploading moves them in Jira. Re-uploading
the same file with nothing changed creates nothing.

## Creating tickets

* Pick the project and issue type (defaults to *Task* when it exists).
* **Sprint**: lists the active and future sprints of the project's scrum boards and preselects the
  current (active) sprint. New tickets are moved into it after they are created. Pick
  *Backlog (no sprint)* to leave them in the backlog. Kanban boards have no sprints.
* **Assign the tickets to me** (default on): every new ticket is assigned to the signed-in account.
  If the project's create screen has no assignee field, the tool assigns the ticket right after creating it.
* **Skip duplicates** (default on): the tool looks up issues you reported in that project and
  skips any task whose summary already exists. Re-uploading the same growing file every day only
  creates the new tasks.
* **Due date**: optionally sets the task's date as the issue due date.
* **Prefix date**: optionally makes the summary `2026-09-01 - task text`.
* Each issue's description contains the full task text and the work date. If the project's
  create screen does not allow labels, due date or description, the tool retries without them.

Results show how many tickets this upload now has in Jira (parents and child tasks counted
separately, with a count per status), a link to every ticket, **Open all in Jira** (one search
listing them all), and the reason for anything skipped or failed.

## Files

| File | Purpose |
|------|---------|
| `app.py` | Flask server and REST endpoints |
| `doc_parser.py` | Text and table extraction (txt/md/docx/pdf/xlsx/csv), task, category and status parsing |
| `jira_client.py` | Jira REST API v2 client (Cloud and Server) |
| `store.py` | Encrypted saved-account storage on this computer (local mode) |
| `browser_store.py` | Encrypted saved-account storage in the browser cookie (hosted mode) |
| `diagnose.py` | Step-by-step login check that prints Jira's raw answers |
| `render.yaml`, `Procfile` | Free hosting configuration |
| `templates/index.html`, `static/` | Browser UI |
