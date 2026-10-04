# PyInstaller spec for the Linux build.
#   pyinstaller packaging/linux/netseer.spec --noconfirm --clean
# Produces dist/NetSeer/NetSeer; build-appimage.sh wraps it into an AppImage and a tarball.

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parents[1]

# The web UI, bundled samples, and OUI table live inside the netseer package. Listed
# straight from src/ because collect_data_files can't import netseer while the spec runs.
PACKAGE = ROOT / "src" / "netseer"
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
]

a = Analysis(
    [str(ROOT / "packaging" / "windows" / "launcher.py")],
    pathex=[str(ROOT / "src")],
    datas=datas,
    hiddenimports=hiddenimports,
    # The AppImage opens an installed browser in app mode instead of bundling
    # WebKitGTK, whose helper processes expect fixed system paths.
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "scapy.contrib", "webview", "gi"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="NetSeer", console=True, strip=False, upx=False)

coll = COLLECT(exe, a.binaries, a.datas, name="NetSeer", strip=False, upx=False)
