#!/bin/sh
# Quick build of the workbench: dist/hla64.html (one file, works from file://) and the PWA in dist/pages/.
#   ./build.sh            install the tools if needed, build the page
#   ./build.sh check      typecheck + the CI tests first, then build
#   ./build.sh open       build and open dist/hla64.html in the browser
# Options combine: ./build.sh check open
set -e
cd "$(dirname "$0")"

CHECK=0
OPEN=0
for a in "$@"; do
  case "$a" in
    check) CHECK=1 ;;
    open) OPEN=1 ;;
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument '$a' (check, open)" >&2; exit 2 ;;
  esac
done

# Node 24+ runs the .ts sources directly
command -v node >/dev/null 2>&1 || { echo "node not found: install Node 24+" >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 24 ] || { echo "Node $(node -v) is too old: Node 24+ is needed" >&2; exit 1; }

# the tools (esbuild, typescript): when missing or older than package-lock.json
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  npm ci --no-audit --no-fund
  touch node_modules
fi

if [ "$CHECK" = 1 ]; then
  npm run --silent typecheck
  npm run --silent test:ci
fi

npm run --silent build:web

if [ "$OPEN" = 1 ]; then
  case "$(uname -s)" in
    Darwin) open dist/hla64.html ;;
    MINGW*|MSYS*|CYGWIN*) start dist/hla64.html ;;
    *) xdg-open dist/hla64.html >/dev/null 2>&1 & ;;
  esac
fi
