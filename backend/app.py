import os
import re
import json
import base64
import zipfile
import io

import requests

from flask import Flask, jsonify, send_file


app = Flask(__name__)

# ============================================================
# EINSTELLUNGEN
# ============================================================

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
FILES_REPO = os.getenv("FILES_REPO", "")
GITHUB_BRANCH = os.getenv("GITHUB_BRANCH", "main")
CONFIG_PATH = os.getenv("CONFIG_PATH", "config/programs.json")

GITHUB_API = "https://api.github.com"

MAX_FILE_SIZE = 25 * 1024 * 1024
MAX_PROGRAM_SIZE = 150 * 1024 * 1024

session = requests.Session()
session.headers.update({
    "Authorization": f"Bearer {GITHUB_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
})


# ============================================================
# HILFSFUNKTIONEN
# ============================================================

def validate_environment():
    if not GITHUB_TOKEN:
        raise RuntimeError("GITHUB_TOKEN fehlt auf Render.")

    if not FILES_REPO or "/" not in FILES_REPO:
        raise RuntimeError(
            "FILES_REPO muss im Format OWNER/REPOSITORY angegeben werden."
        )


def github_request(url, params=None):
    validate_environment()

    response = session.get(
        url,
        params=params,
        timeout=60
    )

    if response.status_code == 404:
        raise FileNotFoundError("Die angeforderte GitHub-Datei wurde nicht gefunden.")

    if response.status_code == 403:
        raise PermissionError(
            "GitHub-Zugriff verweigert. Prüfe die Token-Berechtigungen."
        )

    response.raise_for_status()
    return response


def repository_url(path=""):
    owner, repo = FILES_REPO.split("/", 1)

    if path:
        return f"{GITHUB_API}/repos/{owner}/{repo}/{path}"

    return f"{GITHUB_API}/repos/{owner}/{repo}"


def safe_repo_path(path):
    """
    Prüft einen Pfad, der innerhalb des GitHub-Repositories liegt.
    """

    if not isinstance(path, str) or not path:
        raise ValueError("Ungültiger Repository-Pfad.")

    path = path.replace("\\", "/")

    if path.startswith("/") or ":" in path:
        raise ValueError("Ungültiger Repository-Pfad.")

    parts = path.split("/")

    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Ungültiger Repository-Pfad.")

    return "/".join(parts)


def get_file_from_github(path):
    path = safe_repo_path(path)

    response = github_request(
        repository_url(f"contents/{path}"),
        params={"ref": GITHUB_BRANCH}
    )

    data = response.json()

    if data.get("type") != "file":
        raise ValueError("Der angegebene GitHub-Pfad ist keine Datei.")

    if data.get("encoding") != "base64":
        raise ValueError("Unbekanntes GitHub-Dateiformat.")

    content = base64.b64decode(data["content"])
    return content


# ============================================================
# PROGRAMMKONFIGURATION
# ============================================================

def get_program_config():
    raw = get_file_from_github(CONFIG_PATH)

    try:
        config = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError(
            f"programs.json konnte nicht gelesen werden: {exc}"
        )

    if not isinstance(config, dict):
        raise ValueError("Die Konfiguration muss ein JSON-Objekt sein.")

    programs = config.get("programs")

    if not isinstance(programs, list):
        raise ValueError("In programs.json fehlt die Liste 'programs'.")

    return config


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
            "Der Programmordner muss direkt unter programs/ liegen."
        )

    program["folder"] = folder

    files = program.get("files", {})

    if not isinstance(files, dict):
        raise ValueError(f"Ungültige Dateikonfiguration für {program_id}.")

    for key in (
        "installation",
        "start",
        "uninstallation",
        "update"
    ):
        value = files.get(key)

        if value is not None and value != "":
            files[key] = safe_repo_path(value)

    program["files"] = files

    execution = program.get("execution", {})

    if not isinstance(execution, dict):
        raise ValueError(f"Ungültige Ausführungseinstellungen für {program_id}.")

    program["execution"] = execution

    preserve = program.get("update_preserve", [])

    if not isinstance(preserve, list):
        raise ValueError("update_preserve muss eine Liste sein.")

    program["update_preserve"] = [
        safe_repo_path(item) for item in preserve
    ]

    return program


def get_program(program_id):
    config = get_program_config()

    for program in config["programs"]:
        if program.get("id") == program_id:
            program = validate_program(program)

            if not program.get("enabled", True):
                raise PermissionError("Dieses Programm ist deaktiviert.")

            return program

    raise FileNotFoundError("Programm nicht gefunden.")


# ============================================================
# GITHUB PROGRAMM-DOWNLOAD
# ============================================================

def get_branch_tree():
    branch_response = github_request(
        repository_url(f"branches/{GITHUB_BRANCH}")
    )

    branch_data = branch_response.json()
    commit_sha = branch_data["commit"]["sha"]

    commit_response = github_request(
        repository_url(f"git/commits/{commit_sha}")
    )

    tree_sha = commit_response.json()["tree"]["sha"]

    tree_response = github_request(
        repository_url(f"git/trees/{tree_sha}"),
        params={"recursive": "1"}
    )

    tree_data = tree_response.json()

    if tree_data.get("truncated"):
        raise RuntimeError(
            "Das GitHub-Repository ist zu groß für eine vollständige Dateiliste."
        )

    return tree_data.get("tree", [])


def create_program_zip(program):
    folder = program["folder"]
    prefix = f"programs/{folder}/"

    tree = get_branch_tree()

    selected_files = []

    for item in tree:
        path = item.get("path", "")

        if not path.startswith(prefix):
            continue

        if item.get("type") != "blob":
            continue

        # Symlinks nicht übernehmen.
        if item.get("mode") == "120000":
            continue

        relative_path = path[len(prefix):]

        try:
            relative_path = safe_repo_path(relative_path)
        except ValueError:
            continue

        size = int(item.get("size", 0))

        if size > MAX_FILE_SIZE:
            raise ValueError(
                f"Datei überschreitet das Limit von 25 MB: {relative_path}"
            )

        selected_files.append((relative_path, item["sha"], size))

    if not selected_files:
        raise FileNotFoundError(
            f"Keine Dateien im Ordner programs/{folder} gefunden."
        )

    total_size = sum(item[2] for item in selected_files)

    if total_size > MAX_PROGRAM_SIZE:
        raise ValueError("Das Programm überschreitet das Downloadlimit von 150 MB.")

    archive_buffer = io.BytesIO()

    with zipfile.ZipFile(
        archive_buffer,
        "w",
        compression=zipfile.ZIP_DEFLATED
    ) as archive:

        for relative_path, blob_sha, expected_size in selected_files:
            blob_response = github_request(
                repository_url(f"git/blobs/{blob_sha}")
            )

            blob = blob_response.json()

            if blob.get("encoding") != "base64":
                raise ValueError(f"Ungültiges Dateiformat: {relative_path}")

            content = base64.b64decode(blob["content"])

            if len(content) != expected_size:
                raise ValueError(f"Dateigröße stimmt nicht: {relative_path}")

            archive.writestr(relative_path, content)

    archive_buffer.seek(0)
    return archive_buffer


# ============================================================
# API ROUTES
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


@app.route("/api/programs", methods=["GET"])
def programs():
    try:
        config = get_program_config()

        result = []

        for original in config["programs"]:
            try:
                program = validate_program(dict(original))

                if program.get("enabled", True):
                    result.append(program)

            except Exception:
                # Ungültige Programme nicht an den Client ausliefern.
                continue

        return jsonify({
            "programs": result
        })

    except Exception as exc:
        return jsonify({
            "error": str(exc)
        }), 500


@app.route("/api/programs/<program_id>/download", methods=["GET"])
def download_program(program_id):
    try:
        program = get_program(program_id)
        archive = create_program_zip(program)

        return send_file(
            archive,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{program_id}.zip"
        )

    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404

    except PermissionError as exc:
        return jsonify({"error": str(exc)}), 403

    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ============================================================
# FEHLERBEHANDLUNG
# ============================================================

@app.errorhandler(404)
def not_found(_error):
    return jsonify({
        "error": "API-Endpunkt nicht gefunden."
    }), 404


@app.errorhandler(500)
def server_error(_error):
    return jsonify({
        "error": "Interner Serverfehler."
    }), 500


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.getenv("PORT", "5000"))
    )
