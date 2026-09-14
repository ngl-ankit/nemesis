"""Authentication for Nemesis — accounts live in the database, sessions are
signed HttpOnly cookies carrying only the user id.

* Passwords hashed with Werkzeug scrypt (PBKDF2-SHA256 fallback); constant-time verify.
* Every ``/api/*`` route except auth/config/topics/admin requires a valid session;
  ``g.user`` holds the account and ``g.uid`` the string id every DB row is scoped by.
"""

from __future__ import annotations

import re
from functools import wraps

from flask import Blueprint, g, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

import config
import database

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD = 8
PUBLIC_API_PREFIXES = ("/api/auth/", "/api/config", "/api/topics", "/api/admin/")


def _json():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _err(code: str, message: str, status: int = 400):
    return jsonify({"error": code, "message": message}), status


def public_user(user: dict) -> dict:
    return {k: user.get(k) for k in ("id", "email", "display_name", "created_at", "last_login_at")}


def _hash(password: str) -> str:
    try:
        return generate_password_hash(password, method="scrypt")
    except (ValueError, AttributeError):
        return generate_password_hash(password, method="pbkdf2:sha256:600000")


def _validate_password(password: str):
    if len(password) < MIN_PASSWORD:
        return f"Password must be at least {MIN_PASSWORD} characters."
    if len(password) > 256:
        return "Password is too long."
    return None


def _login(user: dict) -> None:
    session.clear()
    session["user_id"] = user["id"]
    session.permanent = True


def current_user() -> dict | None:
    if "user" in g:
        return g.user
    user = None
    uid = session.get("user_id")
    if uid is not None:
        try:
            user = database.get_user_by_id(int(uid))
        except (TypeError, ValueError):
            user = None
        if user is None:
            session.clear()
    g.user = user
    g.uid = str(user["id"]) if user else None
    return user


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if current_user() is None:
            return _err("unauthorized", "Sign in to continue.", 401)
        return fn(*args, **kwargs)
    return wrapper


def is_public_path(path: str) -> bool:
    return path.startswith(PUBLIC_API_PREFIXES)


@bp.route("/register", methods=["POST"])
def register():
    if not config.ALLOW_REGISTRATION:
        return _err("registration_disabled", "Registration is disabled on this instance.", 403)
    body = _json()
    email = str(body.get("email") or "").strip().lower()
    name = str(body.get("display_name") or body.get("name") or "").strip()[:40]
    password = str(body.get("password") or "")
    if not EMAIL_RE.match(email) or len(email) > 254:
        return _err("invalid_email", "Enter a valid email address.")
    if not name:
        name = email.split("@", 1)[0][:40]
    pw_error = _validate_password(password)
    if pw_error:
        return _err("weak_password", pw_error)
    if database.get_user_by_email(email):
        return _err("email_taken", "An account with that email already exists.", 409)
    try:
        user_id = database.create_user(email, name, _hash(password))
    except Exception as exc:
        if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
            return _err("email_taken", "An account with that email already exists.", 409)
        raise
    database.touch_login(user_id)
    user = database.get_user_by_id(user_id)
    _login(user)
    return jsonify({"ok": True, "user": public_user(user)}), 201


@bp.route("/login", methods=["POST"])
def login():
    body = _json()
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    user = database.get_user_by_email(email) if email else None
    if not user or not password or not check_password_hash(user["password_hash"], password):
        return _err("invalid_credentials", "Incorrect email or password.", 401)
    database.touch_login(user["id"])
    _login(user)
    return jsonify({"ok": True, "user": public_user(database.get_user_by_id(user["id"]))})


@bp.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@bp.route("/me", methods=["GET"])
def me():
    user = current_user()
    return jsonify({
        "authenticated": bool(user),
        "user": public_user(user) if user else None,
        "registration_open": config.ALLOW_REGISTRATION,
    })


@bp.route("/profile", methods=["POST"])
@login_required
def update_profile():
    body = _json()
    user = g.user
    name = str(body.get("display_name") or "").strip()[:40]
    if name and name != user["display_name"]:
        database.update_user_name(user["id"], name)
    if body.get("new_password"):
        if not check_password_hash(user["password_hash"], str(body.get("current_password") or "")):
            return _err("invalid_credentials", "Current password is incorrect.", 401)
        pw_error = _validate_password(str(body["new_password"]))
        if pw_error:
            return _err("weak_password", pw_error)
        database.update_user_password(user["id"], _hash(str(body["new_password"])))
    return jsonify({"ok": True, "user": public_user(database.get_user_by_id(user["id"]))})
