# PyInstaller spec for the Windows desktop build.
#   pyinstaller packaging/windows/netseer.spec --noconfirm --clean
# Produces dist/NetSeer/NetSeer.exe (one folder; the installer and portable zip wrap it).

import tomllib
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules
from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo,
    StringFileInfo,
    StringStruct,
    StringTable,
    VarFileInfo,
    VarStruct,
    VSVersionInfo,
)

ROOT = Path(SPECPATH).parents[1]
VERSION = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
numbers = tuple(int(p) for p in (VERSION.split("+")[0].split("-")[0].split(".") + ["0"] * 4)[:4])

version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=numbers, prodvers=numbers),
    kids=[
        StringFileInfo(
            [
                StringTable(
                    "040904B0",
                    [
                        StringStruct("CompanyName", "Ardyn Systems"),
                        StringStruct("FileDescription", "NetSeer — turn traffic into terrain"),
                        StringStruct("FileVersion", VERSION),
                        StringStruct("InternalName", "NetSeer"),
                        StringStruct("OriginalFilename", "NetSeer.exe"),
                        StringStruct("ProductName", "NetSeer"),
                        StringStruct("ProductVersion", VERSION),
                    ],
                )
            ]
        ),
        VarFileInfo([VarStruct("Translation", [1033, 1200])]),
    ],
)

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
    [str(Path(SPECPATH) / "launcher.py")],
    pathex=[str(ROOT / "src")],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "uvloop"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="NetSeer",
    icon=str(Path(SPECPATH) / "netseer.ico"),
    version=version_info,
    console=False,
    upx=False,
)

coll = COLLECT(exe, a.binaries, a.datas, name="NetSeer", upx=False)
