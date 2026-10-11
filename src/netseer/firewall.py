"""Keep NetSeer reachable on Windows when it's shared on the network.

Windows Firewall blocks inbound connections to NetSeer's port by default — even with the socket
listening on ``0.0.0.0`` — so "Allow devices on my network" alone isn't enough there (a phone on the
LAN or over Tailscale just can't connect). When the user turns that on we add a *program-scoped*
inbound allow rule for the sidecar exe, which survives the port falling back to a random one. Adding a
rule needs elevation (one UAC prompt); reading the firewall does not, so the Settings hint can tell
when no rule is present.

Everything here no-ops off Windows, and we only auto-add a rule for the packaged sidecar exe (never a
dev ``python.exe``). macOS prompts to allow incoming connections on first bind; Linux users on
ufw/firewalld open the port themselves (see the docs).
"""

from __future__ import annotations

import subprocess
import sys

RULE_NAME = "NetSeer"
_CREATE_NO_WINDOW = 0x08000000  # keep netsh from flashing a console window
_ERROR_CANCELLED = 1223  # the user dismissed the UAC prompt


def is_windows() -> bool:
    return sys.platform.startswith("win")


def is_frozen() -> bool:
    """True when running as the packaged PyInstaller sidecar (so sys.executable is NetSeer's exe)."""
    return bool(getattr(sys, "frozen", False))


def supported() -> bool:
    """Whether we should manage a firewall rule here — only the packaged sidecar on Windows."""
    return is_windows() and is_frozen()


def server_program() -> str:
    return sys.executable


def manual_command() -> str:
    """The elevated PowerShell a user can run themselves if they'd rather not use the prompt."""
    return (
        f"New-NetFirewallRule -DisplayName '{RULE_NAME}' -Direction Inbound "
        f"-Program '{server_program()}' -Action Allow -Profile Private,Domain"
    )


def rule_present() -> bool:
    """Whether an inbound rule named NetSeer already exists. Reading needs no elevation."""
    if not is_windows():
        return False
    try:
        res = subprocess.run(
            ["netsh", "advfirewall", "firewall", "show", "rule", f"name={RULE_NAME}"],
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=_CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return res.returncode == 0 and RULE_NAME in (res.stdout or "")


def add_rule_elevated() -> str:
    """Add the inbound allow rule, prompting for elevation (UAC). Returns one of:
    'added', 'declined' (UAC dismissed), 'error', or 'unsupported'. Blocks until the prompt is
    answered, so call it off the request thread."""
    if not supported():
        return "unsupported"
    prog = server_program()
    # Replace any stale rule, then add a program-scoped inbound allow on the Private + Domain profiles
    # (Tailscale's interface is typically Private). One elevated cmd runs both so there's a single UAC.
    inner = (
        f'netsh advfirewall firewall delete rule name="{RULE_NAME}" >nul 2>&1 & '
        f'netsh advfirewall firewall add rule name="{RULE_NAME}" dir=in action=allow '
        f'program="{prog}" enable=yes profile=private,domain'
    )
    try:
        rc = _run_elevated_hidden("cmd.exe", f"/c {inner}")
    except OSError:
        return "error"
    if rc == _ERROR_CANCELLED:
        return "declined"
    return "added" if rc == 0 else "error"


def _run_elevated_hidden(file: str, params: str) -> int:
    """ShellExecuteEx with the 'runas' verb (UAC), hidden, waiting for the child's exit code."""
    import ctypes
    from ctypes import wintypes

    class SHELLEXECUTEINFOW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("fMask", ctypes.c_ulong),
            ("hwnd", wintypes.HWND),
            ("lpVerb", wintypes.LPCWSTR),
            ("lpFile", wintypes.LPCWSTR),
            ("lpParameters", wintypes.LPCWSTR),
            ("lpDirectory", wintypes.LPCWSTR),
            ("nShow", ctypes.c_int),
            ("hInstApp", wintypes.HINSTANCE),
            ("lpIDList", ctypes.c_void_p),
            ("lpClass", wintypes.LPCWSTR),
            ("hkeyClass", ctypes.c_void_p),
            ("dwHotKey", wintypes.DWORD),
            ("hIcon", ctypes.c_void_p),
            ("hProcess", ctypes.c_void_p),
        ]

    SEE_MASK_NOCLOSEPROCESS = 0x00000040
    SEE_MASK_NO_CONSOLE = 0x00008000
    SW_HIDE = 0

    info = SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NO_CONSOLE
    info.lpVerb = "runas"
    info.lpFile = file
    info.lpParameters = params
    info.nShow = SW_HIDE

    if not ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(info)):
        err = ctypes.GetLastError()
        if err == _ERROR_CANCELLED:  # the user dismissed the UAC prompt
            return _ERROR_CANCELLED
        raise OSError(err)
    if not info.hProcess:
        return 0
    ctypes.windll.kernel32.WaitForSingleObject(info.hProcess, 60000)
    code = wintypes.DWORD()
    ctypes.windll.kernel32.GetExitCodeProcess(info.hProcess, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(info.hProcess)
    return int(code.value)
