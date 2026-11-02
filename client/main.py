import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import zipfile

from pathlib import Path

import tkinter as tk
from tkinter import messagebox, ttk

import requests


APP_NAME = "Core Store"

LOCAL_ROOT = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home())))
    / "Core Network"
)

STORE_DATA = LOCAL_ROOT / "_store"
INSTALLED_FILE = STORE_DATA / "installed.json"

SETTINGS_FILE = Path(__file__).with_name("settings.json")

WINDOW_BG = "#101827"
PANEL_BG = "#172438"
CARD_BG = "#1d2d44"

TEXT = "#f4f7fb"
MUTED = "#aab8ca"

ACCENT = "#22D3EE"
GREEN = "#22c55e"
RED = "#ef4444"
GOLD = "#f5c451"


def load_settings():
    try:
        data = json.loads(
            SETTINGS_FILE.read_text(encoding="utf-8")
        )

        return data.get("api_url", "").rstrip("/")

    except Exception:
        return ""


def load_installed():
    try:
        data = json.loads(
            INSTALLED_FILE.read_text(encoding="utf-8")
        )

        return data if isinstance(data, dict) else {}

    except Exception:
        return {}


def save_installed(data):
    STORE_DATA.mkdir(
        parents=True,
        exist_ok=True
    )

    temporary = INSTALLED_FILE.with_suffix(".tmp")

    temporary.write_text(
        json.dumps(
            data,
            indent=2,
            ensure_ascii=False
        ),
        encoding="utf-8"
    )

    temporary.replace(INSTALLED_FILE)


def safe_child(root, name):
    if (
        not isinstance(name, str)
        or not name
        or name in (".", "..")
        or "/" in name
        or "\\" in name
    ):
        raise ValueError("Ungültiger Programmordner.")

    root = Path(root).resolve()
    target = (root / name).resolve()

    if target == root or root not in target.parents:
        raise ValueError("Ungültiger Installationspfad.")

    return target


def safe_relative_path(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Ungültiger relativer Pfad.")

    value = value.replace("\\", "/")

    parts = value.split("/")

    if (
        value.startswith("/")
        or any(part in ("", ".", "..") for part in parts)
        or (parts and ":" in parts[0])
    ):
        raise ValueError("Unsicherer Dateipfad.")

    return Path(*parts)


def extract_safely(zip_path, destination):
    destination = Path(destination).resolve()

    with zipfile.ZipFile(zip_path, "r") as archive:
        for member in archive.infolist():
            relative = safe_relative_path(
                member.filename
            )

            target = (
                destination / relative
            ).resolve()

            if target != destination and destination not in target.parents:
                raise ValueError(
                    "ZIP-Datei enthält einen unsicheren Pfad."
                )

        archive.extractall(destination)


def download_program(program_id, destination):
    response = requests.get(
        f"{API_URL}/api/programs/{program_id}/download",
        stream=True,
        timeout=(20, 300)
    )

    if response.status_code >= 400:
        try:
            detail = response.json().get(
                "error",
                response.text
            )
        except Exception:
            detail = response.text

        raise RuntimeError(detail)

    with open(destination, "wb") as output:
        for chunk in response.iter_content(
            chunk_size=256 * 1024
        ):
            if chunk:
                output.write(chunk)


def launch_file(program_dir, relative_file, wait=False):
    relative = safe_relative_path(relative_file)

    target = (
        Path(program_dir) / relative
    ).resolve()

    program_dir = Path(program_dir).resolve()

    if target != program_dir and program_dir not in target.parents:
        raise ValueError(
            "Die Startdatei liegt außerhalb des Programmordners."
        )

    if not target.is_file():
        raise FileNotFoundError(
            f"Datei nicht gefunden: {relative_file}"
        )

    suffix = target.suffix.lower()

    if suffix == ".py":
        command = [
            sys.executable,
            str(target)
        ]

        if wait:
            return subprocess.run(
                command,
                cwd=str(program_dir),
                check=False
            )

        return subprocess.Popen(
            command,
            cwd=str(program_dir)
        )

    if suffix in (".bat", ".cmd"):
        command = [
            "cmd.exe",
            "/c",
            str(target)
        ]

        if wait:
            return subprocess.run(
                command,
                cwd=str(program_dir),
                check=False
            )

        return subprocess.Popen(
            command,
            cwd=str(program_dir),
            creationflags=getattr(
                subprocess,
                "CREATE_NEW_CONSOLE",
                0
            )
        )

    if suffix == ".exe":
        if wait:
            return subprocess.run(
                [str(target)],
                cwd=str(program_dir),
                check=False
            )

        return subprocess.Popen(
            [str(target)],
            cwd=str(program_dir)
        )

    if suffix in (".html", ".htm"):
        if wait:
            raise ValueError(
                "HTML-Dateien können nicht als Installationsskript verwendet werden."
            )

        os.startfile(str(target))
        return None

    raise ValueError(
        f"Nicht unterstützter Dateityp: {suffix}"
    )


API_URL = load_settings()


class CoreStore:

    def __init__(self, root):
        self.root = root

        self.root.title("Core Store")
        self.root.geometry("1120x760")
        self.root.minsize(900, 620)
        self.root.configure(bg=WINDOW_BG)

        self.programs = []
        self.installed = load_installed()
        self.current_filter = "Alle"

        self.build_ui()

        if not API_URL:
            messagebox.showerror(
                "API-Adresse fehlt",
                "Bitte trage die Render-URL in settings.json ein."
            )
        else:
            self.refresh()

    def build_ui(self):
        header = tk.Frame(
            self.root,
            bg=WINDOW_BG,
            padx=24,
            pady=18
        )

        header.pack(fill="x")

        tk.Label(
            header,
            text="CORE STORE",
            fg=TEXT,
            bg=WINDOW_BG,
            font=("Segoe UI", 22, "bold")
        ).pack(side="left")

        tk.Label(
            header,
            text="CORE NETWORK SOFTWARE CENTER",
            fg=MUTED,
            bg=WINDOW_BG,
            font=("Segoe UI", 9)
        ).pack(
            side="left",
            padx=16,
            pady=(10, 0)
        )

        self.search_var = tk.StringVar()

        search = tk.Entry(
            header,
            textvariable=self.search_var,
            width=30,
            bg=PANEL_BG,
            fg=TEXT,
            insertbackground=TEXT,
            relief="flat",
            font=("Segoe UI", 11)
        )

        search.pack(
            side="right",
            ipady=9,
            padx=(10, 0)
        )

        search.insert(0, "Programme suchen...")
        search.bind(
            "<KeyRelease>",
            lambda _event: self.render_cards()
        )

        nav = tk.Frame(
            self.root,
            bg=PANEL_BG,
            padx=20,
            pady=10
        )

        nav.pack(fill="x")

        for label, filter_name in [
            ("Startseite", "Alle"),
            ("Programme", "Alle"),
            ("Installiert", "Installiert")
        ]:
            tk.Button(
                nav,
                text=label,
                command=lambda value=filter_name: self.set_filter(value),
                bg=PANEL_BG,
                fg=TEXT,
                activebackground=CARD_BG,
                activeforeground=TEXT,
                relief="flat",
                padx=18,
                font=("Segoe UI", 10, "bold")
            ).pack(side="left")

        tk.Button(
            nav,
            text="Aktualisieren",
            command=self.refresh,
            bg=ACCENT,
            fg="#06202A",
            activebackground="#67e8f9",
            relief="flat",
            padx=16
        ).pack(side="right")

        self.status = tk.Label(
            self.root,
            text="Verbinde mit Core Store...",
            bg=WINDOW_BG,
            fg=MUTED,
            anchor="w",
            padx=26,
            pady=12
        )

        self.status.pack(fill="x")

        self.canvas = tk.Canvas(
            self.root,
            bg=WINDOW_BG,
            highlightthickness=0
        )

        scrollbar = ttk.Scrollbar(
            self.root,
            orient="vertical",
            command=self.canvas.yview
        )

        self.cards_frame = tk.Frame(
            self.canvas,
            bg=WINDOW_BG
        )

        self.cards_frame.bind(
            "<Configure>",
            lambda _event: self.canvas.configure(
                scrollregion=self.canvas.bbox("all")
            )
        )

        self.canvas_window = self.canvas.create_window(
            (0, 0),
            window=self.cards_frame,
            anchor="nw"
        )

        self.canvas.configure(
            yscrollcommand=scrollbar.set
        )

        self.canvas.bind(
            "<Configure>",
            lambda event: self.canvas.itemconfigure(
                self.canvas_window,
                width=event.width
            )
        )

        self.canvas.pack(
            side="left",
            fill="both",
            expand=True,
            padx=(20, 0),
            pady=(0, 20)
        )

        scrollbar.pack(
            side="right",
            fill="y",
            padx=(0, 16),
            pady=(0, 20)
        )

    def set_status(self, text, color=MUTED):
        self.status.config(
            text=text,
            fg=color
        )

    def set_filter(self, value):
        self.current_filter = value
        self.render_cards()

    def refresh(self):
        def worker():
            try:
                response = requests.get(
                    f"{API_URL}/api/programs",
                    timeout=30
                )

                response.raise_for_status()

                data = response.json()

                self.programs = data.get(
                    "programs",
                    []
                )

                self.root.after(
                    0,
                    self.render_cards
                )

                self.root.after(
                    0,
                    lambda: self.set_status(
                        f"{len(self.programs)} Programme verfügbar",
                        GREEN
                    )
                )

            except Exception as exc:
                self.root.after(
                    0,
                    lambda: self.set_status(
                        f"Verbindungsfehler: {exc}",
                        RED
                    )
                )

        threading.Thread(
            target=worker,
            daemon=True
        ).start()

    def is_installed(self, program):
        record = self.installed.get(
            program["id"]
        )

        if not record:
            return False

        path = Path(
            record.get("path", "")
        )

        return path.exists()

    def is_update_available(self, program):
        record = self.installed.get(
            program["id"]
        )

        if not record:
            return False

        return (
            record.get("version")
            != program.get("version")
        )

    def render_cards(self):
        for widget in self.cards_frame.winfo_children():
            widget.destroy()

        query = self.search_var.get().strip().lower()

        visible = []

        for program in self.programs:
            installed = self.is_installed(program)

            if (
                self.current_filter == "Installiert"
                and not installed
            ):
                continue

            haystack = " ".join([
                program.get("name", ""),
                program.get("short_description", ""),
                program.get("category", "")
            ]).lower()

            if (
                query
                and query != "programme suchen..."
                and query not in haystack
            ):
                continue

            visible.append(
                (program, installed)
            )

        for program, installed in visible:
            self.create_card(
                program,
                installed
            )

        if not visible:
            tk.Label(
                self.cards_frame,
                text="Keine passenden Programme gefunden.",
                bg=WINDOW_BG,
                fg=MUTED,
                font=("Segoe UI", 12)
            ).pack(pady=40)

    def create_card(self, program, installed):
        card = tk.Frame(
            self.cards_frame,
            bg=CARD_BG,
            padx=18,
            pady=16
        )

        card.pack(
            fill="x",
            padx=8,
            pady=8
        )

        left = tk.Frame(
            card,
            bg=CARD_BG
        )

        left.pack(
            side="left",
            fill="both",
            expand=True
        )

        tk.Label(
            left,
            text=program.get("name", program["id"]),
            bg=CARD_BG,
            fg=TEXT,
            font=("Segoe UI", 15, "bold")
        ).pack(anchor="w")

        tk.Label(
            left,
            text=(
                f'{program.get("category", "Sonstiges")} '
                f'· Version {program.get("version", "?")}'
            ),
            bg=CARD_BG,
            fg=MUTED,
            font=("Segoe UI", 9)
        ).pack(
            anchor="w",
            pady=(3, 8)
        )

        tk.Label(
            left,
            text=program.get("short_description", ""),
            bg=CARD_BG,
            fg=TEXT,
            wraplength=650,
            justify="left",
            font=("Segoe UI", 10)
        ).pack(anchor="w")

        right = tk.Frame(
            card,
            bg=CARD_BG
        )

        right.pack(
            side="right",
            padx=(12, 0)
        )

        self.button(
            right,
            "Details",
            lambda p=program: self.show_details(p),
            "#33465f"
        )

        if installed:
            if self.is_update_available(program):
                self.button(
                    right,
                    "Update",
                    lambda p=program: self.update_program(p),
                    GOLD,
                    "#202020"
                )

            self.button(
                right,
                "Starten",
                lambda p=program: self.start_program(p),
                ACCENT,
                "#06202A"
            )

            self.button(
                right,
                "Deinstallieren",
                lambda p=program: self.uninstall_program(p),
                "#56313b"
            )

        else:
            self.button(
                right,
                "Installieren",
                lambda p=program: self.install_program(p),
                GREEN,
                "#07130b"
            )

    def button(
        self,
        parent,
        text,
        command,
        background,
        foreground="white"
    ):
        tk.Button(
            parent,
            text=text,
            command=command,
            bg=background,
            fg=foreground,
            activebackground=background,
            relief="flat",
            padx=15,
            pady=8
        ).pack(
            pady=3,
            fill="x"
        )

    def show_details(self, program):
        win = tk.Toplevel(self.root)

        win.title(
            program.get("name", "Programm")
        )

        win.geometry("620x470")
        win.configure(bg=WINDOW_BG)

        tk.Label(
            win,
            text=program.get("name", ""),
            bg=WINDOW_BG,
            fg=TEXT,
            font=("Segoe UI", 22, "bold")
        ).pack(
            anchor="w",
            padx=24,
            pady=(24, 6)
        )

        tk.Label(
            win,
            text=(
                f'{program.get("category", "Sonstiges")} '
                f'· Version {program.get("version", "?")}'
            ),
            bg=WINDOW_BG,
            fg=MUTED
        ).pack(
            anchor="w",
            padx=24
        )

        body = tk.Text(
            win,
            bg=PANEL_BG,
            fg=TEXT,
            insertbackground=TEXT,
            relief="flat",
            wrap="word",
            font=("Segoe UI", 11)
        )

        body.pack(
            fill="both",
            expand=True,
            padx=24,
            pady=20
        )

        body.insert(
            "1.0",
            program.get(
                "description",
                program.get("short_description", "")
            )
        )

        body.config(state="disabled")

    def install_program(self, program):
        if not messagebox.askyesno(
            "Installieren",
            f'{program["name"]} installieren?'
        ):
            return

        self.set_status(
            f'{program["name"]} wird installiert...',
            ACCENT
        )

        def worker():
            destination = None

            try:
                LOCAL_ROOT.mkdir(
                    parents=True,
                    exist_ok=True
                )

                destination = safe_child(
                    LOCAL_ROOT,
                    program["folder"]
                )

                if destination.exists():
                    raise ValueError(
                        "Der Zielordner existiert bereits, "
                        "ist aber nicht als Store-Installation registriert."
                    )

                with tempfile.TemporaryDirectory() as temp:
                    temp = Path(temp)

                    zip_path = temp / "program.zip"
                    staging = temp / "extracted"

                    download_program(
                        program["id"],
                        zip_path
                    )

                    staging.mkdir()

                    extract_safely(
                        zip_path,
                        staging
                    )

                    if not any(staging.iterdir()):
                        raise ValueError(
                            "Das heruntergeladene Programm ist leer."
                        )

                    shutil.move(
                        str(staging),
                        str(destination)
                    )

                post_file = program.get(
                    "post_install_file"
                )

                if post_file:
                    result = launch_file(
                        destination,
                        post_file,
                        wait=True
                    )

                    if result and result.returncode != 0:
                        raise RuntimeError(
                            "post_install_file wurde mit "
                            f"Exit-Code {result.returncode} beendet."
                        )

                self.installed[program["id"]] = {
                    "path": str(destination),
                    "version": program.get("version", "1.0.0"),
                    "folder": program["folder"]
                }

                save_installed(self.installed)

                self.root.after(
                    0,
                    lambda: self.set_status(
                        f'{program["name"]} wurde installiert.',
                        GREEN
                    )
                )

                self.root.after(
                    0,
                    self.render_cards
                )

            except Exception as exc:
                self.root.after(
                    0,
                    lambda: self.set_status(
                        f"Installationsfehler: {exc}",
                        RED
                    )
                )

                self.root.after(
                    0,
                    lambda: messagebox.showerror(
                        "Installationsfehler",
                        str(exc)
                    )
                )

        threading.Thread(
            target=worker,
            daemon=True
        ).start()

    def update_program(self, program):
        if not messagebox.askyesno(
            "Programm aktualisieren",
            (
                f'{program["name"]} aktualisieren?\n\n'
                "Die in update_preserve angegebenen Dateien "
                "und Ordner bleiben erhalten."
            )
        ):
            return

        self.set_status(
            f'{program["name"]} wird aktualisiert...',
            ACCENT
        )

        def worker():
            try:
                old_dir = safe_child(
                    LOCAL_ROOT,
                    program["folder"]
                )

                if not old_dir.exists():
                    raise FileNotFoundError(
                        "Die bisherige Installation wurde nicht gefunden."
                    )

                with tempfile.TemporaryDirectory() as temp:
                    temp = Path(temp)

                    zip_path = temp / "program.zip"
                    staging = temp / "staging"

                    staging.mkdir()

                    download_program(
                        program["id"],
                        zip_path
                    )

                    extract_safely(
                        zip_path,
                        staging
                    )

                    preserve = program.get(
                        "update_preserve",
                        []
                    )

                    for entry in preserve:
                        relative = safe_relative_path(entry)

                        old_item = old_dir / relative
                        new_item = staging / relative

                        if old_item.is_dir():
                            if new_item.exists():
                                if new_item.is_dir():
                                    shutil.rmtree(new_item)
                                else:
                                    new_item.unlink()

                            shutil.copytree(
                                old_item,
                                new_item
                            )

                        elif old_item.is_file():
                            new_item.parent.mkdir(
                                parents=True,
                                exist_ok=True
                            )

                            shutil.copy2(
                                old_item,
                                new_item
                            )

                    backup = LOCAL_ROOT / (
                        "_backup_" + program["id"]
                    )

                    if backup.exists():
                        shutil.rmtree(backup)

                    old_dir.rename(backup)

                    try:
                        staging.rename(old_dir)

                        self.installed[program["id"]] = {
                            "path": str(old_dir),
                            "version": program.get("version", "1.0.0"),
                            "folder": program["folder"]
                        }

                        save_installed(self.installed)

                    except Exception:
                        if old_dir.exists():
                            shutil.rmtree(old_dir)

                        backup.rename(old_dir)
                        raise

                    if backup.exists():
                        shutil.rmtree(backup)

                self.root.after(
                    0,
                    lambda: self.set_status(
                        f'{program["name"]} wurde aktualisiert.',
                        GREEN
                    )
                )

                self.root.after(
                    0,
                    self.render_cards
                )

            except Exception as exc:
                self.root.after(
                    0,
                    lambda: self.set_status(
                        f"Update fehlgeschlagen: {exc}",
                        RED
                    )
                )

                self.root.after(
                    0,
                    lambda: messagebox.showerror(
                        "Update fehlgeschlagen",
                        str(exc)
                    )
                )

        threading.Thread(
            target=worker,
            daemon=True
        ).start()

    def start_program(self, program):
        try:
            directory = safe_child(
                LOCAL_ROOT,
                program["folder"]
            )

            if not directory.exists():
                raise FileNotFoundError(
                    "Der lokale Programmordner wurde nicht gefunden."
                )

            launch_file(
                directory,
                program.get("start_file")
            )

        except Exception as exc:
            messagebox.showerror(
                "Startfehler",
                str(exc)
            )

    def uninstall_program(self, program):
        if not messagebox.askyesno(
            "Deinstallieren",
            (
                f'{program["name"]} und alle Dateien im '
                "zugehörigen Programmordner löschen?\n\n"
                "Es wird keine Datei ausgeführt."
            )
        ):
            return

        try:
            destination = safe_child(
                LOCAL_ROOT,
                program["folder"]
            )

            if destination.exists():
                shutil.rmtree(destination)

            self.installed.pop(
                program["id"],
                None
            )

            save_installed(self.installed)

            self.set_status(
                f'{program["name"]} wurde deinstalliert.',
                GREEN
            )

            self.render_cards()

        except Exception as exc:
            messagebox.showerror(
                "Deinstallationsfehler",
                str(exc)
            )


def main():
    STORE_DATA.mkdir(
        parents=True,
        exist_ok=True
    )

    root = tk.Tk()

    CoreStore(root)

    root.mainloop()


if __name__ == "__main__":
    main()
