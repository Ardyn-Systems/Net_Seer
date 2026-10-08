# PyInstaller spec for the headless NetSeer server sidecar used by the Electron shell.
#   pyinstaller packaging/electron/netseer-server.spec --noconfirm --clean
# Produces dist/netseer-server/netseer-server[.exe]; electron-builder bundles it under resources/.
# Cross-platform (Linux and Windows); no pywebview — the Electron window is the UI.

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parents[1]
PACKAGE = ROOT / "src" / "netseer"

# The web UI, bundled samples, and vulnerability DB live inside the netseer package.
datas = [
    (str(path), str(path.parent.relative_to(PACKAGE.parent)))
    for folder in ("web", "data")
    for path in (PACKAGE / folder).rglob("*")
    if path.is_file() and "__pycache__" not in path.parts
]
datas += collect_data_files("reportlab")

# scapy and uvicorn import most of their modules by name at runtime.
hiddenimports = [
    *collect_submodules("scapy.layers"),
    *collect_submodules("scapy.arch"),
    *collect_submodules("scapy.libs"),
    *collect_submodules("uvicorn"),
    "scapy.all",
    "python_multipart",
    "multipart",
    # uvicorn loads the app by the string "netseer.web:app", so PyInstaller can't see it from the
    # import graph. Force it in, or the bundled web/ asset folder shadows web.py as an empty
    # namespace package and uvicorn reports: Attribute "app" not found in module "netseer.web".
    "netseer.web",
]

a = Analysis(
    [str(ROOT / "packaging" / "electron" / "server_entry.py")],
    pathex=[str(ROOT / "src")],
    datas=datas,
    hiddenimports=hiddenimports,
    # No GUI toolkit: Electron is the window, so pywebview/GTK aren't needed.
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "webview", "gi"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="netseer-server", console=True, strip=False, upx=False)

coll = COLLECT(exe, a.binaries, a.datas, name="netseer-server", strip=False, upx=False)
