#!/usr/bin/env bash
# ==============================================================================
# Distributed Job Scheduler — Linux & macOS POSIX Test Runner
# Supports: Ubuntu, Debian, Alpine, Fedora, CentOS, Arch, macOS Sonoma/Sequoia, WSL
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Text Styling
BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║   DISTRIBUTED JOB SCHEDULER — POSIX (LINUX/MACOS) TEST RUNNER        ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════════════════════════╝${NC}"

# Check for Docker flag
if [[ "$1" == "--docker" ]] || [[ "$1" == "-d" ]]; then
    echo -e "${YELLOW}▶ Running tests inside isolated Docker test container...${NC}"
    if command -v docker-compose &> /dev/null; then
        docker-compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from test-runner
    else
        docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from test-runner
    fi
    exit $?
fi

# Check Node.js runtime
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Error: Node.js is not installed or not in PATH.${NC}"
    exit 1
fi

FILTER=""
if [[ -n "$1" ]]; then
    FILTER="--filter=$1"
    echo -e "${YELLOW}▶ Applying suite filter:${NC} $1"
fi

echo -e "${GREEN}▶ Launching cross-platform master runner...${NC}\n"
node tests/run_all.js $FILTER
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]]; then
    echo -e "\n${GREEN}${BOLD}✔ All test suites passed successfully!${NC}"
else
    echo -e "\n${RED}${BOLD}✗ Test execution failed with exit code ${EXIT_CODE}.${NC}"
fi

exit $EXIT_CODE
