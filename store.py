"""Encrypted local storage for Jira profiles (so you only sign in once)."""
import json
import os
import uuid
from pathlib import Path

from cryptography.fernet import Fernet

DATA_DIR = Path(os.environ.get("JIRA_TOOL_HOME", Path.home() / ".jira_tool"))
KEY_FILE = DATA_DIR / "key"
STORE_FILE = DATA_DIR / "profiles.enc"


def _fernet() -> Fernet:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not KEY_FILE.exists():
        KEY_FILE.write_bytes(Fernet.generate_key())
        try:
            os.chmod(KEY_FILE, 0o600)
        except OSError:
            pass
    return Fernet(KEY_FILE.read_bytes())


def _load() -> dict:
    if not STORE_FILE.exists():
        return {"profiles": {}, "last_profile": None}
    try:
        raw = _fernet().decrypt(STORE_FILE.read_bytes())
        return json.loads(raw)
    except Exception:
        return {"profiles": {}, "last_profile": None}


def _save(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STORE_FILE.write_bytes(_fernet().encrypt(json.dumps(data).encode()))
    try:
        os.chmod(STORE_FILE, 0o600)
    except OSError:
        pass


def public(profile: dict) -> dict:
    """Profile without the secret, safe to send to the browser."""
    return {k: v for k, v in profile.items() if k != "secret"}


def list_profiles() -> list[dict]:
    data = _load()
    return [public(p) for p in data["profiles"].values()]


def get_profile(profile_id: str | None) -> dict | None:
    if not profile_id:
        return None
    return _load()["profiles"].get(profile_id)


def last_profile_id() -> str | None:
    return _load().get("last_profile")


def save_profile(base_url: str, auth_type: str, username: str, secret: str,
                 display_name: str, account_email: str, api_base: str | None = None) -> dict:
    data = _load()
    # Reuse an existing profile for the same site + user instead of duplicating.
    for pid, p in data["profiles"].items():
        if p["base_url"] == base_url and p["username"].lower() == username.lower():
            profile_id = pid
            break
    else:
        profile_id = uuid.uuid4().hex
    profile = {
        "id": profile_id,
        "base_url": base_url,
        "auth_type": auth_type,
        "username": username,
        "secret": secret,
        "display_name": display_name,
        "account_email": account_email,
        "api_base": api_base or base_url,
    }
    data["profiles"][profile_id] = profile
    data["last_profile"] = profile_id
    _save(data)
    return profile


def set_last(profile_id: str | None) -> None:
    data = _load()
    data["last_profile"] = profile_id
    _save(data)


def delete_profile(profile_id: str) -> None:
    data = _load()
    data["profiles"].pop(profile_id, None)
    if data.get("last_profile") == profile_id:
        data["last_profile"] = next(iter(data["profiles"]), None)
    _save(data)
