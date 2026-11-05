import os
import re
import io
import json
import base64
import zipfile

import requests

from flask import Flask, jsonify, send_file


app = Flask(__name__)

# ============================================================
# KONFIGURATION
# ============================================================

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
FILES_REPO = os.getenv("FILES_REPO", "")
GITHUB_BRANCH = os.getenv("GITHUB_BRANCH", "main")
CONFIG_PATH = os.getenv("CONFIG_PATH", "config/programs.json")
STORE_CONFIG_PATH = "config/store.json"
SUPPORT_URL = os.getenv("SUPPORT_URL", "").strip()

GITHUB_API = "https://api.github.com"

MAX_FILE_SIZE = 25 * 1024 * 1024
MAX_ARCHIVE_SIZE = 150 * 1024 * 1024

session = requests.Session()
session.headers.update({
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
})


# ============================================================
# GITHUB
# ============================================================

def check_environment():
    if not GITHUB_TOKEN:
        raise RuntimeError("GITHUB_TOKEN fehlt.")

    if not FILES_REPO or "/" not in FILES_REPO:
        raise RuntimeError(
            "FILES_REPO muss OWNER/REPOSITORY sein."
        )


def repo_url(path=""):
    check_environment()

    owner, repository = FILES_REPO.split("/", 1)

    if path:
        return (
            f"{GITHUB_API}/repos/{owner}/{repository}/{path}"
        )

    return f"{GITHUB_API}/repos/{owner}/{repository}"


def github_get(url, params=None):
    response = session.get(
        url,
        params=params,
        timeout=60
    )

    if response.status_code == 404:
        raise FileNotFoundError(
            "Datei oder Repository auf GitHub nicht gefunden."
        )

    if response.status_code == 403:
        raise PermissionError(
            "GitHub-Zugriff verweigert. Token-Berechtigungen prüfen."
        )

    response.raise_for_status()
    return response


def safe_repo_path(path):
    if not isinstance(path, str) or not path:
        raise ValueError("Ungültiger Repository-Pfad.")

    path = path.replace("\\", "/")

    if path.startswith("/") or ":" in path:
        raise ValueError("Ungültiger Repository-Pfad.")

    parts = path.split("/")

    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Ungültiger Repository-Pfad.")

    return "/".join(parts)


def get_file(path):
    path = safe_repo_path(path)

    response = github_get(
        repo_url("contents/" + path),
        params={"ref": GITHUB_BRANCH}
    )

    data = response.json()

    if data.get("type") != "file":
        raise ValueError("GitHub-Pfad ist keine Datei.")

    if data.get("encoding") != "base64":
        raise ValueError("Unbekanntes GitHub-Dateiformat.")

    return base64.b64decode(data["content"])


def get_json(path):
    content = get_file(path)

    try:
        return json.loads(content.decode("utf-8"))
    except Exception as exc:
        raise ValueError(
            f"JSON-Datei {path} ist ungültig: {exc}"
        )


# ============================================================
# PROGRAMMKONFIGURATION
# ============================================================

def validate_program(program):
    if not isinstance(program, dict):
        raise ValueError("Ungültiger Programmeintrag.")

    program_id = program.get("id")

    if not isinstance(program_id, str):
        raise ValueError("Programm-ID fehlt.")

    if not re.fullmatch(r"[a-zA-Z0-9_-]+", program_id):
        raise ValueError("Ungültige Programm-ID.")

    folder = safe_repo_path(program.get("folder", ""))

    if "/" in folder:
        raise ValueError(
            "Programmordner muss direkt unter programs/ liegen."
        )

    program["folder"] = folder

    files = program.get("files", {})

    if not isinstance(files, dict):
        raise ValueError("Ungültige files-Konfiguration.")

    for key in (
        "installation",
        "start",
        "uninstallation",
        "update"
    ):
        value = files.get(key)

        if value:
            files[key] = safe_repo_path(value)

    program["files"] = files

    execution = program.get("execution", {})

    if not isinstance(execution, dict):
        raise ValueError("Ungültige execution-Konfiguration.")

    program["execution"] = execution

    preserve = program.get("update_preserve", [])

    if not isinstance(preserve, list):
        raise ValueError("update_preserve muss eine Liste sein.")

    program["update_preserve"] = [
        safe_repo_path(item) for item in preserve
    ]

    return program


def get_programs_config():
    config = get_json(CONFIG_PATH)

    if not isinstance(config, dict):
        raise ValueError("Ungültige programs.json.")

    if not isinstance(config.get("programs"), list):
        raise ValueError("Die Programmliste fehlt.")

    return config


def get_program(program_id):
    config = get_programs_config()

    for original in config["programs"]:
        if original.get("id") == program_id:
            program = validate_program(dict(original))

            if not program.get("enabled", True):
                raise PermissionError("Programm ist deaktiviert.")

            return program

    raise FileNotFoundError("Programm nicht gefunden.")


# ============================================================
# GITHUB TREE
# ============================================================

def get_repository_tree():
    branch = github_get(
        repo_url("branches/" + GITHUB_BRANCH)
    ).json()

    commit_sha = branch["commit"]["sha"]

    commit = github_get(
        repo_url("git/commits/" + commit_sha)
    ).json()

    tree_sha = commit["tree"]["sha"]

    tree = github_get(
        repo_url("git/trees/" + tree_sha),
        params={"recursive": "1"}
    ).json()

    if tree.get("truncated"):
        raise RuntimeError(
            "GitHub-Dateiliste ist zu groß."
        )

    return tree.get("tree", [])


# ============================================================
# ZIP AUS REPOSITORY-ORDNER ERSTELLEN
# ============================================================

def create_folder_zip(folder):
    folder = safe_repo_path(folder)
    prefix = folder.rstrip("/") + "/"

    tree = get_repository_tree()

    selected = []

    for item in tree:
        path = item.get("path", "")

        if not path.startswith(prefix):
            continue

        if item.get("type") != "blob":
            continue

        if item.get("mode") == "120000":
            continue

        relative = path[len(prefix):]

        try:
            relative = safe_repo_path(relative)
        except ValueError:
            continue

        size = int(item.get("size", 0))

        if size > MAX_FILE_SIZE:
            raise ValueError(
                f"Datei zu groß: {relative}"
            )

        selected.append({
            "relative": relative,
            "sha": item["sha"],
            "size": size
        })

    if not selected:
        raise FileNotFoundError(
            f"Keine Dateien in {folder} gefunden."
        )

    total = sum(item["size"] for item in selected)

    if total > MAX_ARCHIVE_SIZE:
        raise ValueError("ZIP-Archiv überschreitet 150 MB.")

    output = io.BytesIO()

    with zipfile.ZipFile(
        output,
        "w",
        compression=zipfile.ZIP_DEFLATED
    ) as archive:

        for item in selected:
            blob = github_get(
                repo_url("git/blobs/" + item["sha"])
            ).json()

            if blob.get("encoding") != "base64":
                raise ValueError(
                    "Ungültiges GitHub-Dateiformat."
                )

            content = base64.b64decode(blob["content"])

            if len(content) != item["size"]:
                raise ValueError(
                    "Dateigröße stimmt nicht überein."
                )

            archive.writestr(
                item["relative"],
                content
            )

    output.seek(0)
    return output


# ============================================================
# STORE-KONFIGURATION
# ============================================================

def get_store_config():
    config = get_json(STORE_CONFIG_PATH)

    if not isinstance(config, dict):
        raise ValueError("Ungültige store.json.")

    version = config.get("version")

    if not isinstance(version, str):
        raise ValueError("Store-Version fehlt.")

    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Ungültiges Store-Versionsformat.")

    if config.get("folder") != "core-store":
        raise ValueError("Ungültiger Store-Ordner.")

    return config


# ============================================================
# API
# ============================================================

@app.route("/", methods=["GET"])
def index():
    return jsonify({
        "name": "Core Store API",
        "status": "online"
    })


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok"
    })


# ------------------------------------------------------------
# PROGRAMME
# ------------------------------------------------------------

@app.route("/api/programs", methods=["GET"])
def programs():
    try:
        config = get_programs_config()
        result = []

        for original in config["programs"]:
            try:
                program = validate_program(dict(original))

                if program.get("enabled", True):
                    result.append(program)

            except Exception:
                continue

        return jsonify({
            "programs": result
        })

    except Exception as exc:
        return jsonify({
            "error": str(exc)
        }), 500


@app.route(
    "/api/programs/<program_id>/download",
    methods=["GET"]
)
def download_program(program_id):
    try:
        program = get_program(program_id)

        archive = create_folder_zip(
            "programs/" + program["folder"]
        )

        return send_file(
            archive,
            mimetype="application/zip",
            as_attachment=True,
            download_name=program_id + ".zip"
        )

    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404

    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 403

    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ------------------------------------------------------------
# CORE STORE VERSION
# ------------------------------------------------------------

@app.route("/api/store/version", methods=["GET"])
def store_version():
    try:
        config = get_store_config()

        support_url = SUPPORT_URL or str(config.get("support_url", "")).strip()
        if support_url and not re.match(r"^https?://", support_url, re.IGNORECASE):
            support_url = ""

        return jsonify({
            "enabled": bool(config.get("enabled", True)),
            "version": config["version"],
            "release_notes": config.get("release_notes", []),
            "support_url": support_url
        })

    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ------------------------------------------------------------
# CORE STORE DOWNLOAD
# ------------------------------------------------------------

@app.route("/api/store/download", methods=["GET"])
def store_download():
    try:
        config = get_store_config()

        if not config.get("enabled", True):
            return jsonify({
                "error": "Store-Updates sind deaktiviert."
            }), 403

        archive = create_folder_zip("core-store")

        return send_file(
            archive,
            mimetype="application/zip",
            as_attachment=True,
            download_name="core-store-update.zip"
        )

    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ============================================================
# FEHLER
# ============================================================

@app.errorhandler(404)
def not_found(_error):
    return jsonify({
        "error": "API-Endpunkt nicht gefunden."
    }), 404


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000"))
    )
