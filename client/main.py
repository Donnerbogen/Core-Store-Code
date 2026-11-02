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


# ============================================================
# CORE NETWORK STORE - GRUNDEINSTELLUNGEN
# ============================================================

APP_NAME = "Core Network Store"

LOCAL_ROOT = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home())))
    / "Core Network"
)

STORE_DATA = LOCAL_ROOT / "_store"
INSTALLED_FILE = STORE_DATA / "installed.json"

SETTINGS_FILE = Path(__file__).with_name("settings.json")


# ============================================================
# CORE NETWORK DESIGN
# ============================================================

BG = "#080F1C"
SIDEBAR = "#0B1424"
PANEL = "#111F33"
CARD = "#14243A"
CARD_HOVER = "#1A304B"

TEXT = "#F4F8FF"
MUTED = "#91A5BE"

CYAN = "#22D3EE"
CYAN_DARK = "#0E7490"

GREEN = "#34D399"
RED = "#FB7185"
GOLD = "#FBBF24"


# ============================================================
# DATEIEN UND EINSTELLUNGEN
# ============================================================

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

        if isinstance(data, dict):
            return data

    except Exception:
        pass

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
    if not isinstance(name, str):
        raise ValueError("Ungültiger Ordnername.")

    if (
        not name
        or name in (".", "..")
        or "/" in name
        or "\\" in name
        or ":" in name
    ):
        raise ValueError("Unsicherer Ordnername.")

    root = root.resolve()
    destination = (root / name).resolve()

    if destination.parent != root:
        raise ValueError("Ungültiger Zielpfad.")

    return destination


def safe_relative_path(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Ungültiger relativer Pfad.")

    value = value.replace("\\", "/")

    if value.startswith("/") or ":" in value:
        raise ValueError("Absolute Pfade sind nicht erlaubt.")

    parts = value.split("/")

    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("Unsicherer relativer Pfad.")

    return Path(*parts)


def extract_safely(zip_path, destination):
    destination = destination.resolve()

    with zipfile.ZipFile(zip_path, "r") as archive:
        for info in archive.infolist():
            relative = safe_relative_path(info.filename)

            target = (destination / relative).resolve()

            if (
                target != destination
                and destination not in target.parents
            ):
                raise ValueError(
                    "Das ZIP enthält einen unsicheren Pfad."
                )

            # Keine symbolischen Links aus Archiven übernehmen.
            unix_mode = info.external_attr >> 16

            if unix_mode & 0o170000 == 0o120000:
                raise ValueError(
                    "Symbolische Links sind nicht erlaubt."
                )

            if info.is_dir():
                target.mkdir(
                    parents=True,
                    exist_ok=True
                )
                continue

            target.parent.mkdir(
                parents=True,
                exist_ok=True
            )

            with archive.open(info) as source:
                with target.open("wb") as output:
                    shutil.copyfileobj(source, output)


def launch_file(directory, relative_file, wait=False):
    if not relative_file:
        raise ValueError(
            "Für dieses Programm ist keine start_file festgelegt."
        )

    relative = safe_relative_path(relative_file)

    directory = directory.resolve()
    target = (directory / relative).resolve()

    if directory not in target.parents:
        raise ValueError("Ungültiger Startpfad.")

    if not target.is_file():
        raise FileNotFoundError(
            f"Startdatei nicht gefunden: {relative_file}"
        )

    extension = target.suffix.lower()

    if extension == ".py":
        command = [sys.executable, str(target)]

    elif extension in (".bat", ".cmd"):
        command = [
            os.environ.get("COMSPEC", "cmd.exe"),
            "/c",
            str(target)
        ]

    elif extension == ".exe":
        command = [str(target)]

    elif extension in (".html", ".htm"):
        os.startfile(str(target))
        return None

    else:
        raise ValueError(
            f"Dateityp wird nicht unterstützt: {extension}"
        )

    if wait:
        return subprocess.run(
            command,
            cwd=str(directory),
            check=False
        )

    subprocess.Popen(
        command,
        cwd=str(directory)
    )

    return None


def download_program(api_url, program_id, destination):
    url = (
        f"{api_url}/api/programs/"
        f"{program_id}/download"
    )

    response = requests.get(
        url,
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

    with destination.open("wb") as output:
        for chunk in response.iter_content(
            chunk_size=256 * 1024
        ):
            if chunk:
                output.write(chunk)


# ============================================================
# CORE STORE FENSTER
# ============================================================

class CoreStore:

    def __init__(self, root):
        self.root = root

        self.root.title(APP_NAME)
        self.root.geometry("1280x820")
        self.root.minsize(980, 660)
        self.root.configure(bg=BG)

        self.api_url = load_settings()

        self.programs = []
        self.installed = load_installed()

        self.current_filter = "Alle"
        self.nav_buttons = {}

        self.search_var = tk.StringVar()

        self.build_ui()

        if not self.api_url:
            messagebox.showerror(
                "API-Adresse fehlt",
                "Trage zuerst die Render-Adresse in "
                "client/settings.json ein."
            )
        else:
            self.refresh()


    # ========================================================
    # DESIGN-HILFSFUNKTIONEN
    # ========================================================

    def make_button(
        self,
        parent,
        text,
        command,
        kind="secondary"
    ):
        styles = {
            "primary": (
                CYAN,
                "#06202A",
                "#67E8F9"
            ),
            "success": (
                GREEN,
                "#06251C",
                "#6EE7B7"
            ),
            "danger": (
                "#482435",
                "#FFE8EF",
                "#633047"
            ),
            "secondary": (
                "#20344E",
                TEXT,
                "#2B4565"
            ),
            "ghost": (
                SIDEBAR,
                MUTED,
                "#172A43"
            )
        }

        bg, fg, active = styles[kind]

        return tk.Button(
            parent,
            text=text,
            command=command,
            bg=bg,
            fg=fg,
            activebackground=active,
            activeforeground=fg,
            relief="flat",
            bd=0,
            padx=15,
            pady=9,
            cursor="hand2",
            font=("Segoe UI", 9, "bold")
        )


    # ========================================================
    # OBERFLÄCHE
    # ========================================================

    def build_ui(self):

        shell = tk.Frame(
            self.root,
            bg=BG
        )
        shell.pack(
            fill="both",
            expand=True
        )

        # Linke Navigation

        sidebar = tk.Frame(
            shell,
            bg=SIDEBAR,
            width=218
        )

        sidebar.pack(
            side="left",
            fill="y"
        )

        sidebar.pack_propagate(False)

        brand = tk.Frame(
            sidebar,
            bg=SIDEBAR,
            padx=20,
            pady=23
        )
        brand.pack(fill="x")

        logo = tk.Canvas(
            brand,
            width=42,
            height=42,
            bg=SIDEBAR,
            highlightthickness=0
        )
        logo.pack(side="left")

        logo.create_oval(
            3, 3, 39, 39,
            outline=CYAN,
            width=2
        )

        logo.create_text(
            21, 21,
            text="C",
            fill=TEXT,
            font=("Segoe UI", 19, "bold")
        )

        brand_text = tk.Frame(
            brand,
            bg=SIDEBAR
        )
        brand_text.pack(
            side="left",
            padx=10
        )

        tk.Label(
            brand_text,
            text="CORE",
            bg=SIDEBAR,
            fg=TEXT,
            font=("Segoe UI", 15, "bold")
        ).pack(anchor="w")

        tk.Label(
            brand_text,
            text="NETWORK",
            bg=SIDEBAR,
            fg=CYAN,
            font=("Segoe UI", 8, "bold")
        ).pack(anchor="w")

        tk.Label(
            sidebar,
            text="WORKSPACE",
            bg=SIDEBAR,
            fg="#60758F",
            font=("Segoe UI", 8, "bold")
        ).pack(
            anchor="w",
            padx=22,
            pady=(24, 9)
        )

        navigation = [
            ("Startseite", "⌂", "Alle"),
            ("Programme", "▦", "Alle"),
            ("Installiert", "↓", "Installiert")
        ]

        for label, icon, filter_name in navigation:

            button = tk.Button(
                sidebar,
                text=f"  {icon}     {label}",
                anchor="w",
                command=lambda f=filter_name, n=label:
                    self.set_filter(f, n),
                bg="#102239" if label == "Startseite" else SIDEBAR,
                fg=TEXT if label == "Startseite" else MUTED,
                activebackground="#17324E",
                activeforeground=TEXT,
                relief="flat",
                bd=0,
                padx=18,
                pady=13,
                font=("Segoe UI", 10, "bold"),
                cursor="hand2"
            )

            button.pack(
                fill="x",
                padx=12,
                pady=3
            )

            self.nav_buttons[label] = button

        bottom = tk.Frame(
            sidebar,
            bg=SIDEBAR,
            padx=18,
            pady=18
        )
        bottom.pack(
            side="bottom",
            fill="x"
        )

        tk.Frame(
            bottom,
            bg="#1E354F",
            height=1
        ).pack(
            fill="x",
            pady=(0, 14)
        )

        tk.Label(
            bottom,
            text="CORE NETWORK",
            bg=SIDEBAR,
            fg="#6D849F",
            font=("Segoe UI", 8, "bold")
        ).pack(anchor="w")

        tk.Label(
            bottom,
            text="Software Center  •  Desktop",
            bg=SIDEBAR,
            fg="#6D849F",
            font=("Segoe UI", 8)
        ).pack(
            anchor="w",
            pady=(4, 0)
        )

        # Hauptbereich

        self.workspace = tk.Frame(
            shell,
            bg=BG
        )

        self.workspace.pack(
            side="left",
            fill="both",
            expand=True
        )

        header = tk.Frame(
            self.workspace,
            bg=BG,
            padx=30,
            pady=20
        )
        header.pack(fill="x")

        title_box = tk.Frame(
            header,
            bg=BG
        )
        title_box.pack(side="left")

        tk.Label(
            title_box,
            text="Software Center",
            bg=BG,
            fg=TEXT,
            font=("Segoe UI", 19, "bold")
        ).pack(anchor="w")

        tk.Label(
            title_box,
            text="Entdecke und verwalte deine Core-Programme",
            bg=BG,
            fg=MUTED,
            font=("Segoe UI", 9)
        ).pack(
            anchor="w",
            pady=(3, 0)
        )

        controls = tk.Frame(
            header,
            bg=BG
        )
        controls.pack(side="right")

        search_wrap = tk.Frame(
            controls,
            bg=PANEL,
            padx=12,
            pady=2,
            highlightthickness=1,
            highlightbackground="#263D58"
        )
        search_wrap.pack(
            side="left",
            padx=(0, 10)
        )

        tk.Label(
            search_wrap,
            text="⌕",
            bg=PANEL,
            fg=CYAN,
            font=("Segoe UI", 16)
        ).pack(side="left", padx=(0, 6))

        search = tk.Entry(
            search_wrap,
            textvariable=self.search_var,
            width=25,
            bg=PANEL,
            fg=TEXT,
            insertbackground=TEXT,
            relief="flat",
            font=("Segoe UI", 10)
        )
        search.pack(
            side="left",
            ipady=9
        )

        search.insert(
            0,
            "Programme suchen..."
        )

        search.bind(
            "<FocusIn>",
            lambda _e:
                search.delete(0, "end")
                if search.get() == "Programme suchen..."
                else None
        )

        search.bind(
            "<KeyRelease>",
            lambda _e: self.render_cards()
        )

        self.make_button(
            controls,
            "↻  Aktualisieren",
            self.refresh,
            "secondary"
        ).pack(side="left")

        # Banner

        hero = tk.Frame(
            self.workspace,
            bg="#102A43",
            padx=28,
            pady=24,
            highlightthickness=1,
            highlightbackground="#1D4964"
        )

        hero.pack(
            fill="x",
            padx=30,
            pady=(2, 18)
        )

        hero_left = tk.Frame(
            hero,
            bg="#102A43"
        )
        hero_left.pack(
            side="left",
            fill="both",
            expand=True
        )

        tk.Label(
            hero_left,
            text="CORE NETWORK  /  SOFTWARE HUB",
            bg="#102A43",
            fg=CYAN,
            font=("Segoe UI", 8, "bold")
        ).pack(anchor="w")

        tk.Label(
            hero_left,
            text="Alles für dein digitales Ökosystem.",
            bg="#102A43",
            fg=TEXT,
            font=("Segoe UI", 20, "bold")
        ).pack(
            anchor="w",
            pady=(8, 5)
        )

        tk.Label(
            hero_left,
            text="Installiere, starte und verwalte deine Programme zentral an einem Ort.",
            bg="#102A43",
            fg="#B5C8DC",
            font=("Segoe UI", 9)
        ).pack(anchor="w")

        hero_right = tk.Frame(
            hero,
            bg="#102A43"
        )
        hero_right.pack(
            side="right",
            padx=(20, 5)
        )

        tk.Label(
            hero_right,
            text="C",
            bg="#102A43",
            fg="#1B536A",
            font=("Segoe UI", 64, "bold")
        ).pack()

        tk.Label(
            hero_right,
            text="CONNECTED  •  CORE",
            bg="#102A43",
            fg=CYAN,
            font=("Segoe UI", 7, "bold")
        ).pack()

        # Programmbereich

        section = tk.Frame(
            self.workspace,
            bg=BG,
            padx=30
        )
        section.pack(fill="x")

        tk.Label(
            section,
            text="PROGRAMM-BIBLIOTHEK",
            bg=BG,
            fg=TEXT,
            font=("Segoe UI", 11, "bold")
        ).pack(side="left")

        self.count_label = tk.Label(
            section,
            text="Wird geladen...",
            bg=BG,
            fg=MUTED,
            font=("Segoe UI", 8)
        )
        self.count_label.pack(side="right")

        self.status = tk.Label(
            self.workspace,
            text="Verbinde mit Core Store...",
            bg=BG,
            fg=MUTED,
            anchor="w",
            padx=30,
            pady=10,
            font=("Segoe UI", 8)
        )
        self.status.pack(fill="x")

        list_area = tk.Frame(
            self.workspace,
            bg=BG
        )

        list_area.pack(
            fill="both",
            expand=True,
            padx=(22, 12),
            pady=(0, 18)
        )

        self.canvas = tk.Canvas(
            list_area,
            bg=BG,
            highlightthickness=0
        )

        scrollbar = ttk.Scrollbar(
            list_area,
            orient="vertical",
            command=self.canvas.yview
        )

        self.cards_frame = tk.Frame(
            self.canvas,
            bg=BG
        )

        self.cards_frame.bind(
            "<Configure>",
            lambda _e:
                self.canvas.configure(
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
            lambda event:
                self.canvas.itemconfigure(
                    self.canvas_window,
                    width=event.width
                )
        )

        self.canvas.pack(
            side="left",
            fill="both",
            expand=True
        )

        scrollbar.pack(
            side="right",
            fill="y",
            padx=(8, 0)
        )


    # ========================================================
    # NAVIGATION UND STATUS
    # ========================================================

    def set_filter(self, value, nav_name=None):
        self.current_filter = value

        if nav_name:
            for name, button in self.nav_buttons.items():
                selected = name == nav_name

                button.configure(
                    bg="#102239" if selected else SIDEBAR,
                    fg=TEXT if selected else MUTED
                )

        self.render_cards()


    def set_status(self, text, color=MUTED):
        self.status.config(
            text=text,
            fg=color
        )


    def is_installed(self, program):
        record = self.installed.get(program["id"])

        if not record:
            return False

        try:
            expected = safe_child(
                LOCAL_ROOT,
                program["folder"]
            )

            actual = Path(
                record.get("path", "")
            ).resolve()

            return (
                expected.exists()
                and actual == expected
            )

        except Exception:
            return False


    def update_available(self, program):
        record = self.installed.get(program["id"])

        if not record:
            return False

        installed_version = str(
            record.get("version", "")
        )

        remote_version = str(
            program.get("version", "")
        )

        return installed_version != remote_version


    # ========================================================
    # PROGRAMMLISTE AKTUALISIEREN
    # ========================================================

    def refresh(self):
        if not self.api_url:
            return

        self.set_status(
            "Verbinde mit Core Network...",
            CYAN
        )

        def worker():
            try:
                response = requests.get(
                    f"{self.api_url}/api/programs",
                    timeout=40
                )

                response.raise_for_status()

                data = response.json()

                programs = data.get(
                    "programs",
                    []
                )

                self.programs = programs

                self.root.after(
                    0,
                    self.render_cards
                )

                self.root.after(
                    0,
                    lambda: self.set_status(
                        f"{len(programs)} Programme verfügbar",
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


    # ========================================================
    # PROGRAMMKARTEN
    # ========================================================

    def render_cards(self):
        for widget in self.cards_frame.winfo_children():
            widget.destroy()

        query = self.search_var.get().strip().lower()

        if query == "programme suchen...":
            query = ""

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

            if query and query not in haystack:
                continue

            visible.append(
                (program, installed)
            )

        self.count_label.config(
            text=f"{len(visible)} PROGRAMME"
        )

        if not visible:
            empty = tk.Frame(
                self.cards_frame,
                bg=PANEL,
                padx=28,
                pady=32
            )

            empty.pack(
                fill="x",
                padx=8,
                pady=12
            )

            tk.Label(
                empty,
                text="◇",
                bg=PANEL,
                fg=CYAN,
                font=("Segoe UI", 28)
            ).pack()

            tk.Label(
                empty,
                text="Keine Programme gefunden",
                bg=PANEL,
                fg=TEXT,
                font=("Segoe UI", 13, "bold")
            ).pack(pady=(8, 4))

            tk.Label(
                empty,
                text="Passe deine Suche an oder aktualisiere die Programmliste.",
                bg=PANEL,
                fg=MUTED,
                font=("Segoe UI", 9)
            ).pack()

            return

        for program, installed in visible:
            card = tk.Frame(
                self.cards_frame,
                bg=CARD,
                padx=18,
                pady=15,
                highlightthickness=1,
                highlightbackground="#203852"
            )

            card.pack(
                fill="x",
                padx=8,
                pady=7
            )

            icon = tk.Canvas(
                card,
                width=58,
                height=58,
                bg=CARD,
                highlightthickness=0
            )

            icon.pack(
                side="left",
                padx=(0, 16)
            )

            icon.create_oval(
                3, 3, 55, 55,
                fill="#1A3B55",
                outline="#28617A",
                width=1
            )

            icon.create_text(
                29, 29,
                text=program.get("name", "C")[:1].upper(),
                fill=CYAN,
                font=("Segoe UI", 22, "bold")
            )

            left = tk.Frame(
                card,
                bg=CARD
            )

            left.pack(
                side="left",
                fill="both",
                expand=True
            )

            top = tk.Frame(
                left,
                bg=CARD
            )
            top.pack(fill="x")

            tk.Label(
                top,
                text=program.get("name", program["id"]),
                bg=CARD,
                fg=TEXT,
                font=("Segoe UI", 12, "bold")
            ).pack(side="left")

            if installed:
                tk.Label(
                    top,
                    text=" INSTALLED ",
                    bg="#123B35",
                    fg=GREEN,
                    font=("Segoe UI", 7, "bold"),
                    padx=7,
                    pady=3
                ).pack(
                    side="left",
                    padx=10
                )

            if installed and self.update_available(program):
                tk.Label(
                    top,
                    text=" UPDATE AVAILABLE ",
                    bg="#493817",
                    fg=GOLD,
                    font=("Segoe UI", 7, "bold"),
                    padx=7,
                    pady=3
                ).pack(side="left")

            tk.Label(
                left,
                text=(
                    f'{program.get("category", "Sonstiges").upper()}'
                    f'   •   VERSION {program.get("version", "?")}'
                ),
                bg=CARD,
                fg=CYAN,
                font=("Segoe UI", 7, "bold")
            ).pack(
                anchor="w",
                pady=(5, 6)
            )

            tk.Label(
                left,
                text=program.get("short_description", ""),
                bg=CARD,
                fg=MUTED,
                wraplength=570,
                justify="left",
                font=("Segoe UI", 9)
            ).pack(anchor="w")

            right = tk.Frame(
                card,
                bg=CARD
            )

            right.pack(
                side="right",
                padx=(14, 0)
            )

            self.make_button(
                right,
                "Details",
                lambda p=program: self.show_details(p),
                "secondary"
            ).pack(
                fill="x",
                pady=3
            )

            if installed:
                self.make_button(
                    right,
                    "▶  Starten",
                    lambda p=program: self.start_program(p),
                    "primary"
                ).pack(
                    fill="x",
                    pady=3
                )

                if self.update_available(program):
                    self.make_button(
                        right,
                        "↻  Update",
                        lambda p=program: self.update_program(p),
                        "success"
                    ).pack(
                        fill="x",
                        pady=3
                    )

                self.make_button(
                    right,
                    "Deinstallieren",
                    lambda p=program: self.uninstall_program(p),
                    "danger"
                ).pack(
                    fill="x",
                    pady=3
                )

            else:
                self.make_button(
                    right,
                    "＋  Installieren",
                    lambda p=program: self.install_program(p),
                    "success"
                ).pack(
                    fill="x",
                    pady=3
                )


    # ========================================================
    # DETAILFENSTER
    # ========================================================

    def show_details(self, program):
        win = tk.Toplevel(self.root)

        win.title(
            f'Core Network · {program.get("name", "Programm")}'
        )

        win.geometry("700x540")
        win.minsize(560, 440)
        win.configure(bg=BG)

        banner = tk.Frame(
            win,
            bg="#102A43",
            padx=26,
            pady=22
        )

        banner.pack(fill="x")

        tk.Label(
            banner,
            text="CORE NETWORK  /  PROGRAM DETAILS",
            bg="#102A43",
            fg=CYAN,
            font=("Segoe UI", 8, "bold")
        ).pack(anchor="w")

        tk.Label(
            banner,
            text=program.get("name", ""),
            bg="#102A43",
            fg=TEXT,
            font=("Segoe UI", 22, "bold")
        ).pack(
            anchor="w",
            pady=(8, 4)
        )

        tk.Label(
            banner,
            text=(
                f'{program.get("category", "Sonstiges")}'
                f'  •  Version {program.get("version", "?")}'
            ),
            bg="#102A43",
            fg="#B5C8DC",
            font=("Segoe UI", 9)
        ).pack(anchor="w")

        content = tk.Frame(
            win,
            bg=BG,
            padx=26,
            pady=22
        )

        content.pack(
            fill="both",
            expand=True
        )

        tk.Label(
            content,
            text="ÜBER DIESES PROGRAMM",
            bg=BG,
            fg=CYAN,
            font=("Segoe UI", 8, "bold")
        ).pack(
            anchor="w",
            pady=(0, 8)
        )

        body = tk.Text(
            content,
            bg=PANEL,
            fg=TEXT,
            insertbackground=TEXT,
            relief="flat",
            wrap="word",
            font=("Segoe UI", 10),
            padx=16,
            pady=14,
            height=12
        )

        body.pack(
            fill="both",
            expand=True
        )

        body.insert(
            "1.0",
            program.get(
                "description",
                program.get("short_description", "")
            )
        )

        body.config(state="disabled")

        actions = tk.Frame(
            content,
            bg=BG
        )

        actions.pack(
            fill="x",
            pady=(18, 0)
        )

        installed = self.is_installed(program)

        if installed:
            self.make_button(
                actions,
                "▶  Starten",
                lambda: self.start_program(program),
                "primary"
            ).pack(
                side="left",
                padx=(0, 8)
            )

            if self.update_available(program):
                self.make_button(
                    actions,
                    "↻  Update",
                    lambda: self.update_program(program),
                    "success"
                ).pack(
                    side="left",
                    padx=(0, 8)
                )

            self.make_button(
                actions,
                "Deinstallieren",
                lambda: self.uninstall_program(program),
                "danger"
            ).pack(side="left")

        else:
            self.make_button(
                actions,
                "＋  Installieren",
                lambda: self.install_program(program),
                "success"
            ).pack(side="left")

        self.make_button(
            actions,
            "Schließen",
            win.destroy,
            "ghost"
        ).pack(side="right")


    # ========================================================
    # PROGRAMM INSTALLIEREN
    # ========================================================

    def install_program(self, program):
        if not messagebox.askyesno(
            "Installieren",
            f'{program["name"]} installieren?'
        ):
            return

        self.set_status(
            f'{program["name"]} wird installiert...',
            CYAN
        )

        def worker():
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

                    staging.mkdir()

                    download_program(
                        self.api_url,
                        program["id"],
                        zip_path
                    )

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

                # Nur bei einer Neuinstallation ausführen.
                post_file = program.get("post_install_file")

                if post_file:
                    result = launch_file(
                        destination,
                        post_file,
                        wait=True
                    )

                    if (
                        result is not None
                        and result.returncode != 0
                    ):
                        raise RuntimeError(
                            "post_install_file wurde nicht erfolgreich beendet."
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


    # ========================================================
    # PROGRAMM UPDATE
    # ========================================================

    def update_program(self, program):
        if not self.is_installed(program):
            messagebox.showerror(
                "Update nicht möglich",
                "Das Programm ist nicht korrekt installiert."
            )
            return

        record = self.installed[program["id"]]

        old_version = record.get(
            "version",
            "unbekannt"
        )

        new_version = program.get(
            "version",
            "unbekannt"
        )

        preserve = program.get(
            "update_preserve",
            []
        )

        if not messagebox.askyesno(
            "Programm aktualisieren",
            (
                f'{program["name"]} aktualisieren?\n\n'
                f'Installiert: {old_version}\n'
                f'Verfügbar: {new_version}\n\n'
                "Der alte Programmcode wird ersetzt.\n"
                "Die festgelegten Dateien und Ordner bleiben erhalten.\n\n"
                "Während des Updates wird keine Programmdatei ausgeführt."
            )
        ):
            return

        self.set_status(
            f'{program["name"]} wird aktualisiert...',
            CYAN
        )

        def worker():
            destination = safe_child(
                LOCAL_ROOT,
                program["folder"]
            )

            backup = None

            try:
                with tempfile.TemporaryDirectory() as temp_name:
                    temp = Path(temp_name)

                    zip_path = temp / "program.zip"
                    staging = temp / "new_program"

                    staging.mkdir()

                    # Neue Version herunterladen.
                    download_program(
                        self.api_url,
                        program["id"],
                        zip_path
                    )

                    extract_safely(
                        zip_path,
                        staging
                    )

                    if not any(staging.iterdir()):
                        raise ValueError(
                            "Die neue Programmversion ist leer."
                        )

                    # Alte Dateien aus update_preserve übernehmen.
                    for entry in preserve:
                        relative = safe_relative_path(entry)

                        old_item = (
                            destination / relative
                        ).resolve()

                        new_item = (
                            staging / relative
                        ).resolve()

                        if (
                            destination.resolve() not in old_item.parents
                            or staging.resolve() not in new_item.parents
                        ):
                            raise ValueError(
                                f"Unsicherer Update-Pfad: {entry}"
                            )

                        if not old_item.exists():
                            continue

                        if old_item.is_dir():
                            if new_item.exists():
                                if new_item.is_dir():
                                    shutil.rmtree(new_item)
                                else:
                                    new_item.unlink()

                            new_item.parent.mkdir(
                                parents=True,
                                exist_ok=True
                            )

                            shutil.copytree(
                                old_item,
                                new_item
                            )

                        elif old_item.is_file():
                            if new_item.exists() and new_item.is_dir():
                                shutil.rmtree(new_item)

                            new_item.parent.mkdir(
                                parents=True,
                                exist_ok=True
                            )

                            shutil.copy2(
                                old_item,
                                new_item
                            )

                    # Altes Programm sichern.
                    backup = LOCAL_ROOT / (
                        f"_backup_{program['id']}"
                    )

                    if backup.exists():
                        shutil.rmtree(backup)

                    destination.rename(backup)

                    try:
                        staging.rename(destination)

                    except Exception:
                        if destination.exists():
                            shutil.rmtree(destination)

                        backup.rename(destination)
                        backup = None
                        raise

                # Neue Version registrieren.
                self.installed[program["id"]] = {
                    "path": str(destination),
                    "version": new_version,
                    "folder": program["folder"]
                }

                save_installed(self.installed)

                # Backup erst nach erfolgreicher Registrierung löschen.
                if backup and backup.exists():
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
                # Falls etwas schiefgeht, wenn möglich zurückrollen.
                try:
                    if backup and backup.exists():
                        if destination.exists():
                            shutil.rmtree(destination)

                        backup.rename(destination)

                except Exception:
                    pass

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


    # ========================================================
    # PROGRAMM STARTEN
    # ========================================================

    def start_program(self, program):
        if not self.is_installed(program):
            messagebox.showerror(
                "Nicht installiert",
                "Dieses Programm ist nicht installiert."
            )
            return

        try:
            directory = safe_child(
                LOCAL_ROOT,
                program["folder"]
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


    # ========================================================
    # PROGRAMM DEINSTALLIEREN
    # ========================================================

    def uninstall_program(self, program):
        if not self.is_installed(program):
            messagebox.showerror(
                "Nicht installiert",
                "Das Programm ist nicht korrekt installiert."
            )
            return

        if not messagebox.askyesno(
            "Deinstallieren",
            (
                f'{program["name"]} und alle Dateien '
                "im zugehörigen Programmordner löschen?\n\n"
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


# ============================================================
# START
# ============================================================

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
