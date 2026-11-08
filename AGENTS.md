# agents.md

Instructions for AI coding agents working in this dotfiles repository.

## Repository overview

Personal dotfiles for a Linux workstation (x86_64): i3 and Hyprland (hy3), Kitty, Zed, and the
[pi](https://pi.dev) coding agent with a set of local extensions. The repo also contains CLI scripts
for an AI-assisted GitHub/GitLab review workflow.

This repo is **public**. It must stay useful on any machine and must not contain anything internal
to an employer: hostnames, gateways, internal tools, tokens, or work-only config. Work-specific
config lives in a separate private overlay repo that consumes this one (e.g. as a git submodule)
through the hooks below. When the overlay needs something here, add a **generic hook** instead of
special-casing it.

## Structure

```
bash/bashrc              # Shell config, symlinked to ~/.bashrc
bin/                     # Standalone CLI scripts, symlinked to ~/.local/bin/
docs/                    # Documentation for complex scripts
home-manager/            # Home Manager module for the Hyprland session
hypr/                    # Hyprland config + agent-layout (pi terminal restore)
i3/config                # i3 window manager config
nix/                     # Nix packaging for pi, pi extensions and patches
pi/                      # pi agent config, extensions, agents, prompts
zed/                     # Zed editor settings, keymap, tasks
flake.nix                # Nix flake for system packages
install.sh               # Bootstrap script (packages + symlinks)
```

Organized **by tool** -- each top-level directory corresponds to one program. Configs are flat within each directory (no deep nesting).

## Overlay hooks

All external overlay paths are optional; with none present everything behaves as standalone.
`$OVERLAY` is `${XDG_CONFIG_HOME:-~/.config}/dotfiles`. This checkout also commits a baseline
variant overlay in `overlay/`; `bash/bashrc` and `bin/dotfiles-sync` read it before `$OVERLAY`, so
external overlays can still override it.

| Hook | Consumed by | Contract |
|------|-------------|----------|
| `overlay/` | `bash/bashrc`, `bin/dotfiles-sync` | Committed baseline for this variant; external `$OVERLAY` fragments are merged after it |
| `$OVERLAY/bashrc.d/*.sh` | `bash/bashrc` (last thing it does) | Sourced in name order; may wrap or override anything |
| `$OVERLAY/pi/settings.d/*.json`, `$OVERLAY/pi/mcp.d/*.json` | `bin/dotfiles-sync` | Deep-merged over `pi/settings.json` / `pi/mcp.json` (later files win, arrays are replaced) |
| `$OVERLAY/pi/extensions.exclude` | `bin/dotfiles-sync` | One extension name per line; matching entries in `pi/extensions` are not linked into `~/.pi/agent/extensions` |
| `$OVERLAY/zed/settings.d/*.json` | `bin/dotfiles-sync` | Deep-merged over `zed/settings.json` |
| `$OVERLAY/hooks/pi-auth` | `hypr/agent-layout`, `bin/solve-mr-comments` | Executable: `check` (exit 0 = valid), `login [--force]` (interactive), `env` (prints `export` lines) |
| `~/.pi/agent/{extensions,agents}/*` | pi | Real dirs; `dotfiles-sync` links this repo's entries and prunes dangling links, overlays link their own |
| `~/.pi/agent/models.json` | pi | Not shipped here; an overlay may provide one |
| `~/.pi/agent/mcp-profiles/*.json` | `mcp-profiles` extension | `--mcp-profile <name>` adds that file's `mcpServers` for the run |
| `~/.pi/agent/subagent.json` | `subagent` extension | `{ "defaultModel": "p/m", "agentModels": { "<agent>": "p/m" } }` |
| `~/.pi/agent/review.d/*.md` | `/review-branch-code` prompt | Global review add-ons: slug, precheck, extra passes, aggregation rules |
| `pi.events` `subagent:transports` | `subagent` extension | At session start, `register({ param, schema, label, createChild, durable })` adds a way to run subagents |
| `pi.events` `auto-retry:{scheduled,retrying,reset}` | `auto-retry` extension | `scheduled` carries `waitFor(promise)` so a listener can prepare the retried request |
| `~/.local/share/dotfiles` | `home-manager/` | Link to this checkout, made by `install.sh`, so the checkout can live anywhere |

Nix: this flake is installed as its own profile element, found by URL rather than name. An overlay
installs its own flake as a separate element; the two must never ship the same file.

## Script conventions (bin/)

All bash scripts in `bin/` follow this exact pattern. New scripts must match it:

```bash
#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}$*${NC}"; }
success() { echo -e "${GREEN}$*${NC}"; }
warn()    { echo -e "${YELLOW}$*${NC}"; }
error()   { echo -e "${RED}Error: $*${NC}" >&2; }

check_dependency() {
    if ! command -v "$1" &>/dev/null; then
        error "'$1' is not installed. Please install it first."
        exit 1
    fi
}

show_help() {
    cat <<'EOF'
Usage: script-name [OPTIONS]
...
EOF
}

# Argument parsing
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h) show_help; exit 0 ;;
        *)         error "Unknown option: $1"; show_help; exit 1 ;;
    esac
done
```

Key rules:
- File names use **kebab-case** (e.g. `solve-mr-comments`, `fix-ci`)
- Each script is **self-contained** -- re-define colors and helpers locally, no shared library
- Use `set -euo pipefail` always
- Include `show_help()` with a heredoc describing usage, options, and examples
- Use `check_dependency()` to validate prerequisites early
- Parse arguments with `while [[ $# -gt 0 ]]; case` (not getopts)

## Adding new configs

1. Create a directory named after the tool (lowercase)
2. Place config files inside it
3. Add `ln -sf` commands to `install.sh` under the symlinks section
4. Create target directories with `mkdir -p` in `install.sh` if needed

## Adding new bin/ scripts

1. Create the script in `bin/` following the conventions above
2. Make it executable (`chmod +x`)
3. Add a symlink line to `install.sh`: `ln -sf "$(pwd)/bin/script-name" ~/.local/bin/script-name`
4. If the script is complex, add documentation in `docs/script-name.md`

## Package management

- **Nix flake** (`flake.nix`): system tools -- add packages to the `paths` list
- **install.sh**: curl-installed tools (nvm, rustup, pyenv, Docker) -- add new blocks following the existing `if ! command_exists` pattern
- No Brewfile, no Ansible, no Makefile. Linux-only.

## Shell config (bash/bashrc)

Single-file bashrc. Additions go in the appropriate section:
- **Environment variables**: after the existing exports (around line 119+)
- **Aliases**: in the aliases block (around line 148+)
- **Functions**: after the existing functions (around line 164+)

No split files for aliases/functions/exports -- everything stays in one bashrc. The only other
shell files are overlay drop-ins in `$OVERLAY/bashrc.d/`, which live in the overlay repo.

## Commit style

Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.

## Key tools and dependencies

| Tool | Purpose |
|------|---------|
| `glab` / `gh` | GitLab / GitHub CLIs (used by bin/ scripts and review prompts) |
| `pi` | AI coding agent (packaged in `nix/pi.nix`) |
| `gstuff` | Optional stacked branch/MR tool; the `btw` extension uses it when installed |
| `fzf` | Fuzzy finder (interactive selection) |
| `jq` | JSON processing |
| `nix` | Package manager |

## Things to avoid

- Do not add macOS-specific logic -- this is a Linux-only setup
- Do not introduce a symlink manager (stow, chezmoi) -- raw `ln -sf` in `install.sh` is intentional
- Do not split bashrc into multiple files
- Do not add employer-internal content; add a generic overlay hook instead
- Do not add shared shell libraries -- scripts stay self-contained
- Do not commit secrets, tokens, or API keys
