#!/bin/bash
set -euo pipefail

# --- Helpers ---

info()    { echo -e "\033[1;34m[INFO]\033[0m $*"; }
success() { echo -e "\033[1;32m[ OK ]\033[0m $*"; }
warn()    { echo -e "\033[1;33m[WARN]\033[0m $*"; }

command_exists() { command -v "$1" &>/dev/null; }

# Overlays run this from elsewhere (e.g. as a submodule of their repo), and every link
# below is built from $(pwd).
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

# --- Nix ---

if ! command_exists nix; then
  info "Installing Nix..."
  curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install --no-confirm
  # Source nix in current shell
  if [ -f /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]; then
    . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
  fi
  success "Nix installed"
else
  info "Nix already installed"
fi

info "Installing Nix packages (jq, pspg, go, bun, pi, ...)..."
# Authenticate with GitHub to avoid rate limits when fetching flake inputs
# Try gh CLI token if GITHUB_TOKEN not set
if [ -z "${GITHUB_TOKEN:-}" ] && command_exists gh; then
  GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
fi
if [ -n "${GITHUB_TOKEN:-}" ]; then
  NETRC_FILE=$(mktemp)
  echo -e "machine api.github.com\nlogin x-access-token\npassword $GITHUB_TOKEN\nmachine github.com\nlogin x-access-token\npassword $GITHUB_TOKEN" > "$NETRC_FILE"
  trap 'rm -f "$NETRC_FILE"' EXIT
  export NIX_CONFIG="netrc-file = $NETRC_FILE"
fi
# The element is found by URL, not name: names derive from the checkout dir, so an overlay
# repo may own "dotfiles" while this checkout installs as e.g. "public".
flake_url="git+file://$(pwd -P)"
element=""
if command_exists jq; then
  element=$(nix profile list --json 2>/dev/null \
    | jq -r --arg u "$flake_url" '.elements | to_entries[] | select(.value.originalUrl == $u) | .key' \
    | head -n 1 || true)
fi
if [ -n "$element" ]; then
  nix profile upgrade "$element" 2>&1
else
  nix profile install . --accept-flake-config
fi
success "Nix packages installed"
# --- Non-Nix dependencies ---

if ! command_exists swaylock; then
  info "Installing swaylock with host PAM support..."
  sudo apt-get install -y swaylock
  success "swaylock installed"
else
  info "swaylock already installed"
fi

# nvm
if [ ! -d "$HOME/.nvm" ]; then
  info "Installing nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  success "nvm installed"
else
  info "nvm already installed"
fi

# Rust (via rustup)
if ! command_exists rustup; then
  info "Installing Rust via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  success "Rust installed"
else
  info "Rust already installed"
fi

# pyenv
if ! command_exists pyenv; then
  info "Installing pyenv..."
  curl https://pyenv.run | bash
  success "pyenv installed"
else
  info "pyenv already installed"
fi

# Docker
if ! command_exists docker; then
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  success "Docker installed (log out and back in for group changes)"
else
  info "Docker already installed"
fi

# Pi (coding-agent) is installed via the nix flake (see flake.nix + nix/pi.nix)

# --- Symlinks ---

# Files that must name this checkout (home-manager) go through this link, so the checkout
# can live anywhere, including inside an overlay repo.
mkdir -p ~/.local/share
ln -sfn "$(pwd -P)" ~/.local/share/dotfiles

# Symlink bashrc
ln -sf "$(pwd)/bash/bashrc" ~/.bashrc

# Symlink tmux config
ln -sf "$(pwd)/tmux/tmux.conf" ~/.tmux.conf

# Global gitignore at git's XDG default path, so no core.excludesFile is needed; it keeps
# per-project tool state (e.g. pi-tldraw's .pi/tldraw-*) out of every repo.
mkdir -p ~/.config/git
ln -sf "$(pwd)/git/ignore" ~/.config/git/ignore

# Symlink pi config to ~/.pi/agent
mkdir -p ~/.pi/agent
ln -sf  "$(pwd)/pi/AGENTS.md"     ~/.pi/agent/AGENTS.md
ln -sf  "$(pwd)/pi/MERMAID.md"    ~/.pi/agent/MERMAID.md

# Per-entry links, settings.json, mcp.json and zed settings: pi and zed rewrite those files
# at runtime, so they are rendered copies (see bin/dotfiles-sync --help).
"$(pwd)/bin/dotfiles-sync"

# Symlink i3 config to ~/.config/i3
mkdir -p ~/.config/i3
ln -sf "$(pwd)/i3/config" ~/.config/i3/config

# Install GDM integration only after the Home Manager profile and GPU bridge exist.
# This adds an optional session without restarting GDM or touching i3.
if [ -x "$HOME/.nix-profile/bin/start-hyprland" ] && [ -L /run/opengl-driver ]; then
  hyprland_gdm_changed=0
  if ! cmp -s "$(pwd)/hypr/host/hyprland-session" /usr/local/bin/hm-hyprland-session; then
    hyprland_gdm_changed=1
  elif ! cmp -s "$(pwd)/hypr/host/hyprland.desktop" /usr/local/share/wayland-sessions/hyprland-hm.desktop; then
    hyprland_gdm_changed=1
  fi

  if [ "$hyprland_gdm_changed" -eq 1 ]; then
    info "Installing the optional Hyprland GDM session (requires sudo)..."
    sudo install -Dm755 "$(pwd)/hypr/host/hyprland-session" /usr/local/bin/hm-hyprland-session
    sudo install -Dm644 "$(pwd)/hypr/host/hyprland.desktop" /usr/local/share/wayland-sessions/hyprland-hm.desktop
    success "Hyprland GDM session installed without restarting GDM"
  else
    info "Hyprland GDM session already up to date"
  fi
else
  warn "Skipping Hyprland GDM session until Home Manager and /run/opengl-driver are ready"
fi

# Symlink zed config to ~/.config/zed
mkdir -p ~/.config/zed
ln -sf "$(pwd)/zed/keymap.json" ~/.config/zed/keymap.json
ln -sf "$(pwd)/zed/tasks.json" ~/.config/zed/tasks.json

# Symlink bin scripts to ~/.local/bin
mkdir -p ~/.local/bin
ln -sf "$(pwd)/bin/dotfiles-sync" ~/.local/bin/dotfiles-sync
ln -sf "$(pwd)/bin/solve-mr-comments" ~/.local/bin/solve-mr-comments
ln -sf "$(pwd)/bin/update-pr-description" ~/.local/bin/update-pr-description
ln -sf "$(pwd)/bin/pi-update" ~/.local/bin/pi-update
ln -sf "$(pwd)/bin/validate-review-plan" ~/.local/bin/validate-review-plan
ln -sf "$(pwd)/bin/reset-camera" ~/.local/bin/reset-camera

# Symlink systemd user services
mkdir -p ~/.config/systemd/user
ln -sf "$(pwd)/systemd/pi-update.service" ~/.config/systemd/user/pi-update.service
ln -sf "$(pwd)/systemd/pi-update.timer" ~/.config/systemd/user/pi-update.timer
systemctl --user daemon-reload
systemctl --user enable --now pi-update.timer

# systemd-oomd hardening: prevent oomd from killing init.scope / session
# services when user@.service hits memory pressure. See
# systemd/oomd/system/user@.service.d/99-oomd-override.conf for rationale.
oomd_files=(
  "systemd/oomd/system/user@.service.d/99-oomd-override.conf:/etc/systemd/system/user@.service.d/99-oomd-override.conf"
  "systemd/oomd/user/app.slice.d/10-oomd.conf:/etc/systemd/user/app.slice.d/10-oomd.conf"
  "systemd/oomd/user/session.slice.d/10-oomd.conf:/etc/systemd/user/session.slice.d/10-oomd.conf"
)
oomd_changed=0
for pair in "${oomd_files[@]}"; do
  src="$(pwd)/${pair%%:*}"
  dest="${pair##*:}"
  if ! cmp -s "$src" "$dest"; then
    oomd_changed=1
    break
  fi
done

if [ "$oomd_changed" -eq 1 ]; then
  info "Installing systemd-oomd drop-ins (requires sudo)..."
  for pair in "${oomd_files[@]}"; do
    src="$(pwd)/${pair%%:*}"
    dest="${pair##*:}"
    sudo install -Dm644 "$src" "$dest"
  done
  sudo systemctl daemon-reload
  systemctl --user daemon-reload
  success "systemd-oomd drop-ins installed"
else
  info "systemd-oomd drop-ins already up to date"
fi

success "Dotfiles installed"
