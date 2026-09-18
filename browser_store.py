"""Per-browser account storage, used when the app is hosted for many people.

Saved accounts live in the visitor's own session cookie, encrypted with a key derived from
the server's SECRET_KEY. Nothing is stored on the server, and one visitor can never see or
use another visitor's account. Same interface as store.py.
"""
import base64
import hashlib
import json
import uuid

from cryptography.fernet import Fernet, InvalidToken
from flask import current_app, session

MAX_PROFILES = 4  # keeps the cookie well under the 4 KB browser limit


def _fernet() -> Fernet:
    digest = hashlib.sha256(("jira-tool:" + current_app.secret_key).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt(profile: dict) -> str:
    return _fernet().encrypt(json.dumps(profile).encode()).decode()


def decrypt(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        return json.loads(_fernet().decrypt(token.encode()))
    except (InvalidToken, ValueError):
        return None


def _all() -> dict[str, dict]:
    out = {}
    for pid, token in (session.get("bp") or {}).items():
        profile = decrypt(token)
        if profile:
            out[pid] = profile
    return out


def public(profile: dict) -> dict:
    return {k: v for k, v in profile.items() if k != "secret"}


def list_profiles() -> list[dict]:
    return [public(p) for p in _all().values()]


def get_profile(profile_id: str | None) -> dict | None:
    if not profile_id:
        return None
    return decrypt((session.get("bp") or {}).get(profile_id))


def last_profile_id() -> str | None:
    return session.get("bp_last")


def save_profile(base_url: str, auth_type: str, username: str, secret: str,
                 display_name: str, account_email: str, api_base: str | None = None) -> dict:
    profiles = _all()
    profile_id = next((pid for pid, p in profiles.items()
                       if p["base_url"] == base_url and p["username"].lower() == username.lower()),
                      uuid.uuid4().hex)
    profile = {
        "id": profile_id, "base_url": base_url, "auth_type": auth_type, "username": username,
        "secret": secret, "display_name": display_name, "account_email": account_email,
        "api_base": api_base or base_url,
    }
    stored = {pid: encrypt(p) for pid, p in profiles.items() if pid != profile_id}
    stored[profile_id] = encrypt(profile)
    while len(stored) > MAX_PROFILES:  # drop the oldest saved account
        stored.pop(next(iter(stored)))
    session.permanent = True
    session["bp"] = stored
    session["bp_last"] = profile_id
    return profile


def set_last(profile_id: str | None) -> None:
    session["bp_last"] = profile_id


def delete_profile(profile_id: str) -> None:
    stored = dict(session.get("bp") or {})
    stored.pop(profile_id, None)
    session["bp"] = stored
    if session.get("bp_last") == profile_id:
        session["bp_last"] = None
