"""Entry point for the frozen NetSeer server sidecar the Electron shell launches.

This freezes only the web server (netseer.cli.main -> uvicorn); the Electron app is the window and
this is just the backend it launches.
See electron/ and docs/electron-migration.md.
"""

import sys

from netseer.cli import main

if __name__ == "__main__":
    sys.exit(main() or 0)
