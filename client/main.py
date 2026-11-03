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
# VERSION UND PFADE
# ============================================================

APP_VERSION = "1.0.0"

BASE_DIR = Path(__file__).resolve().parent
SETTINGS_FILE = BASE_DIR / "settings.json"
UPDATER_FILE = BASE_DIR / "updater.py"

LOCAL_APPDATA = Path(
    os.getenv(
        "LOCALAPPDATA",
        str(Path.home() / "AppData" / "Local")
    )
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
# API-EINSTELLUNGEN
# ============================================================

def load_settings():
    if not SETTINGS_FILE.is_file():
        raise RuntimeError("settings.json fehlt.")

    with open(SETTINGS_FILE, "r", encoding="utf-8") as file:
        settings = json.load(file)

    url = settings.get("api_url", "").strip().rstrip("/")

    if not url.startswith(("https://", "http://")):
        raise RuntimeError("Ungültige API-Adresse.")

    return url


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
        json.dump(
            data,
            file,
            indent=4,
            ensure_ascii=False
        )

    os.replace(temporary, INSTALLED_FILE)


# ============================================================
# SICHERE DATEIPFADE
# ============================================================

def validate_id(value):
    if not isinstance(value, str):
        raise ValueError("Ungültige Programm-ID.")

    if not re.fullmatch(r"[a-zA-Z0-9_-]+", value):
        raise ValueError("Ungültige Programm-ID.")

    return value


def safe_relative(value):
    if not isinstance(value, str) or not value:
        raise ValueError("Leerer Dateipfad.")

    value = value.replace("\\", "/")

    if value.startswith("/") or ":" in value:
        raise ValueError("Ungültiger Dateipfad.")

    parts = value.split("/")

    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Ungültiger Dateipfad.")

    return "/".join(parts)


def safe_child(parent, relative):
    parent = Path(parent).resolve()
    relative = safe_relative(relative)

    target = (parent / Path(*relative.split("/"))).resolve()

    try:
        target.relative_to(parent)
    except ValueError:
        raise ValueError("Dateipfad liegt außerhalb des Ordners.")

    return target


# ============================================================
# DOWNLOADS
# ============================================================

def download_url(url, destination):
    response = requests.get(
        url,
        timeout=REQUEST_TIMEOUT,
        stream=True
    )

    response.raise_for_status()

    with open(destination, "wb") as file:
        for chunk in response.iter_content(1024 * 1024):
            if chunk:
                file.write(chunk)


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

        raise RuntimeError(error)

    with open(destination, "wb") as file:
        for chunk in response.iter_content(1024 * 1024):
            if chunk:
                file.write(chunk)


# ============================================================
# SICHERE ZIP-EXTRAKTION
# ============================================================

def extract_safely(archive_path, destination):
    destination = Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(archive_path, "r") as archive:
        for item in archive.infolist():
            if item.is_dir():
                continue

            relative = safe_relative(item.filename)
            target = safe_child(destination, relative)

            mode = (item.external_attr >> 16) & 0xFFFF

            if mode and (mode & 0o170000) == 0o120000:
                raise ValueError("Symbolischer Link im Archiv.")

            target.parent.mkdir(parents=True, exist_ok=True)

            with archive.open(item, "r") as source:
                with open(target, "wb") as output:
                    shutil.copyfileobj(source, output)


# ============================================================
# DATEIEN AUSFÜHREN
# ============================================================

def execute_file(
    program_dir,
    relative_file,
    wait=True,
    show_console=True,
    action="start"
):
    if not relative_file:
        return None

    relative_file = safe_relative(relative_file)
    program_dir = Path(program_dir).resolve()

    file_path = safe_child(program_dir, relative_file)

    if not file_path.is_file():
        raise FileNotFoundError(
            f"Datei nicht gefunden: {relative_file}"
        )

    extension = file_path.suffix.lower()

    if extension in (".html", ".htm"):
        if action != "start":
            raise ValueError("HTML ist nur als Startdatei erlaubt.")

        os.startfile(str(file_path))
        return None

    if extension == ".py":
        command = [sys.executable, str(file_path)]

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
            f"Dateityp nicht unterstützt: {extension}"
        )

    environment = os.environ.copy()
    environment["CORE_STORE_PROGRAM_DIR"] = str(program_dir)
    environment["CORE_STORE_ACTION"] = action

    flags = 0

    if os.name == "nt" and not show_console:
        flags = subprocess.CREATE_NO_WINDOW

    process = subprocess.Popen(
        command,
        cwd=str(program_dir),
        env=environment,
        creationflags=flags
    )

    if wait:
        result = process.wait()

        if result != 0:
            raise RuntimeError(
                f"{relative_file} wurde mit Fehlercode {result} beendet."
            )

    return process


def configured_action(program, program_dir, action):
    files = program.get("files", {})
    execution = program.get("execution", {})

    relative_file = files.get(action)

    if not relative_file:
        return

    if not execution.get(action, True):
        return

    wait_settings = {
        "installation": "wait_for_installation",
        "uninstallation": "wait_for_uninstallation",
        "update": "wait_for_update"
    }

    wait = execution.get(
        wait_settings.get(action, ""),
        True
    )

    show_console = execution.get("show_console", True)

    execute_file(
        program_dir,
        relative_file,
        wait=wait,
        show_console=show_console,
        action=action
    )


# ============================================================
# UPDATE-DATEN ERHALTEN
# ============================================================

def preserve_user_data(program, old_dir, new_dir):
    for relative in program.get("update_preserve", []):
        relative = safe_relative(relative)

        old_path = safe_child(old_dir, relative)
        new_path = safe_child(new_dir, relative)

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
# PROGRAMM INSTALLIEREN
# ============================================================

def install_program(program):
    program_id = validate_id(program["id"])
    target = INSTALL_ROOT / program_id

    if target.exists():
        raise RuntimeError("Programm ist bereits installiert.")

    temporary = Path(
        tempfile.mkdtemp(
            prefix="core-install-",
            dir=STORE_ROOT
        )
    )

    stage = temporary / "program"
    archive = temporary / "program.zip"

    try:
        download_program(program_id, archive)
        extract_safely(archive, stage)

        configured_action(
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
        shutil.rmtree(temporary, ignore_errors=True)


# ============================================================
# PROGRAMM STARTEN
# ============================================================

def start_program(program):
    program_id = validate_id(program["id"])
    target = INSTALL_ROOT / program_id

    if not target.is_dir():
        raise FileNotFoundError("Programm ist nicht installiert.")

    configured_action(
        program,
        target,
        "start"
    )


# ============================================================
# PROGRAMM AKTUALISIEREN
# ============================================================

def update_program(program):
    program_id = validate_id(program["id"])
    target = INSTALL_ROOT / program_id

    if not target.is_dir():
        raise FileNotFoundError("Programm ist nicht installiert.")

    temporary = Path(
        tempfile.mkdtemp(
            prefix="core-update-",
            dir=STORE_ROOT
        )
    )

    stage = temporary / "program"
    archive = temporary / "program.zip"
    backup = temporary / "backup"

    moved_old = False

    try:
        download_program(program_id, archive)
        extract_safely(archive, stage)

        preserve_user_data(
            program,
            target,
            stage
        )

        configured_action(
            program,
            stage,
            "update"
        )

        os.replace(target, backup)
        moved_old = True

        try:
            os.replace(stage, target)

        except Exception:
            if backup.exists() and not target.exists():
                os.replace(backup, target)

            raise

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
        if moved_old and backup.exists() and not target.exists():
            os.replace(backup, target)

        shutil.rmtree(temporary, ignore_errors=True)


# ============================================================
# PROGRAMM DEINSTALLIEREN
# ============================================================

def uninstall_program(program):
    program_id = validate_id(program["id"])
    target = INSTALL_ROOT / program_id

    if not target.is_dir():
        raise FileNotFoundError("Programm ist nicht installiert.")

    configured_action(
        program,
        target,
        "uninstallation"
    )

    shutil.rmtree(target)

    installed = load_installed()
    installed.pop(program_id, None)

    save_installed(installed)


# ============================================================
# STORE-VERSION
# ============================================================

def parse_version(version):
    if not isinstance(version, str):
        raise ValueError("Ungültige Versionsnummer.")

    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Versionsnummer muss z. B. 1.2.0 sein.")

    return tuple(int(part) for part in version.split("."))


def remote_store_version():
    response = requests.get(
        f"{API_URL}/api/store/version",
        timeout=30
    )

    response.raise_for_status()

    data = response.json()

    if not data.get("enabled", True):
        return None

    if "version" not in data:
        raise RuntimeError("Store-Version fehlt.")

    return data


def is_newer_version(remote, local):
    return parse_version(remote) > parse_version(local)


# ============================================================
# STORE UPDATE HERUNTERLADEN
# ============================================================

def download_store_update():
    response = requests.get(
        f"{API_URL}/api/store/download",
        timeout=REQUEST_TIMEOUT,
        stream=True
    )

    if response.status_code != 200:
        try:
            error = response.json().get("error", response.text)
        except Exception:
            error = response.text

        raise RuntimeError(error)

    update_file = STORE_DATA / "core-store-update.zip"

    with open(update_file, "wb") as file:
        for chunk in response.iter_content(1024 * 1024):
            if chunk:
                file.write(chunk)

    return update_file


# ============================================================
# PROGRAMMLISTE
# ============================================================

def fetch_programs():
    response = requests.get(
        f"{API_URL}/api/programs",
        timeout=REQUEST_TIMEOUT
    )

    response.raise_for_status()

    data = response.json()

    if not isinstance(data.get("programs"), list):
        raise RuntimeError("Ungültige Programmliste.")

    return data["programs"]


# ============================================================
# BENUTZEROBERFLÄCHE
# ============================================================

class CoreStore:

    def __init__(self, root):
        self.root = root

        self.root.title(f"Core Store {APP_VERSION}")
        self.root.geometry("1150x730")
        self.root.minsize(900, 600)
        self.root.configure(bg="#0b1220")

        self.programs = []
        self.filtered_programs = []
        self.selected_program = None
        self.installed = load_installed()

        self.setup_style()
        self.build_ui()
        self.refresh_programs()

        # Version automatisch prüfen.
        self.root.after(1500, self.check_update_on_start)

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
            font=("Segoe UI", 24, "bold"),
            foreground="#55d6ff"
        )

        style.configure(
            "Subtitle.TLabel",
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
    # UI
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
            text=f"Version {APP_VERSION}  |  Programme verwalten",
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

        self.category_var = tk.StringVar(
            value="Alle Kategorien"
        )

        self.category_box = ttk.Combobox(
            toolbar,
            textvariable=self.category_var,
            state="readonly",
            width=20
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
            text="Programme laden",
            command=self.refresh_programs
        ).pack(side="left", padx=(10, 0))

        ttk.Button(
            toolbar,
            text="Store aktualisieren",
            command=self.update_store
        ).pack(side="left", padx=(10, 0))

        content = ttk.Frame(
            self.root,
            padding=(20, 0, 20, 10)
        )

        content.pack(fill="both", expand=True)

        left = ttk.Frame(content)
        left.pack(side="left", fill="both", expand=True)

        right = ttk.Frame(content, padding=18)
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
            text="Programm aktualisieren",
            command=self.update_selected
        )
        self.update_button.pack(fill="x", pady=4)

        self.uninstall_button = ttk.Button(
            button_frame,
            text="Deinstallieren",
            command=self.uninstall_selected
        )
        self.uninstall_button.pack(fill="x", pady=4)

        footer = ttk.Frame(
            self.root,
            padding=(20, 8, 20, 15)
        )

        footer.pack(fill="x")

        self.status_label = ttk.Label(
            footer,
            text="Bereit",
            style="Subtitle.TLabel"
        )

        self.status_label.pack(anchor="w")

        self.update_buttons()

    # --------------------------------------------------------
    # STATUS UND BUTTONS
    # --------------------------------------------------------

    def set_status(self, text):
        self.status_label.config(text=text)

    def set_buttons_enabled(self, enabled):
        state = "normal" if enabled else "disabled"

        self.search_entry.config(state=state)

        self.category_box.config(
            state="readonly" if enabled else "disabled"
        )

        self.program_list.config(state=state)

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

        installed = program.get("id") in self.installed

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

    # --------------------------------------------------------
    # PROGRAMME LADEN
    # --------------------------------------------------------

    def refresh_programs(self):
        self.set_status("Lade Programme ...")
        self.set_buttons_enabled(False)

        def worker():
            try:
                result = fetch_programs()

                self.root.after(
                    0,
                    lambda: self.programs_loaded(result)
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

    def programs_loaded(self, programs):
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
        self.set_buttons_enabled(True)

        self.set_status(
            f"{len(programs)} Programme geladen."
        )

    # --------------------------------------------------------
    # FILTER
    # --------------------------------------------------------

    def apply_filter(self):
        search = self.search_var.get().lower().strip()
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
                and category != program_category
            ):
                continue

            self.filtered_programs.append(program)

        self.program_list.delete(0, tk.END)

        for program in self.filtered_programs:
            name = program.get("name", program.get("id", ""))

            if program.get("id") in self.installed:
                name = "[INSTALLIERT] " + name

            self.program_list.insert(tk.END, name)

        self.selected_program = None
        self.show_details(None)
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

        self.show_details(self.selected_program)
        self.update_buttons()

    def show_details(self, program):
        if not program:
            self.detail_name.config(text="Programm auswählen")
            self.detail_info.config(
                text="Wähle links ein Programm aus."
            )
            return

        files = program.get("files", {})

        installed = program.get("id") in self.installed

        self.detail_name.config(
            text=program.get("name", "Unbekannt")
        )

        text = (
            f"{program.get('description', '')}\n\n"
            f"Version: {program.get('version', 'Unbekannt')}\n"
            f"Autor: {program.get('author', 'Unbekannt')}\n"
            f"Kategorie: {program.get('category', 'Sonstiges')}\n"
            f"Status: {'Installiert' if installed else 'Nicht installiert'}\n\n"
            f"INSTALLATION\n{files.get('installation') or 'Keine'}\n\n"
            f"START\n{files.get('start') or 'Keine'}\n\n"
            f"UPDATE\n{files.get('update') or 'Keine'}\n\n"
            f"DEINSTALLATION\n{files.get('uninstallation') or 'Keine'}"
        )

        self.detail_info.config(text=text)

    # --------------------------------------------------------
    # AKTIONEN IM HINTERGRUND
    # --------------------------------------------------------

    def run_background(self, status, function, success):
        self.set_status(status)
        self.set_buttons_enabled(False)

        def worker():
            try:
                function()

                self.root.after(
                    0,
                    lambda: self.action_finished(success)
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
            "Möchtest du dieses Programm installieren?\n\n"
            "Das Programm kann lokale Installationsskripte ausführen."
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
        if not self.selected_program:
            return

        try:
            start_program(self.selected_program)
            self.set_status("Programm gestartet.")

        except Exception as exc:
            messagebox.showerror("Startfehler", str(exc))

    # --------------------------------------------------------
    # PROGRAMM UPDATE
    # --------------------------------------------------------

    def update_selected(self):
        program = self.selected_program

        if not program:
            return

        if not messagebox.askyesno(
            "Programm aktualisieren",
            f"Möchtest du {program.get('name')} aktualisieren?"
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
            f"Möchtest du {program.get('name')} deinstallieren?"
        ):
            return

        self.run_background(
            "Deinstalliere Programm ...",
            lambda: uninstall_program(program),
            "Programm erfolgreich deinstalliert."
        )

    # --------------------------------------------------------
    # CORE STORE UPDATE PRÜFEN
    # --------------------------------------------------------

    def check_update_on_start(self):
        def worker():
            try:
                data = remote_store_version()

                if not data:
                    return

                remote = data["version"]

                if is_newer_version(remote, APP_VERSION):
                    self.root.after(
                        0,
                        lambda: self.show_update_available(data)
                    )

            except Exception:
                # Bei nicht erreichbarer API bleibt der Store nutzbar.
                pass

        threading.Thread(
            target=worker,
            daemon=True
        ).start()

    def show_update_available(self, data):
        notes = "\n".join(
            "- " + str(note)
            for note in data.get("release_notes", [])
        )

        answer = messagebox.askyesno(
            "Core Store Update verfügbar",
            f"Neue Version: {data['version']}\n"
            f"Installiert: {APP_VERSION}\n\n"
            f"Änderungen:\n{notes}\n\n"
            "Jetzt aktualisieren?"
        )

        if answer:
            self.update_store()

    # --------------------------------------------------------
    # CORE STORE AKTUALISIEREN
    # --------------------------------------------------------

    def update_store(self):
        if not UPDATER_FILE.is_file():
            messagebox.showerror(
                "Core Store",
                "updater.py fehlt. Update nicht möglich."
            )
            return

        self.set_status("Prüfe Store-Update ...")

        def worker():
            try:
                data = remote_store_version()

                if not data:
                    raise RuntimeError("Store-Updates sind deaktiviert.")

                remote = data["version"]

                if not is_newer_version(remote, APP_VERSION):
                    self.root.after(
                        0,
                        lambda: messagebox.showinfo(
                            "Core Store",
                            "Der Core Store ist bereits aktuell."
                        )
                    )
                    return

                update_file = download_store_update()

                self.root.after(
                    0,
                    lambda: self.launch_updater(
                        update_file,
                        remote
                    )
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

    def launch_updater(self, update_file, version):
        answer = messagebox.askyesno(
            "Core Store aktualisieren",
            f"Die neue Version {version} wurde heruntergeladen.\n\n"
            "Der Store muss geschlossen werden, um die Dateien zu ersetzen.\n"
            "Möchtest du fortfahren?"
        )

        if not answer:
            return

        subprocess.Popen([
            sys.executable,
            str(UPDATER_FILE),
            str(update_file),
            str(BASE_DIR),
            str(os.getpid())
        ])

        self.root.destroy()


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
