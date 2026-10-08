"""Entry point for the frozen NetSeer server sidecar the Electron shell launches.

Unlike the desktop build (which opens its own pywebview window), this freezes only the web server
(netseer.cli.main -> uvicorn). The Electron app is the window; this is just the backend.
See electron/ and docs/electron-migration.md.
"""

import sys

from netseer.cli import main

if __name__ == "__main__":
    sys.exit(main() or 0)
