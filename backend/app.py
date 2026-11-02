import base64
import io
import json
import os
import re
import zipfile

import requests
from flask import Flask, jsonify, send_file

app = Flask(__name__)

GITHUB_API = "https://api.github.com"

TOKEN = os.environ.get("GITHUB_TOKEN", "").strip()
CODE_REPO = os.environ.get("CODE_REPO", "").strip()
FILES_REPO = os.environ.get("FILES_REPO", "").strip()
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main").strip() or "main"
CONFIG_PATH = os.environ.get(
    "CONFIG_PATH",
    "config/programs.json"
).strip()

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

    for name, value in [
        ("GITHUB_TOKEN", TOKEN),
        ("CODE_REPO", CODE_REPO),
        ("FILES_REPO", FILES_REPO)
    ]:
        if not value:
            missing.append(name)

    if missing:
        raise StoreError(
            "Render-Variablen fehlen: " + ", ".join(missing)
        )


def repo_url(repo, suffix=""):
    return f"{GITHUB_API}/repos/{repo}/{suffix}".rstrip("/")


def github_get(url, params=None):
    response = SESSION.get(
        url,
        params=params,
        timeout=45
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
            f"GitHub-Fehler {response.status_code}: {detail}"
        )

    return response


def safe_segment(value, label):
    if not isinstance(value, str):
        raise StoreError(f"Ungültiger Wert: {label}")

    if not value or value in (".", ".."):
        raise StoreError(f"Ungültiger Wert: {label}")

    if "/" in value or "\\" in value or "\x00" in value:
        raise StoreError(f"Ungültiger Wert: {label}")

    if not re.fullmatch(r"[A-Za-z0-9._ -]{1,80}", value):
        raise StoreError(f"Ungültiger Wert: {label}")

    return value


def safe_relative_path(value, label):
    if not isinstance(value, str) or not value.strip():
        raise StoreError(f"{label} fehlt.")

    value = value.replace("\\", "/")

    if value.startswith("/"):
        raise StoreError(f"Ungültiger Pfad: {label}")

    if re.match(r"^[A-Za-z]:", value):
        raise StoreError(f"Ungültiger Pfad: {label}")

    parts = value.split("/")

    if any(part in ("", ".", "..") for part in parts):
        raise StoreError(f"Ungültiger Pfad: {label}")

    return "/".join(parts)


def get_manifest():
    check_settings()

    url = repo_url(
        CODE_REPO,
        f"contents/{CONFIG_PATH}"
    )

    response = github_get(
        url,
        {"ref": GITHUB_BRANCH}
    )

    payload = response.json()

    if payload.get("type") != "file":
        raise StoreError(
            "Die programs.json wurde nicht gefunden."
        )

    raw = base64.b64decode(payload["content"])

    data = json.loads(
        raw.decode("utf-8-sig")
    )

    if not isinstance(data, dict):
        raise StoreError("Ungültige programs.json.")

    if not isinstance(data.get("programs"), list):
        raise StoreError(
            "Die programs.json benötigt eine programs-Liste."
        )

    result = []
    seen = set()

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

        start_file = item.get("start_file")
        post_install_file = item.get("post_install_file")
        icon = item.get("icon")

        if start_file is not None:
            start_file = safe_relative_path(
                start_file,
                "start_file"
            )

        if post_install_file is not None:
            post_install_file = safe_relative_path(
                post_install_file,
                "post_install_file"
            )

        if icon is not None:
            icon = safe_relative_path(
                icon,
                "icon"
            )

        preserve = item.get("update_preserve", [])

        if not isinstance(preserve, list):
            raise StoreError(
                f"update_preserve muss eine Liste sein: {pid}"
            )

        clean_preserve = []

        for entry in preserve:
            clean_preserve.append(
                safe_relative_path(
                    entry,
                    "update_preserve"
                )
            )

        result.append({
            "id": pid,
            "name": str(item.get("name", pid))[:100],
            "short_description": str(
                item.get("short_description", "")
            )[:240],
            "description": str(
                item.get("description", "")
            )[:5000],
            "version": str(
                item.get("version", "1.0.0")
            )[:40],
            "category": str(
                item.get("category", "Sonstiges")
            )[:60],
            "folder": folder,
            "start_file": start_file,
            "post_install_file": post_install_file,
            "icon": icon,
            "update_preserve": clean_preserve
        })

    return result


def get_program(program_id):
    for program in get_manifest():
        if program["id"] == program_id:
            return program

    raise StoreError("Programm nicht gefunden.")


def get_repo_tree():
    check_settings()

    branch = github_get(
        repo_url(
            FILES_REPO,
            f"branches/{GITHUB_BRANCH}"
        )
    ).json()

    tree_sha = branch["commit"]["commit"]["tree"]["sha"]

    response = github_get(
        repo_url(
            FILES_REPO,
            f"git/trees/{tree_sha}"
        ),
        {"recursive": "1"}
    )

    data = response.json()

    if data.get("truncated"):
        raise StoreError(
            "Das Dateien-Repository ist zu groß."
        )

    return data.get("tree", [])


def build_program_zip(program):
    folder = program["folder"]
    prefix = f"programs/{folder}/"

    tree = get_repo_tree()

    matching = [
        node for node in tree
        if node.get("type") == "blob"
        and node.get("path", "").startswith(prefix)
    ]

    if not matching:
        raise StoreError(
            f"Programmordner nicht gefunden: {prefix}"
        )

    output = io.BytesIO()
    total_bytes = 0

    max_total = 150 * 1024 * 1024
    max_file = 25 * 1024 * 1024

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
                "Programmdatei"
            )

            size = node.get("size", 0)

            if size > max_file:
                raise StoreError(
                    f"Datei zu groß: {relative}"
                )

            total_bytes += size

            if total_bytes > max_total:
                raise StoreError(
                    "Programm überschreitet 150 MB."
                )

            blob = github_get(
                repo_url(
                    FILES_REPO,
                    f"git/blobs/{node['sha']}"
                )
            ).json()

            if blob.get("encoding") != "base64":
                raise StoreError(
                    f"Datei nicht lesbar: {relative}"
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
        "name": "Core Network Store",
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
