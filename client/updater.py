import os
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

from pathlib import Path


# ============================================================
# KONFIGURATION
# ============================================================

ALLOWED_FILES = {
    "main.py",
    "start_core_store.bat",
    "requirements.txt"
}


# ============================================================
# SICHERE PFADE
# ============================================================

def safe_path(root, relative):
    relative = str(relative).replace("\\", "/")

    if (
        not relative
        or relative.startswith("/")
        or ":" in relative
        or any(part in ("", ".", "..") for part in relative.split("/"))
    ):
        raise ValueError("Ungültiger Update-Pfad.")

    root = Path(root).resolve()

    target = (
        root / Path(*relative.split("/"))
    ).resolve()

    try:
        target.relative_to(root)
    except ValueError:
        raise ValueError("Update-Pfad liegt außerhalb des Zielordners.")

    return target


# ============================================================
# AUF HAUPTPROGRAMM WARTEN
# ============================================================

def wait_for_process(pid):
    if os.name != "nt":
        raise RuntimeError("Dieser Updater ist für Windows vorgesehen.")

    import ctypes

    kernel32 = ctypes.windll.kernel32

    handle = kernel32.OpenProcess(
        0x00100000,
        False,
        int(pid)
    )

    if not handle:
        raise RuntimeError(
            "Core Store konnte nicht gefunden werden."
        )

    try:
        result = kernel32.WaitForSingleObject(
            handle,
            120000
        )

        if result != 0:
            raise RuntimeError(
                "Core Store wurde nicht rechtzeitig geschlossen."
            )

    finally:
        kernel32.CloseHandle(handle)


# ============================================================
# UPDATE ENTPACKEN
# ============================================================

def extract_update(archive_path, destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(archive_path, "r") as archive:
        for item in archive.infolist():
            if item.is_dir():
                continue

            relative = item.filename.replace("\\", "/")

            target = safe_path(destination, relative)

            target.parent.mkdir(
                parents=True,
                exist_ok=True
            )

            mode = (item.external_attr >> 16) & 0xFFFF

            if mode and (mode & 0o170000) == 0o120000:
                raise ValueError(
                    "Symbolischer Link im Update-Archiv."
                )

            with archive.open(item, "r") as source:
                with open(target, "wb") as output:
                    shutil.copyfileobj(source, output)


# ============================================================
# UPDATE VALIDIEREN
# ============================================================

def validate_update(extracted):
    files = [
        path for path in extracted.rglob("*")
        if path.is_file()
    ]

    if not files:
        raise RuntimeError("Das Update enthält keine Dateien.")

    for file in files:
        relative = file.relative_to(extracted).as_posix()

        if relative not in ALLOWED_FILES:
            raise RuntimeError(
                "Nicht erlaubte Update-Datei: " + relative
            )

    if not (extracted / "main.py").is_file():
        raise RuntimeError(
            "Das Update enthält keine main.py."
        )

    return files


# ============================================================
# DATEIEN SICHERN
# ============================================================

def backup_file(source, backup):
    if not source.exists():
        return False

    backup.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    shutil.copy2(source, backup)
    return True


# ============================================================
# UPDATE ANWENDEN
# ============================================================

def apply_update(files, extracted, target, backup):
    changed = []

    try:
        for source in files:
            relative = source.relative_to(extracted).as_posix()

            destination = safe_path(target, relative)
            backup_file(
                destination,
                safe_path(backup, relative)
            )

            destination.parent.mkdir(
                parents=True,
                exist_ok=True
            )

            shutil.copy2(source, destination)

            changed.append(relative)

    except Exception:
        rollback(changed, target, backup)
        raise


# ============================================================
# ROLLBACK
# ============================================================

def rollback(changed, target, backup):
    for relative in reversed(changed):
        destination = safe_path(target, relative)
        old_file = safe_path(backup, relative)

        if old_file.exists():
            destination.parent.mkdir(
                parents=True,
                exist_ok=True
            )

            shutil.copy2(old_file, destination)

        elif destination.exists():
            destination.unlink()


# ============================================================
# STORE STARTEN
# ============================================================

def start_store(target):
    start_file = target / "start_core_store.bat"

    if start_file.is_file():
        os.startfile(str(start_file))
    else:
        main_file = target / "main.py"

        if not main_file.is_file():
            raise FileNotFoundError(
                "Core Store main.py fehlt."
            )

        subprocess.Popen([
            sys.executable,
            str(main_file)
        ], cwd=str(target))


# ============================================================
# HAUPTFUNKTION
# ============================================================

def main():
    if len(sys.argv) != 4:
        raise RuntimeError(
            "Aufruf: updater.py ZIP ZIELORDNER PID"
        )

    archive_path = Path(sys.argv[1]).resolve()
    target = Path(sys.argv[2]).resolve()
    pid = int(sys.argv[3])

    if not archive_path.is_file():
        raise FileNotFoundError("Update-Archiv fehlt.")

    if not target.is_dir():
        raise FileNotFoundError("Store-Ordner fehlt.")

    wait_for_process(pid)

    temporary = Path(
        tempfile.mkdtemp(
            prefix="core-store-update-"
        )
    )

    extracted = temporary / "extracted"
    backup = temporary / "backup"

    extracted.mkdir()
    backup.mkdir()

    try:
        extract_update(
            archive_path,
            extracted
        )

        files = validate_update(extracted)

        apply_update(
            files,
            extracted,
            target,
            backup
        )

        start_store(target)

    except Exception:
        raise

    finally:
        time.sleep(2)
        shutil.rmtree(temporary, ignore_errors=True)

        try:
            archive_path.unlink()
        except Exception:
            pass


# ============================================================
# START
# ============================================================

if __name__ == "__main__":
    try:
        main()

    except Exception as exc:
        print("CORE STORE UPDATE FEHLGESCHLAGEN")
        print()
        print(exc)
        input("\nEnter zum Beenden...")
        sys.exit(1)
