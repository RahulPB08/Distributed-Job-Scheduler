#!/usr/bin/env bash
# ============================================================
#  Distributed Job Scheduler (DJS) — Universal Unix Launcher
#  Works on Linux (gnome-terminal/xterm) and macOS (Terminal)
# ============================================================
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOLD="\033[1m"; CYAN="\033[36m"; GREEN="\033[32m"; YELLOW="\033[33m"; RESET="\033[0m"

echo ""
echo -e "${CYAN}${BOLD}========================================================${RESET}"
echo -e "${CYAN}${BOLD}   Distributed Job Scheduler (DJS) — Launcher (Unix)   ${RESET}"
echo -e "${CYAN}${BOLD}========================================================${RESET}"
echo ""

# ── Helper: open terminal in background ───────────────────────────────────────
open_terminal() {
  local title="$1"
  local dir="$2"
  local cmd="$3"
  local full_cmd="cd '$dir' && echo -e '\033[36m[$title]\033[0m' && $cmd; exec bash"

  if command -v gnome-terminal &>/dev/null; then
    gnome-terminal --title="$title" -- bash -c "$full_cmd" &
  elif command -v xterm &>/dev/null; then
    xterm -title "$title" -e bash -c "$full_cmd" &
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    osascript -e "tell application \"Terminal\"
      activate
      do script \"$full_cmd\"
    end tell" &
  else
    bash -c "$full_cmd" &
    echo "  [$title] started in background (PID: $!)"
  fi
}

# ── Step 1: Install dependencies ──────────────────────────────────────────────
echo -e "${YELLOW}[1/6] Checking & installing dependencies...${RESET}"
for svc in backend scheduler worker frontend; do
  if [ ! -d "$ROOT_DIR/$svc/node_modules" ]; then
    echo "      Installing $svc..."
    (cd "$ROOT_DIR/$svc" && npm install --silent)
    echo "      $svc ✓"
  else
    echo "      $svc — already installed ✓"
  fi
done

# ── Step 2: Seed Database ─────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[2/6] Seeding database...${RESET}"
(cd "$ROOT_DIR/backend" && node src/database/seed.js)
echo "      Seed complete ✓"

# ── Step 3: Backend ───────────────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}[3/6] Launching Backend API → http://localhost:4000${RESET}"
open_terminal "DJS-Backend" "$ROOT_DIR/backend" "npm run dev"
sleep 4

# ── Step 4: Scheduler ─────────────────────────────────────────────────────────
echo -e "${YELLOW}[4/6] Launching Scheduler...${RESET}"
open_terminal "DJS-Scheduler" "$ROOT_DIR/scheduler" "node src/index.js"
sleep 2

# ── Step 5: Workers ───────────────────────────────────────────────────────────
echo -e "${YELLOW}[5/6] Launching Worker Fleet (Alpha & Beta)...${RESET}"
open_terminal "DJS-Worker-Alpha" "$ROOT_DIR/worker" "node src/index.js --worker-id=worker-alpha --concurrency=5 --poll-interval=100"
sleep 0.5
open_terminal "DJS-Worker-Beta"  "$ROOT_DIR/worker" "node src/index.js --worker-id=worker-beta  --concurrency=5 --poll-interval=100"

# ── Step 6: Frontend ──────────────────────────────────────────────────────────
echo -e "${YELLOW}[6/6] Launching Frontend → http://localhost:3000${RESET}"
open_terminal "DJS-Frontend" "$ROOT_DIR/frontend" "npm run dev"

echo ""
echo -e "${GREEN}${BOLD}========================================================"
echo -e "  All services launched!"
echo -e "========================================================${RESET}"
echo ""
echo -e "  Dashboard :  ${BOLD}http://localhost:3000${RESET}"
echo -e "  Backend   :  http://localhost:4000"
echo -e "  WebSocket :  ws://localhost:3000/ws  (Vite-proxied)"
echo ""
echo -e "  ${YELLOW}Credentials:${RESET}"
echo -e "    Admin : admin@djs.io   / AdminPassword123!"
echo -e "    Dev   : dev@djs.io     / DevPassword123!"
echo ""
