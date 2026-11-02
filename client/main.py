import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import zipfile

from pathlib import Path
import tkinter as tk
from tkinter import ttk, messagebox

import requests


# ============================================================
# GRUNDEINSTELLUNGEN
# ============================================================

APP_NAME = "Core Store"

BASE_DIR = Path(__file__).resolve().parent
SETTINGS_FILE = BASE_DIR / "settings.json"

LOCAL_APPDATA = Path(
    os.getenv("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))
)

STORE_ROOT = LOCAL_APPDATA / "Core Network"
INSTALL_ROOT = STORE_ROOT / "Programs"
STORE_DATA = STORE_ROOT / "_store"

INSTALLED_FILE = STORE_DATA / "installed.json"

REQUEST_TIMEOUT = 120

STORE_ROOT.mkdir(parents=True, exist_ok=True)
INSTALL_ROOT.mkdir(parents=True, exist_ok=True)
STORE_DATA.mkdir(parents=True, exist_ok=True)


# ============================================================
# EINSTELLUNGEN
# ============================================================

def load_settings():
    if not SETTINGS_FILE.exists():
        raise RuntimeError(
            "settings.json fehlt im client-Ordner."
        )

    with open(SETTINGS_FILE, "r", encoding="utf-8") as file:
        settings = json.load(file)

    api_url = settings.get("api_url", "").strip().rstrip("/")

    if not api_url.startswith(("https://", "http://")):
        raise RuntimeError(
            "In settings.json ist keine gültige api_url eingetragen."
        )

    return api_url


API_URL = load_settings()


# ============================================================
# INSTALLIERTE PROGRAMME
# ============================================================

def load_installed():
    if not INSTALLED_FILE.exists():
        return {}

    try:
        with open(INSTALLED_FILE, "r", encoding="utf-8") as file:
            data = json.load(file)

        return data if isinstance(data, dict) else {}

    except Exception:
        return {}


def save_installed(data):
    temporary = INSTALLED_FILE.with_suffix(".tmp")

    with open(temporary, "w", encoding="utf-8") as file:
        json.dump(data, file, indent=4, ensure_ascii=False)

    os.replace(temporary, INSTALLED_FILE)


# ============================================================
# DATEIPFAD-SICHERHEIT
# ============================================================

def validate_program_id(program_id):
    if not isinstance(program_id, str):
        raise ValueError("Ungültige Programm-ID.")

    if not re.fullmatch(r"[a-zA-Z0-9_-]+", program_id):
        raise ValueError("Ungültige Programm-ID.")

    return program_id


def safe_child(parent, relative):
    """
    Gibt nur Pfade zurück, die innerhalb von parent liegen.
    """

    parent = Path(parent).resolve()
    relative = str(relative).replace("\\", "/")

    if not relative or relative.startswith("/"):
        raise ValueError("Ungültiger Dateipfad.")

    if ":" in relative:
        raise ValueError("Ungültiger Dateipfad.")

    parts = relative.split("/")

    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Ungültiger Dateipfad.")

    result = (parent / Path(*parts)).resolve()

    try:
        result.relative_to(parent)
    except ValueError:
        raise ValueError("Dateipfad liegt außerhalb des Programmordners.")

    return result


def safe_relative_path(value):
    if not isinstance(value, str) or not value:
        raise ValueError("Leerer Dateipfad.")

    value = value.replace("\\", "/")

    if value.startswith("/") or ":" in value:
        raise ValueError("Ungültiger relativer Pfad.")

    parts = value.split("/")

    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Ungültiger relativer Pfad.")

    return "/".join(parts)


# ============================================================
# PROGRAMM-DOWNLOAD
# ============================================================

def download_program(program_id, destination):
    url = f"{API_URL}/api/programs/{program_id}/download"

    response = requests.get(
        url,
        timeout=REQUEST_TIMEOUT,
        stream=True
    )

    if response.status_code != 200:
        try:
            error = response.json().get("error", response.text)
        except Exception:
            error = response.text

        raise RuntimeError(
            f"Download fehlgeschlagen: {error}"
        )

    with open(destination, "wb") as file:
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                file.write(chunk)


# ============================================================
# ZIP-EXTRAKTION
# ============================================================

def extract_safely(zip_path, destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path, "r") as archive:
        for item in archive.infolist():

            name = item.filename.replace("\\", "/")

            if name.endswith("/"):
                continue

            relative = safe_relative_path(name)
            target = safe_child(destination, relative)

            # Symbolische Links nicht extrahieren.
            unix_mode = (item.external_attr >> 16) & 0xFFFF

            if unix_mode and (unix_mode & 0o170000) == 0o120000:
                raise ValueError(
                    f"Symbolische Links sind nicht erlaubt: {name}"
                )

            target.parent.mkdir(parents=True, exist_ok=True)

            with archive.open(item, "r") as source:
                with open(target, "wb") as output:
                    shutil.copyfileobj(source, output)


# ============================================================
# PROGRAMM-DATEIEN AUSFÜHREN
# ============================================================

def execute_file(
    program_dir,
    relative_file,
    wait=True,
    show_console=True,
    action="start"
):
    """
    Führt die in programs.json eingetragene Datei aus.

    Unterstützt:
    - .bat
    - .cmd
    - .py
    - .exe
    - .ps1
    - .html / .htm (nur Start)
    """

    if not relative_file:
        return None

    relative_file = safe_relative_path(relative_file)
    program_dir = Path(program_dir).resolve()

    file_path = safe_child(program_dir, relative_file)

    if not file_path.is_file():
        raise FileNotFoundError(
            f"Die konfigurierte Datei existiert nicht:\n{relative_file}"
        )

    extension = file_path.suffix.lower()

    if extension in (".html", ".htm"):
        if action != "start":
            raise ValueError(
                "HTML-Dateien können nur als Startdatei verwendet werden."
            )

        os.startfile(str(file_path))
        return None

    if extension == ".py":
        command = [
            sys.executable,
            str(file_path)
        ]

    elif extension in (".bat", ".cmd"):
        command = [
            os.environ.get("COMSPEC", "cmd.exe"),
            "/c",
            str(file_path)
        ]

    elif extension == ".exe":
        command = [str(file_path)]

    elif extension == ".ps1":
        command = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(file_path)
        ]

    else:
        raise ValueError(
            f"Nicht unterstützter Dateityp: {extension}"
        )

    environment = os.environ.copy()
    environment["CORE_STORE_PROGRAM_DIR"] = str(program_dir)
    environment["CORE_STORE_ACTION"] = action

    creation_flags = 0

    if os.name == "nt" and not show_console:
        creation_flags = subprocess.CREATE_NO_WINDOW

    process = subprocess.Popen(
        command,
        cwd=str(program_dir),
        env=environment,
        creationflags=creation_flags
    )

    if wait:
        return_code = process.wait()

        if return_code != 0:
            raise RuntimeError(
                f"Die Datei {relative_file} wurde mit Fehlercode "
                f"{return_code} beendet."
            )

    return process


# ============================================================
# KONFIGURATION AUSWERTEN
# ============================================================

def get_file_setting(program, action):
    files = program.get("files", {})

    if not isinstance(files, dict):
        raise ValueError("Ungültige files-Konfiguration.")

    return files.get(action)


def get_execution_setting(program, setting, default):
    execution = program.get("execution", {})

    if not isinstance(execution, dict):
        return default

    return execution.get(setting, default)


def execute_configured(program, program_dir, action):
    """
    Führt die für eine Aktion konfigurierte Datei aus.
    """

    relative_file = get_file_setting(program, action)

    if not relative_file:
        return

    enabled = get_execution_setting(
        program,
        action,
        True
    )

    if not enabled:
        return

    wait_setting = {
        "installation": "wait_for_installation",
        "uninstallation": "wait_for_uninstallation",
        "update": "wait_for_update"
    }.get(action)

    if wait_setting:
        wait = get_execution_setting(
            program,
            wait_setting,
            True
        )
    else:
        wait = False

    show_console = get_execution_setting(
        program,
        "show_console",
        True
    )

    execute_file(
        program_dir=program_dir,
        relative_file=relative_file,
        wait=wait,
        show_console=show_console,
        action=action
    )


# ============================================================
# UPDATE-DATEN ERHALTEN
# ============================================================

def preserve_user_data(program, old_directory, new_directory):
    preserve = program.get("update_preserve", [])

    if not isinstance(preserve, list):
        raise ValueError("update_preserve muss eine Liste sein.")

    for relative in preserve:
        relative = safe_relative_path(relative)

        old_path = safe_child(old_directory, relative)
        new_path = safe_child(new_directory, relative)

        if not old_path.exists():
            continue

        if new_path.exists():
            if new_path.is_dir():
                shutil.rmtree(new_path)
            else:
                new_path.unlink()

        new_path.parent.mkdir(parents=True, exist_ok=True)

        if old_path.is_dir():
            shutil.copytree(old_path, new_path)
        else:
            shutil.copy2(old_path, new_path)


# ============================================================
# INSTALLATION
# ============================================================

def install_program(program):
    program_id = validate_program_id(program["id"])
    target = INSTALL_ROOT / program_id

    if target.exists():
        raise RuntimeError(
            "Dieses Programm ist bereits installiert. "
            "Verwende stattdessen Update."
        )

    temporary_root = Path(
        tempfile.mkdtemp(prefix="core-install-", dir=STORE_ROOT)
    )

    stage = temporary_root / "program"
    archive = temporary_root / "program.zip"

    try:
        download_program(program_id, archive)
        extract_safely(archive, stage)

        # Installationsdatei wird vor dem Verschieben ausgeführt.
        # CORE_STORE_PROGRAM_DIR zeigt auf das temporäre Verzeichnis.
        execute_configured(
            program,
            stage,
            "installation"
        )

        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(stage, target)

        installed = load_installed()

        installed[program_id] = {
            "name": program.get("name", program_id),
            "version": program.get("version", "0.0.0"),
            "folder": str(target),
            "installed": True
        }

        save_installed(installed)

    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


# ============================================================
# PROGRAMM STARTEN
# ============================================================

def start_program(program):
    program_id = validate_program_id(program["id"])
    target = INSTALL_ROOT / program_id

    if not target.is_dir():
        raise FileNotFoundError("Programm ist nicht installiert.")

    execute_configured(
        program,
        target,
        "start"
    )


# ============================================================
# UPDATE
# ============================================================

def update_program(program):
    program_id = validate_program_id(program["id"])
    target = INSTALL_ROOT / program_id

    if not target.is_dir():
        raise FileNotFoundError("Programm ist nicht installiert.")

    temporary_root = Path(
        tempfile.mkdtemp(prefix="core-update-", dir=STORE_ROOT)
    )

    stage = temporary_root / "program"
    archive = temporary_root / "program.zip"
    backup = temporary_root / "backup"

    moved_old = False

    try:
        download_program(program_id, archive)
        extract_safely(archive, stage)

        # Persönliche Dateien und Daten übernehmen.
        preserve_user_data(
            program,
            target,
            stage
        )

        # Optionales Update-Skript ausführen.
        execute_configured(
            program,
            stage,
            "update"
        )

        # Altes Verzeichnis sichern.
        os.replace(target, backup)
        moved_old = True

        try:
            os.replace(stage, target)

        except Exception:
            if moved_old and backup.exists() and not target.exists():
                os.replace(backup, target)

            raise

        if backup.exists():
            shutil.rmtree(backup, ignore_errors=True)

        installed = load_installed()

        installed[program_id] = {
            "name": program.get("name", program_id),
            "version": program.get("version", "0.0.0"),
            "folder": str(target),
            "installed": True
        }

        save_installed(installed)

    finally:
        # Bei einem Fehler nach dem Verschieben versuchen,
        # das alte Programm wiederherzustellen.
        if moved_old and backup.exists() and not target.exists():
            os.replace(backup, target)

        shutil.rmtree(temporary_root, ignore_errors=True)


# ============================================================
# DEINSTALLATION
# ============================================================

def uninstall_program(program):
    program_id = validate_program_id(program["id"])
    target = INSTALL_ROOT / program_id

    if not target.is_dir():
        raise FileNotFoundError("Programm ist nicht installiert.")

    # Zuerst Deinstallationsdatei ausführen.
    # Bei Fehler bleibt das Programmverzeichnis erhalten.
    execute_configured(
        program,
        target,
        "uninstallation"
    )

    shutil.rmtree(target)

    installed = load_installed()
    installed.pop(program_id, None)
    save_installed(installed)


# ============================================================
# API
# ============================================================

def fetch_programs():
    response = requests.get(
        f"{API_URL}/api/programs",
        timeout=REQUEST_TIMEOUT
    )

    response.raise_for_status()

    data = response.json()
    programs = data.get("programs", [])

    if not isinstance(programs, list):
        raise RuntimeError("Die API hat eine ungültige Programmliste geliefert.")

    return programs


# ============================================================
# BENUTZEROBERFLÄCHE
# ============================================================

class CoreStore:

    def __init__(self, root):
        self.root = root

        self.root.title("Core Store")
        self.root.geometry("1100x700")
        self.root.minsize(850, 550)
        self.root.configure(bg="#0b1220")

        self.programs = []
        self.filtered_programs = []
        self.selected_program = None

        self.installed = load_installed()

        self.setup_style()
        self.build_ui()
        self.refresh_programs()

    # --------------------------------------------------------
    # DESIGN
    # --------------------------------------------------------

    def setup_style(self):
        style = ttk.Style()

        try:
            style.theme_use("clam")
        except Exception:
            pass

        style.configure(
            "TFrame",
            background="#0b1220"
        )

        style.configure(
            "TLabel",
            background="#0b1220",
            foreground="#e5eefb",
            font=("Segoe UI", 10)
        )

        style.configure(
            "Title.TLabel",
            font=("Segoe UI", 23, "bold"),
            foreground="#55d6ff"
        )

        style.configure(
            "Subtitle.TLabel",
            font=("Segoe UI", 10),
            foreground="#8ca3bd"
        )

        style.configure(
            "TButton",
            background="#12304a",
            foreground="#ffffff",
            padding=9,
            borderwidth=0
        )

        style.map(
            "TButton",
            background=[
                ("active", "#17618a"),
                ("disabled", "#253449")
            ]
        )

        style.configure(
            "TEntry",
            fieldbackground="#152238",
            foreground="#ffffff",
            insertcolor="#ffffff",
            padding=8
        )

        style.configure(
            "TCombobox",
            fieldbackground="#152238",
            foreground="#ffffff",
            background="#152238",
            padding=6
        )

    # --------------------------------------------------------
    # UI AUFBAUEN
    # --------------------------------------------------------

    def build_ui(self):
        header = ttk.Frame(self.root, padding=20)
        header.pack(fill="x")

        ttk.Label(
            header,
            text="CORE STORE",
            style="Title.TLabel"
        ).pack(anchor="w")

        ttk.Label(
            header,
            text="Programme entdecken, installieren und verwalten",
            style="Subtitle.TLabel"
        ).pack(anchor="w", pady=(4, 0))

        toolbar = ttk.Frame(self.root, padding=(20, 0, 20, 15))
        toolbar.pack(fill="x")

        self.search_var = tk.StringVar()

        self.search_entry = ttk.Entry(
            toolbar,
            textvariable=self.search_var
        )

        self.search_entry.pack(
            side="left",
            fill="x",
            expand=True
        )

        self.search_entry.bind(
            "<KeyRelease>",
            lambda _event: self.apply_filter()
        )

        self.category_var = tk.StringVar(value="Alle Kategorien")

        self.category_box = ttk.Combobox(
            toolbar,
            textvariable=self.category_var,
            state="readonly",
            width=22
        )

        self.category_box.pack(
            side="left",
            padx=(10, 0)
        )

        self.category_box.bind(
            "<<ComboboxSelected>>",
            lambda _event: self.apply_filter()
        )

        ttk.Button(
            toolbar,
            text="Aktualisieren",
            command=self.refresh_programs
        ).pack(side="left", padx=(10, 0))

        content = ttk.Frame(self.root, padding=(20, 0, 20, 10))
        content.pack(fill="both", expand=True)

        left = ttk.Frame(content)
        left.pack(side="left", fill="both", expand=True)

        right = ttk.Frame(
            content,
            padding=18
        )

        right.pack(
            side="right",
            fill="both",
            expand=True,
            padx=(15, 0)
        )

        ttk.Label(
            left,
            text="VERFÜGBARE PROGRAMME",
            font=("Segoe UI", 11, "bold")
        ).pack(anchor="w", pady=(0, 10))

        list_frame = tk.Frame(
            left,
            bg="#152238",
            highlightbackground="#263b56",
            highlightthickness=1
        )

        list_frame.pack(fill="both", expand=True)

        scrollbar = tk.Scrollbar(list_frame)
        scrollbar.pack(side="right", fill="y")

        self.program_list = tk.Listbox(
            list_frame,
            bg="#152238",
            fg="#e5eefb",
            selectbackground="#17618a",
            selectforeground="#ffffff",
            font=("Segoe UI", 10),
            relief="flat",
            borderwidth=0,
            activestyle="none",
            yscrollcommand=scrollbar.set
        )

        self.program_list.pack(
            side="left",
            fill="both",
            expand=True,
            padx=8,
            pady=8
        )

        scrollbar.config(
            command=self.program_list.yview
        )

        self.program_list.bind(
            "<<ListboxSelect>>",
            self.on_select
        )

        ttk.Label(
            right,
            text="PROGRAMMDETAILS",
            font=("Segoe UI", 11, "bold")
        ).pack(anchor="w")

        self.detail_name = tk.Label(
            right,
            text="Programm auswählen",
            bg="#0b1220",
            fg="#55d6ff",
            font=("Segoe UI", 19, "bold"),
            anchor="w",
            justify="left",
            wraplength=350
        )

        self.detail_name.pack(
            fill="x",
            pady=(20, 8)
        )

        self.detail_info = tk.Label(
            right,
            text="Wähle links ein Programm aus.",
            bg="#0b1220",
            fg="#a9bbd0",
            font=("Segoe UI", 10),
            anchor="nw",
            justify="left",
            wraplength=350
        )

        self.detail_info.pack(
            fill="both",
            expand=True,
            anchor="nw"
        )

        button_frame = ttk.Frame(right)
        button_frame.pack(fill="x", pady=(20, 0))

        self.install_button = ttk.Button(
            button_frame,
            text="Installieren",
            command=self.install_selected
        )
        self.install_button.pack(fill="x", pady=4)

        self.start_button = ttk.Button(
            button_frame,
            text="Starten",
            command=self.start_selected
        )
        self.start_button.pack(fill="x", pady=4)

        self.update_button = ttk.Button(
            button_frame,
            text="Aktualisieren",
            command=self.update_selected
        )
        self.update_button.pack(fill="x", pady=4)

        self.uninstall_button = ttk.Button(
            button_frame,
            text="Deinstallieren",
            command=self.uninstall_selected
        )
        self.uninstall_button.pack(fill="x", pady=4)

        footer = ttk.Frame(self.root, padding=(20, 8, 20, 15))
        footer.pack(fill="x")

        self.status_label = ttk.Label(
            footer,
            text="Bereit",
            style="Subtitle.TLabel"
        )

        self.status_label.pack(anchor="w")

        self.update_buttons()

    # --------------------------------------------------------
    # PROGRAMME LADEN
    # --------------------------------------------------------

    def refresh_programs(self):
        self.set_status("Lade Programme ...")
        self.set_buttons_enabled(False)

        def worker():
            try:
                programs = fetch_programs()

                self.root.after(
                    0,
                    lambda: self.on_programs_loaded(programs)
                )

            except Exception as exc:
                self.root.after(
                    0,
                    lambda error=str(exc): self.on_load_error(error)
                )

        threading.Thread(
            target=worker,
            daemon=True
        ).start()

    def on_programs_loaded(self, programs):
        self.programs = programs

        categories = sorted({
            str(program.get("category", "Sonstiges"))
            for program in programs
        })

        self.category_box["values"] = [
            "Alle Kategorien"
        ] + categories

        self.category_var.set("Alle Kategorien")

        self.apply_filter()
        self.set_status(
            f"{len(programs)} Programme geladen."
        )

        self.set_buttons_enabled(True)

    def on_load_error(self, error):
        self.set_status("Fehler beim Laden.")
        self.set_buttons_enabled(True)

        messagebox.showerror(
            "Core Store",
            f"Programme konnten nicht geladen werden:\n\n{error}"
        )

    # --------------------------------------------------------
    # FILTER
    # --------------------------------------------------------

    def apply_filter(self):
        search = self.search_var.get().strip().lower()
        category = self.category_var.get()

        self.filtered_programs = []

        for program in self.programs:
            name = str(program.get("name", "")).lower()
            description = str(
                program.get("short_description", "")
            ).lower()

            program_category = str(
                program.get("category", "Sonstiges")
            )

            if search and search not in name and search not in description:
                continue

            if (
                category != "Alle Kategorien"
                and program_category != category
            ):
                continue

            self.filtered_programs.append(program)

        self.program_list.delete(0, tk.END)

        for program in self.filtered_programs:
            program_id = program.get("id", "")
            name = program.get("name", program_id)

            if program_id in self.installed:
                name = f"[INSTALLIERT] {name}"

            self.program_list.insert(tk.END, name)

        self.selected_program = None
        self.show_program_details(None)
        self.update_buttons()

    # --------------------------------------------------------
    # AUSWAHL
    # --------------------------------------------------------

    def on_select(self, _event=None):
        selection = self.program_list.curselection()

        if not selection:
            return

        index = selection[0]

        if index >= len(self.filtered_programs):
            return

        self.selected_program = self.filtered_programs[index]

        self.show_program_details(
            self.selected_program
        )

        self.update_buttons()

    def show_program_details(self, program):
        if not program:
            self.detail_name.config(
                text="Programm auswählen"
            )

            self.detail_info.config(
                text="Wähle links ein Programm aus."
            )

            return

        name = program.get("name", "Unbekannt")
        version = program.get("version", "Unbekannt")
        author = program.get("author", "Unbekannt")
        category = program.get("category", "Sonstiges")

        description = program.get(
            "description",
            program.get("short_description", "")
        )

        program_id = program.get("id", "")
        installed = program_id in self.installed

        status = (
            "Installiert"
            if installed
            else "Nicht installiert"
        )

        files = program.get("files", {})

        install_file = files.get("installation") or "Keine"
        start_file = files.get("start") or "Keine"
        uninstall_file = files.get("uninstallation") or "Keine"
        update_file = files.get("update") or "Keine"

        self.detail_name.config(text=name)

        info = (
            f"{description}\n\n"
            f"Version: {version}\n"
            f"Autor: {author}\n"
            f"Kategorie: {category}\n"
            f"Status: {status}\n\n"
            f"INSTALLATION\n{install_file}\n\n"
            f"START\n{start_file}\n\n"
            f"DEINSTALLATION\n{uninstall_file}\n\n"
            f"UPDATE\n{update_file}"
        )

        self.detail_info.config(text=info)

    # --------------------------------------------------------
    # BUTTONS
    # --------------------------------------------------------

    def update_buttons(self):
        program = self.selected_program

        if not program:
            for button in (
                self.install_button,
                self.start_button,
                self.update_button,
                self.uninstall_button
            ):
                button.config(state="disabled")

            return

        program_id = program.get("id")
        installed = program_id in self.installed

        self.install_button.config(
            state="disabled" if installed else "normal"
        )

        self.start_button.config(
            state="normal" if installed else "disabled"
        )

        self.update_button.config(
            state="normal" if installed else "disabled"
        )

        self.uninstall_button.config(
            state="normal" if installed else "disabled"
        )

    def set_buttons_enabled(self, enabled):
        state = "normal" if enabled else "disabled"

        self.search_entry.config(state=state)
        self.category_box.config(state="readonly" if enabled else "disabled")

        self.program_list.config(
            state=state
        )

        if not enabled:
            for button in (
                self.install_button,
                self.start_button,
                self.update_button,
                self.uninstall_button
            ):
                button.config(state="disabled")
        else:
            self.update_buttons()

    # --------------------------------------------------------
    # HINTERGRUNDAUFGABEN
    # --------------------------------------------------------

    def run_background(self, label, function, success_message):
        self.set_status(label)
        self.set_buttons_enabled(False)

        def worker():
            try:
                function()

                self.root.after(
                    0,
                    lambda: self.action_finished(success_message)
                )

            except Exception as exc:
                self.root.after(
                    0,
                    lambda error=str(exc): self.action_failed(error)
                )

        threading.Thread(
            target=worker,
            daemon=True
        ).start()

    def action_finished(self, message):
        self.installed = load_installed()

        self.apply_filter()
        self.set_buttons_enabled(True)

        self.set_status(message)

        messagebox.showinfo(
            "Core Store",
            message
        )

    def action_failed(self, error):
        self.installed = load_installed()

        self.apply_filter()
        self.set_buttons_enabled(True)

        self.set_status("Aktion fehlgeschlagen.")

        messagebox.showerror(
            "Core Store",
            error
        )

    # --------------------------------------------------------
    # INSTALLIEREN
    # --------------------------------------------------------

    def install_selected(self):
        program = self.selected_program

        if not program:
            return

        if not messagebox.askyesno(
            "Installation",
            f"Möchtest du {program.get('name')} installieren?\n\n"
            "Das Programm kann während der Installation lokale Skripte ausführen."
        ):
            return

        self.run_background(
            "Installiere Programm ...",
            lambda: install_program(program),
            "Programm erfolgreich installiert."
        )

    # --------------------------------------------------------
    # STARTEN
    # --------------------------------------------------------

    def start_selected(self):
        program = self.selected_program

        if not program:
            return

        try:
            start_program(program)
            self.set_status("Programm gestartet.")

        except Exception as exc:
            messagebox.showerror(
                "Startfehler",
                str(exc)
            )

    # --------------------------------------------------------
    # UPDATE
    # --------------------------------------------------------

    def update_selected(self):
        program = self.selected_program

        if not program:
            return

        if not messagebox.askyesno(
            "Update",
            f"Möchtest du {program.get('name')} aktualisieren?\n\n"
            "Die konfigurierten Daten und Ordner werden übernommen."
        ):
            return

        self.run_background(
            "Aktualisiere Programm ...",
            lambda: update_program(program),
            "Programm erfolgreich aktualisiert."
        )

    # --------------------------------------------------------
    # DEINSTALLIEREN
    # --------------------------------------------------------

    def uninstall_selected(self):
        program = self.selected_program

        if not program:
            return

        if not messagebox.askyesno(
            "Deinstallation",
            f"Möchtest du {program.get('name')} wirklich deinstallieren?\n\n"
            "Die Programmdateien werden anschließend gelöscht."
        ):
            return

        self.run_background(
            "Deinstalliere Programm ...",
            lambda: uninstall_program(program),
            "Programm erfolgreich deinstalliert."
        )

    # --------------------------------------------------------
    # STATUS
    # --------------------------------------------------------

    def set_status(self, text):
        self.status_label.config(text=text)


# ============================================================
# START
# ============================================================

def main():
    root = tk.Tk()
    CoreStore(root)
    root.mainloop()


if __name__ == "__main__":
    try:
        main()

    except Exception as exc:
        try:
            root = tk.Tk()
            root.withdraw()

            messagebox.showerror(
                "Core Store Startfehler",
                str(exc)
            )

        except Exception:
            print(exc)

        sys.exit(1)
