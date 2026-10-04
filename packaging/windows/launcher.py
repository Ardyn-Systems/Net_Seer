"""Entry point for the frozen NetSeer.exe (see netseer.spec)."""

import sys

from netseer.desktop import main

if __name__ == "__main__":
    sys.exit(main())
