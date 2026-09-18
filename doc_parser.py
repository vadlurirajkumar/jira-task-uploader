"""Extract tasks from .txt / .md / .docx / .pdf documents.

Rules:
  * A line that is (or starts with) a date becomes the current date context.
  * Bullet lines ("->", "-", "*", "•", "1.", "1)") become tasks.
  * If the document has no bullet lines at all, every other non-empty line is a task.
  * Separator lines (====, ----) and empty lines are ignored.
  * Each task gets a kind: "bug", "feature" or "task", detected (in priority order) from
      1. an explicit tag on the task:  "[Bug] ...", "(feature) ...", "Bug: ...", "Task - ...", "... #bug"
      2. a section heading above it:  "Bugs:", "Features", "## Tasks"
      3. a keyword in the text:        "bug", "defect", "hotfix" / "feature", "enhancement", "story" / "task"
    Tasks with no kind use the default issue type chosen in the app.
"""
import io
import re
from datetime import date

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}

DASHES = "–—"  # en dash, em dash
DATE_NUMERIC = re.compile(r"(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})")
DATE_TEXT_1 = re.compile(r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})")   # 1 Sep 2026
DATE_TEXT_2 = re.compile(r"([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})")   # Sep 1, 2026
DATE_LINE = re.compile(rf"^\s*(?:date\s*[:\-{DASHES}]*\s*)?(?P<d>.+?)\s*[:\-{DASHES}]*\s*$", re.I)
BULLET = re.compile(
    r"^\s*(?:->|=>|[-*•·▪◦‣]+|\d+[.)]|[a-zA-Z][.)]|\[[ xX]?\])\s+(?P<text>.+?)\s*$")
SEPARATOR = re.compile(r"^[\s=\-_*#~.]+$")

# ---------- bug / feature / task detection ----------

KIND_WORDS = {
    "bug": r"bugs?|defects?|hotfix(?:es)?|bugfix(?:es)?",
    "feature": r"new\s+features?|features?|enhancements?|stor(?:y|ies)",
    "task": r"tasks?|chores?",
}
_ANY_KIND = "|".join(KIND_WORDS.values())
_KIND_RE = {k: re.compile(rf"^(?:{v})$", re.I) for k, v in KIND_WORDS.items()}
_SEP = rf":\-{DASHES}|"
# "[Bug] x", "(bug) x", "{bug} x", "Bug: x", "Bug - x", "Bug | x"
TAG_PREFIX = re.compile(
    rf"^\s*(?:[\[({{]\s*(?P<w1>{_ANY_KIND})\s*[\])}}]\s*[{_SEP}]?"
    rf"|(?P<w2>{_ANY_KIND})\s*[{_SEP}])\s*", re.I)
# "x [bug]", "x (feature)", "x #bug"
TAG_SUFFIX = re.compile(
    rf"\s*(?:[\[({{]\s*(?P<w1>{_ANY_KIND})\s*[\])}}]|#(?P<w2>{_ANY_KIND}))\s*$", re.I)
# Heading lines such as "Bugs:", "## Features", "Tasks -"
SECTION = re.compile(rf"^\s*#*\s*(?P<w1>{_ANY_KIND})\s*[:\-{DASHES}]*\s*$", re.I)
KEYWORD = re.compile(rf"\b(?P<w1>{_ANY_KIND})\b", re.I)


def _kind_of(match: re.Match) -> str | None:
    groups = match.groupdict()
    word = re.sub(r"\s+", " ", groups.get("w1") or groups.get("w2") or "")
    return next((k for k, rx in _KIND_RE.items() if rx.match(word)), None)


def detect_kind(text: str) -> tuple[str, str | None, str | None]:
    """Return (text without tag, kind, source) where source is 'tag' or 'keyword'."""
    m = TAG_PREFIX.match(text)
    if m and m.end() < len(text):
        return text[m.end():].strip(), _kind_of(m), "tag"
    m = TAG_SUFFIX.search(text)
    if m and m.start() > 0:
        return text[:m.start()].strip(), _kind_of(m), "tag"
    kinds = {_kind_of(k) for k in KEYWORD.finditer(text)}
    # A bug mention wins ("feature X has a bug"), then feature, then task.
    for k in ("bug", "feature", "task"):
        if k in kinds:
            return text, k, "keyword"
    return text, None, None


# ---------- dates ----------

def _month(name: str) -> int | None:
    return MONTHS.get(name[:3].lower())


def parse_date(text: str) -> date | None:
    """Return a date if the text is a date (dd/mm/yyyy assumed when ambiguous)."""
    text = text.strip()
    m = DATE_NUMERIC.fullmatch(text)
    if m:
        a, b, c = (int(x) for x in m.groups())
        try:
            if a > 31:                      # yyyy-mm-dd
                return date(a, b, c)
            if c < 100:
                c += 2000
            if a > 12 and b <= 12:          # dd/mm
                return date(c, b, a)
            if b > 12 and a <= 12:          # mm/dd
                return date(c, a, b)
            return date(c, b, a)            # ambiguous -> day first
        except ValueError:
            return None
    m = DATE_TEXT_1.fullmatch(text)
    if m and _month(m.group(2)):
        try:
            return date(int(m.group(3)), _month(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    m = DATE_TEXT_2.fullmatch(text)
    if m and _month(m.group(1)):
        try:
            return date(int(m.group(3)), _month(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
    return None


def line_date(line: str) -> date | None:
    """Detect a date header line such as 'Date:- 01/09/2026' or '## 1 Sep 2026'."""
    stripped = line.strip().lstrip("#").strip()
    if not stripped or len(stripped) > 40:
        return None
    m = DATE_LINE.match(stripped)
    if not m:
        return None
    return parse_date(m.group("d"))


# ---------- text extraction ----------

def extract_text(filename: str, data: bytes) -> str:
    name = filename.lower()
    if name.endswith(".docx"):
        import docx
        document = docx.Document(io.BytesIO(data))
        parts = []
        for p in document.paragraphs:
            style = (p.style.name or "").lower() if p.style is not None else ""
            text = p.text
            if "list" in style and text.strip() and not BULLET.match(text):
                text = "- " + text.strip()
            parts.append(text)
        for table in document.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells]
                parts.append(" | ".join(c for c in cells if c))
        return "\n".join(parts)
    if name.endswith(".pdf"):
        import pymupdf
        with pymupdf.open(stream=data, filetype="pdf") as pdf:
            return "\n".join(page.get_text() for page in pdf)
    if name.endswith(".doc"):
        raise ValueError("Legacy .doc files are not supported. Save it as .docx and try again.")
    for enc in ("utf-8-sig", "utf-16", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


# ---------- task extraction ----------

def parse_tasks(text: str) -> list[dict]:
    lines = text.splitlines()
    has_bullets = any(BULLET.match(l) for l in lines)
    tasks: list[dict] = []
    current: date | None = None
    section_kind: str | None = None
    for raw in lines:
        line = raw.rstrip()
        if not line.strip() or SEPARATOR.match(line):
            continue
        d = line_date(line)
        if d:
            current = d
            section_kind = None  # each day starts without a section
            continue
        bullet = BULLET.match(line)
        section = None if bullet else SECTION.match(line)
        if section:
            section_kind = _kind_of(section)
            continue
        if bullet:
            text_ = bullet.group("text").strip()
        elif has_bullets:
            continue  # headings / titles between bullets are not tasks
        else:
            text_ = line.strip()
        if not text_:
            continue
        text_, kind, source = detect_kind(text_)
        if source != "tag" and section_kind:
            kind, source = section_kind, "section"
        tasks.append({
            "id": len(tasks) + 1,
            "date": current.isoformat() if current else None,
            "summary": text_,
            "kind": kind,
            "kind_source": source,
        })
    return tasks
