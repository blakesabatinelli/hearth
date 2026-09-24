"""hearth-extract CLI shim. Real entry point is hearth_extract.__init__:main."""

import sys
from hearth_extract import main

if __name__ == "__main__":
    main()
    sys.exit(0)