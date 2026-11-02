import base64
import io
import json
import os
import re
import zipfile
from functools import lru_cache

import requests
from flask import Flask, jsonify, send_file, Response

app = Flask(__name__)

GITHUB_API = "https://api.github.com"

TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
FILES_REPO = os.environ.get("FILES_REPO", "").strip()
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main").strip() or "main"
CONFIG_PATH = os.environ.get(
    "CONFIG_PATH",
    "config/programs.json"
).strip()

MAX_FILE_SIZE = 25 * 1024 * 1024
MAX_PROGRAM_SIZE = 150 * 1024 * 1024

SESSION = requests.Session()

SESSION.headers.update({
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
})

if TOKEN:
    SESSION.headers["Authorization"] = f"Bearer {TOKEN}"


class StoreError(Exception):
    pass


def check_settings():
    missing = []

    if not TOKEN:
        missing.append("GITHUB_TOKEN")

    if not FILES_REPO:
        missing.append("FILES_REPO")

    if missing:
        raise StoreError(
            "Render-Umgebungsvariablen fehlen: "
            + ", ".join(missing)
        )


def repo_url(suffix=""):
    return (
        f"{GITHUB_API}/repos/"
        f"{FILES_REPO}/{suffix}"
    ).rstrip("/")


def github_get(url, params=None):
    response = SESSION.get(
        url,
        params=params,
        timeout=40
    )

    if response.status_code >= 400:
        try:
            detail = response.json().get(
                "message",
                response.text
            )
        except Exception:
            detail = response.text

        raise StoreError(
            f"GitHub-Fehler ({response.status_code}): {detail}"
        )

    return response


def safe_segment(value, label):
    if not isinstance(value, str):
        raise StoreError(f"Ungültiger {label}.")

    if not value or value in (".", ".."):
        raise StoreError(f"Ungültiger {label}.")

    if "/" in value or "\\" in value or "\x00" in value:
        raise StoreError(f"Ungültiger {label}.")

    if not re.fullmatch(r"[A-Za-z0-9._ -]{1,80}", value):
        raise StoreError(f"Ungültiger {label}.")

    return value


def safe_relative_path(value, label):
    if not isinstance(value, str) or not value.strip():
        raise StoreError(f"{label} fehlt.")

    value = value.replace("\\", "/")

    parts = value.split("/")

    if any(part in ("", ".", "..") for part in parts):
        raise StoreError(f"Ungültiger Pfad für {label}.")

    if value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise StoreError(f"Ungültiger Pfad für {label}.")

    return "/".join(parts)


def github_read_file(path):
    path = safe_relative_path(path, "GitHub-Dateipfad")

    response = github_get(
        repo_url(f"contents/{path}"),
        {"ref": GITHUB_BRANCH}
    )

    payload = response.json()

    if payload.get("type") != "file":
        raise StoreError(
            f"GitHub-Pfad ist keine Datei: {path}"
        )

    if payload.get("encoding") != "base64":
        raise StoreError(
            f"Datei konnte nicht gelesen werden: {path}"
        )

    return base64.b64decode(payload["content"])


def validate_manifest(data):
    if not isinstance(data, dict):
        raise StoreError("Ungültige programs.json.")

    if not isinstance(data.get("programs"), list):
        raise StoreError(
            "programs.json muss eine programs-Liste enthalten."
        )

    seen = set()
    cleaned = []

    for item in data["programs"]:
        if not isinstance(item, dict):
            continue

        pid = safe_segment(
            item.get("id"),
            "Programm-ID"
        )

        folder = safe_segment(
            item.get("folder"),
            "Programmordner"
        )

        if pid in seen:
            raise StoreError(
                f"Doppelte Programm-ID: {pid}"
            )

        seen.add(pid)

        name = str(item.get("name", pid))[:100]
        short_desc = str(
            item.get("short_description", "")
        )[:240]

        description = str(
            item.get("description", "")
        )[:5000]

        version = str(
            item.get("version", "1.0.0")
        )[:40]

        category = str(
            item.get("category", "Sonstiges")
        )[:60]

        start_file = item.get("start_file")

        if start_file is not None:
            start_file = safe_relative_path(
                start_file,
                "start_file"
            )

        post_install_file = item.get(
            "post_install_file"
        )

        if post_install_file is not None:
            post_install_file = safe_relative_path(
                post_install_file,
                "post_install_file"
            )

        icon = item.get("icon")

        if icon is not None:
            icon = safe_relative_path(
                icon,
                "icon"
            )

        preserve = item.get(
            "update_preserve",
            []
        )

        if not isinstance(preserve, list):
            raise StoreError(
                f"update_preserve muss eine Liste sein: {pid}"
            )

        clean_preserve = []

        for path in preserve:
            clean_preserve.append(
                safe_relative_path(
                    path,
                    "update_preserve"
                )
            )

        cleaned.append({
            "id": pid,
            "name": name,
            "short_description": short_desc,
            "description": description,
            "version": version,
            "category": category,
            "folder": folder,
            "start_file": start_file,
            "post_install_file": post_install_file,
            "icon": icon,
            "update_preserve": clean_preserve
        })

    return cleaned


@lru_cache(maxsize=1)
def get_manifest_cached():
    check_settings()

    raw = github_read_file(CONFIG_PATH)

    try:
        data = json.loads(
            raw.decode("utf-8-sig")
        )
    except Exception as exc:
        raise StoreError(
            f"programs.json ist ungültig: {exc}"
        )

    return validate_manifest(data)


def get_manifest():
    get_manifest_cached.cache_clear()
    return get_manifest_cached()


def get_program(program_id):
    for program in get_manifest():
        if program["id"] == program_id:
            return program

    raise StoreError("Programm nicht gefunden.")


def get_repo_tree():
    check_settings()

    branch_data = github_get(
        repo_url(f"branches/{GITHUB_BRANCH}")
    ).json()

    tree_sha = (
        branch_data["commit"]["commit"]["tree"]["sha"]
    )

    response = github_get(
        repo_url(f"git/trees/{tree_sha}"),
        {"recursive": "1"}
    )

    data = response.json()

    if data.get("truncated"):
        raise StoreError(
            "Das Dateien-Repository ist zu groß "
            "für eine vollständige Git-Tree-Abfrage."
        )

    return data.get("tree", [])


def build_program_zip(program):
    folder = program["folder"]
    prefix = f"programs/{folder}/"

    tree = get_repo_tree()

    matching = [
        node
        for node in tree
        if (
            node.get("type") == "blob"
            and node.get("path", "").startswith(prefix)
        )
    ]

    if not matching:
        raise StoreError(
            f"Programmordner nicht gefunden: {prefix}"
        )

    output = io.BytesIO()
    total_bytes = 0

    with zipfile.ZipFile(
        output,
        "w",
        compression=zipfile.ZIP_DEFLATED
    ) as archive:

        for node in matching:
            path = node["path"]
            relative = path[len(prefix):]

            safe_relative_path(
                relative,
                "Dateipfad im Programmordner"
            )

            size = node.get("size", 0)

            if size > MAX_FILE_SIZE:
                raise StoreError(
                    f"Einzeldatei ist größer als 25 MB: {relative}"
                )

            total_bytes += size

            if total_bytes > MAX_PROGRAM_SIZE:
                raise StoreError(
                    "Programm überschreitet das Downloadlimit "
                    "von 150 MB."
                )

            blob = github_get(
                repo_url(f"git/blobs/{node['sha']}")
            ).json()

            if blob.get("encoding") != "base64":
                raise StoreError(
                    f"Datei konnte nicht gelesen werden: {relative}"
                )

            content = base64.b64decode(
                blob["content"]
            )

            archive.writestr(
                relative,
                content
            )

    output.seek(0)

    return output


@app.get("/")
def index():
    return jsonify({
        "name": "Core Store API",
        "status": "online",
        "api": "/api/programs"
    })


@app.get("/health")
def health():
    return jsonify({
        "status": "ok"
    })


@app.get("/api/programs")
def programs():
    try:
        return jsonify({
            "programs": get_manifest()
        })

    except Exception as exc:
        return jsonify({
            "error": str(exc)
        }), 500


@app.get("/api/programs/<program_id>/download")
def download_program(program_id):
    try:
        program = get_program(program_id)

        archive = build_program_zip(program)

        return send_file(
            archive,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{program['id']}.zip"
        )

    except Exception as exc:
        return jsonify({
            "error": str(exc)
        }), 400


@app.get("/api/programs/<program_id>/icon")
def program_icon(program_id):
    try:
        program = get_program(program_id)

        icon = program.get("icon")

        if not icon:
            return jsonify({
                "error": "Kein Icon konfiguriert."
            }), 404

        path = safe_relative_path(
            icon,
            "icon"
        )

        full_path = (
            f"programs/{program['folder']}/{path}"
        )

        response = github_get(
            repo_url(f"contents/{full_path}"),
            {"ref": GITHUB_BRANCH}
        )

        payload = response.json()

        content = base64.b64decode(
            payload["content"]
        )

        return Response(
            content,
            mimetype=payload.get(
                "content_type",
                "application/octet-stream"
            )
        )

    except Exception as exc:
        return jsonify({
            "error": str(exc)
        }), 400


@app.errorhandler(404)
def not_found(_):
    return jsonify({
        "error": "API-Endpunkt nicht gefunden."
    }), 404


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000"))
    )
