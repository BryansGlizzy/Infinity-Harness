#!/usr/bin/env bash
# ==============================================================================
# Infinity Harness — 1-Shot All-in-One Installer, Builder & Updater
# Repository: https://github.com/BryansGlizzy/Infinity-Harness.git
# ==============================================================================
# Usage:
#   ./install.sh [options]
#
# Options:
#   -u, --update        Pull latest changes from GitHub and rebuild everything
#   --with-agents       Also install missing CLI agent harnesses (Claude, Codex,
#                       Codex ACP, Kimi, OpenCode) via npm
#   --skip-vscode       Skip packaging/installing the local VS Code extension
#   --skip-tests        Skip post-build verification tests
#   --start             Launch the Infinity Harness daemon after installation
#   -h, --help          Show this help message
# ==============================================================================

set -euo pipefail

IH_REPO_URL="${IH_REPO_URL:-https://github.com/BryansGlizzy/Infinity-Harness.git}"
IH_BRANCH="${IH_BRANCH:-main}"
IH_INSTALL_DIR="${IH_INSTALL_DIR:-$HOME/Infinity-Harness}"
IH_BIN_DIR="${IH_BIN_DIR:-$HOME/.local/bin}"

DO_UPDATE=0
WITH_AGENTS=0
SKIP_VSCODE=0
SKIP_TESTS=0
START_AFTER=0

# Colors
if [[ -t 1 ]]; then
  C_RESET="\033[0m"
  C_BOLD="\033[1m"
  C_DIM="\033[2m"
  C_CYAN="\033[36m"
  C_GREEN="\033[32m"
  C_YELLOW="\033[33m"
  C_RED="\033[31m"
else
  C_RESET="" C_BOLD="" C_DIM="" C_CYAN="" C_GREEN="" C_YELLOW="" C_RED=""
fi

info()  { printf "${C_CYAN}${C_BOLD}==>${C_RESET} %s\n" "$*"; }
ok()    { printf "${C_GREEN}${C_BOLD}  ✓${C_RESET} %s\n" "$*"; }
warn()  { printf "${C_YELLOW}${C_BOLD}  !${C_RESET} %s\n" "$*" >&2; }
err()   { printf "${C_RED}${C_BOLD}  ✗${C_RESET} %s\n" "$*" >&2; }
step()  { printf "\n${C_BOLD}[%s] %s${C_RESET}\n" "$1" "$2"; }

usage() {
  cat <<EOF
Infinity Harness — 1-Shot All-in-One Installer, Builder & Updater
Repository: ${IH_REPO_URL}

Usage:
  ./install.sh [options]
  curl -fsSL https://raw.githubusercontent.com/BryansGlizzy/Infinity-Harness/main/install.sh | bash

Options:
  -u, --update        Pull latest changes from GitHub (${IH_REPO_URL}) and rebuild
  --with-agents       Install missing CLI agent harnesses (Claude, Codex, Kimi, OpenCode)
  --skip-vscode       Skip building/installing the VS Code extension
  --skip-tests        Skip running verification tests after build
  --start             Start the Infinity Harness daemon (http://127.0.0.1:7420) when done
  -h, --help          Show this help text

Environment Variables:
  IH_REPO_URL         Git repository URL (default: ${IH_REPO_URL})
  IH_BRANCH           Git branch to track (default: ${IH_BRANCH})
  IH_INSTALL_DIR      Clone destination when run outside a checkout (default: ${IH_INSTALL_DIR})
  IH_BIN_DIR          Directory for the global 'ih' CLI wrapper (default: ${IH_BIN_DIR})
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--update)      DO_UPDATE=1; shift ;;
    --with-agents)    WITH_AGENTS=1; shift ;;
    --skip-vscode)    SKIP_VSCODE=1; shift ;;
    --skip-tests)     SKIP_TESTS=1; shift ;;
    --start)          START_AFTER=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                err "Unknown option: $1"; usage; exit 2 ;;
  esac
done

# Ensure common user binary directories are on PATH
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.opencode/bin:$PATH"

printf "${C_BOLD}${C_CYAN}"
cat <<'BANNER'
  ___        __ _       _ _           _   _                                
 |_ _|_ __  / _(_)_ __ (_) |_ _   _  | | | | __ _ _ __ _ __   ___  ___ ___ 
  | || '_ \| |_| | '_ \| | __| | | | | |_| |/ _` | '__| '_ \ / _ \/ __/ __|
  | || | | |  _| | | | | | |_| |_| | |  _  | (_| | |  | | | |  __/\__ \__ \
 |___|_| |_|_| |_|_| |_|_|\__|\__, | |_| |_|\__,_|_|  |_| |_|\___||___/___/
                              |___/                                        
BANNER
printf "${C_RESET}${C_DIM}  Multi-Harness Sub-Agent Orchestrator · All-in-One Installer & Updater${C_RESET}\n"

# ------------------------------------------------------------------------------
# Step 1: System Prerequisites (git, curl, unzip, Node.js >= 24, pnpm)
# ------------------------------------------------------------------------------
step "1/7" "Checking system prerequisites & Node.js runtime"

for cmd in git curl unzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "Required tool '$cmd' is not installed. Please install '$cmd' via your system package manager."
    exit 1
  fi
done
ok "Core utilities found (git, curl, unzip)"

ensure_node24() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [[ "$major" -ge 24 ]]; then
      ok "Node.js $(node -v) detected (>= 24 required)"
      return 0
    fi
    warn "Node.js $(node -v) is older than v24. Attempting to activate or install Node.js 24..."
  else
    warn "Node.js not found. Attempting to install Node.js 24..."
  fi

  # Try fnm if available
  if command -v fnm >/dev/null 2>&1; then
    info "Installing Node.js 24 via fnm..."
    fnm install 24 && eval "$(fnm env)" && fnm use 24
  elif [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    info "Installing Node.js 24 via nvm..."
    # shellcheck disable=SC1090
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 24 && nvm use 24
  else
    info "Installing fnm (Fast Node Manager) to bootstrap Node.js 24..."
    curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell
    export PATH="$HOME/.local/share/fnm:$HOME/.fnm:$PATH"
    if command -v fnm >/dev/null 2>&1; then
      eval "$(fnm env)"
      fnm install 24
      fnm use 24
      fnm default 24
    fi
  fi

  local final_major
  final_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$final_major" -lt 24 ]]; then
    err "Node.js >= 24 is required (found: $(command -v node >/dev/null 2>&1 && node -v || echo 'none'))."
    err "Please install Node.js 24+ from https://nodejs.org and re-run ./install.sh."
    exit 1
  fi
  ok "Node.js $(node -v) active"
}

ensure_node24

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    ok "pnpm $(pnpm -v) detected"
    return 0
  fi
  info "pnpm not found; activating via corepack / npm..."
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    npm install -g pnpm
  fi
  ok "pnpm $(pnpm -v) installed"
}

ensure_pnpm

# ------------------------------------------------------------------------------
# Step 2: Locate or Clone Repository & Sync with GitHub
# ------------------------------------------------------------------------------
step "2/7" "Resolving workspace & GitHub repository (${IH_REPO_URL})"

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/pnpm-workspace.yaml" && -d "$SCRIPT_DIR/apps/daemon" ]]; then
  REPO_ROOT="$SCRIPT_DIR"
  ok "Running inside existing Infinity Harness checkout: $REPO_ROOT"
elif [[ -f "$PWD/pnpm-workspace.yaml" && -d "$PWD/apps/daemon" ]]; then
  REPO_ROOT="$PWD"
  ok "Running inside current directory checkout: $REPO_ROOT"
else
  REPO_ROOT="$IH_INSTALL_DIR"
  if [[ -d "$REPO_ROOT/.git" ]]; then
    ok "Found existing installation at $REPO_ROOT"
    DO_UPDATE=1
  else
    info "Cloning ${IH_REPO_URL} into ${REPO_ROOT}..."
    git clone "$IH_REPO_URL" "$REPO_ROOT"
    ok "Cloned repository to $REPO_ROOT"
  fi
fi

cd "$REPO_ROOT"

# Ensure git repository & origin remote point to Infinity-Harness
if [[ -d .git ]]; then
  if git remote get-url origin >/dev/null 2>&1; then
    CURRENT_ORIGIN="$(git remote get-url origin)"
    ok "Git remote 'origin' configured: ${CURRENT_ORIGIN}"
  else
    info "Setting git remote 'origin' to ${IH_REPO_URL}..."
    git remote add origin "$IH_REPO_URL"
    ok "Added remote 'origin' -> ${IH_REPO_URL}"
  fi

  if [[ "$DO_UPDATE" -eq 1 ]]; then
    info "Checking for updates from origin (${IH_BRANCH})..."
    if git ls-remote --exit-code --heads origin "$IH_BRANCH" >/dev/null 2>&1; then
      STASHED=0
      if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
        info "Stashing local uncommitted changes before pulling..."
        git stash push -m "ih-install-autostash-$(date +%s)" >/dev/null
        STASHED=1
      fi
      BEFORE_SHA="$(git rev-parse HEAD 2>/dev/null || echo 'none')"
      git fetch origin "$IH_BRANCH"
      if git pull --rebase origin "$IH_BRANCH"; then
        AFTER_SHA="$(git rev-parse HEAD 2>/dev/null || echo 'none')"
        if [[ "$BEFORE_SHA" == "$AFTER_SHA" ]]; then
          ok "Already up to date (${AFTER_SHA:0:7})"
        else
          ok "Updated ${BEFORE_SHA:0:7} -> ${AFTER_SHA:0:7}"
        fi
      else
        warn "git pull --rebase encountered a conflict; aborting rebase and keeping current tree."
        git rebase --abort >/dev/null 2>&1 || true
      fi
      if [[ "$STASHED" -eq 1 ]]; then
        info "Restoring stashed local modifications..."
        git stash pop >/dev/null || warn "Could not cleanly pop stash; check 'git stash list'."
      fi
    else
      warn "Remote branch '${IH_BRANCH}' does not exist on origin yet (blank repository)."
      warn "Push your initial commit with: git push -u origin ${IH_BRANCH}"
    fi
  fi
fi

# ------------------------------------------------------------------------------
# Step 3: Install Workspace Dependencies & Initialize .env
# ------------------------------------------------------------------------------
step "3/7" "Installing workspace dependencies & environment configuration"

pnpm install
ok "Workspace dependencies installed"

if [[ -d .meta-harness && ! -e .infinity-harness ]]; then
  mv .meta-harness .infinity-harness
  ok "Migrated legacy .meta-harness directory to .infinity-harness"
fi
mkdir -p .infinity-harness

if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
  ok "Created .env from .env.example"
elif [[ -f .env ]]; then
  ok ".env configuration present"
fi

# ------------------------------------------------------------------------------
# Step 4: Install ACP Bridges & Check System Agent Harnesses
# ------------------------------------------------------------------------------
step "4/7" "Setting up ACP bridges & checking system agent harnesses"

if [[ -x ./scripts/install-agy-acp.sh ]]; then
  if ./scripts/install-agy-acp.sh; then
    ok "Google Antigravity ACP bridge ready"
  else
    warn "Antigravity ACP bridge install skipped or unsupported on this platform (can be installed later from UI)"
  fi
fi

if [[ "$WITH_AGENTS" -eq 1 ]]; then
  info "--with-agents enabled: installing/updating system CLI harnesses..."
  npm install -g @anthropic-ai/claude-code @openai/codex @agentclientprotocol/codex-acp @moonshot-ai/kimi-code opencode-ai || \
    warn "Some optional global npm agent packages could not be installed automatically."
fi

check_harness_bin() {
  local label="$1"
  local bin="$2"
  if command -v "$bin" >/dev/null 2>&1; then
    printf "  ${C_GREEN}●${C_RESET} %-22s %s\n" "$label" "$(command -v "$bin")"
  else
    printf "  ${C_YELLOW}○${C_RESET} %-22s %s\n" "$label" "not installed (installable in Web UI -> Agents)"
  fi
}

printf "\n  ${C_BOLD}Detected System Harnesses:${C_RESET}\n"
check_harness_bin "Claude Code (claude)" "claude"
check_harness_bin "OpenAI Codex (codex)" "codex"
check_harness_bin "Codex ACP Bridge" "codex-acp"
check_harness_bin "Kimi Code (kimi)" "kimi"
if [[ -f ".infinity-harness/bin/agy-acp/agy_acp_server.par" ]]; then
  printf "  ${C_GREEN}●${C_RESET} %-22s %s\n" "Antigravity ACP" "$REPO_ROOT/.infinity-harness/bin/agy-acp/agy_acp_server.par"
else
  printf "  ${C_YELLOW}○${C_RESET} %-22s %s\n" "Antigravity ACP" "not installed (installable in Web UI -> Agents)"
fi
check_harness_bin "OpenCode (NIM/Local)" "opencode"
check_harness_bin "GitHub CLI (gh)" "gh"
printf "  ${C_DIM}Tip: Open the Web UI -> Agents view to 1-click install or sign into any harness.${C_RESET}\n"

# ------------------------------------------------------------------------------
# Step 5: Typecheck, Build Web UI & Build VS Code Extension
# ------------------------------------------------------------------------------
step "5/7" "Compiling TypeScript, bundling Web UI & VS Code extension"

pnpm typecheck
ok "TypeScript typecheck passed across all packages"

pnpm build:web
ok "Web UI compiled & bundled into apps/web/dist"

if [[ "$SKIP_VSCODE" -eq 0 ]]; then
  pnpm build:vscode
  ok "VS Code extension compiled into apps/vscode/dist/extension.js"
  if command -v code >/dev/null 2>&1; then
    info "VS Code ('code' CLI) found — packaging & installing extension..."
    if pnpm --filter infinity-harness install-local >/dev/null 2>&1; then
      ok "Installed Infinity Harness VS Code extension into local VS Code"
    else
      warn "Could not auto-install VSIX into VS Code (run 'pnpm --filter infinity-harness install-local' manually)"
    fi
  else
    info "VS Code 'code' CLI not on PATH; built extension bundle at apps/vscode/dist/extension.js"
  fi
else
  info "Skipping VS Code extension build (--skip-vscode)"
fi

# ------------------------------------------------------------------------------
# Step 6: Install Global 'ih' CLI Wrapper
# ------------------------------------------------------------------------------
step "6/7" "Installing global 'ih' CLI command into ${IH_BIN_DIR}/ih"

mkdir -p "$IH_BIN_DIR"
cat > "$IH_BIN_DIR/ih" <<EOF
#!/usr/bin/env bash
# Auto-generated by Infinity Harness install.sh
set -euo pipefail
IH_ROOT="${REPO_ROOT}"
export PATH="\$HOME/.local/bin:\$HOME/.npm-global/bin:\$HOME/.opencode/bin:\$PATH"

case "\${1:-}" in
  update|upgrade)
    shift
    exec "\$IH_ROOT/install.sh" --update "\$@"
    ;;
  daemon|serve|start)
    shift
    cd "\$IH_ROOT"
    exec node apps/daemon/src/main.ts "\$@"
    ;;
  *)
    exec node "\$IH_ROOT/apps/cli/src/main.ts" "\$@"
    ;;
esac
EOF
chmod +x "$IH_BIN_DIR/ih"
ok "Installed global CLI wrapper: ${IH_BIN_DIR}/ih"
ok "Subcommands enabled: 'ih status', 'ih tui', 'ih daemon', 'ih update'"

# ------------------------------------------------------------------------------
# Step 7: Post-Build Verification
# ------------------------------------------------------------------------------
step "7/7" "Running verification checks"

if [[ "$SKIP_TESTS" -eq 0 ]]; then
  node --test apps/daemon/test/harnesses.test.ts apps/web/test/*.test.ts apps/cli/test/*.test.ts
  ok "Verification test suite passed"
else
  info "Skipping test suite (--skip-tests)"
fi

printf "\n${C_GREEN}${C_BOLD}==============================================================================${C_RESET}\n"
printf "${C_GREEN}${C_BOLD}  Infinity Harness installation & build complete!${C_RESET}\n"
printf "${C_GREEN}${C_BOLD}==============================================================================${C_RESET}\n\n"
printf "  ${C_BOLD}Start the daemon + Web UI:${C_RESET}   pnpm start        ${C_DIM}(or: ih daemon)${C_RESET}\n"
printf "  ${C_BOLD}Open the Web UI:${C_RESET}             http://127.0.0.1:7420\n"
printf "  ${C_BOLD}Link/Install Agents in UI:${C_RESET}   http://127.0.0.1:7420/?view=agents\n"
printf "  ${C_BOLD}Terminal Dashboard (TUI):${C_RESET}    ih tui\n"
printf "  ${C_BOLD}Update from GitHub anytime:${C_RESET}  ./install.sh --update   ${C_DIM}(or: ih update)${C_RESET}\n\n"

if [[ "$START_AFTER" -eq 1 ]]; then
  info "Starting Infinity Harness daemon on http://127.0.0.1:7420 ..."
  exec node apps/daemon/src/main.ts
fi
