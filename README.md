# dotfiles

Linux (x86_64) workstation setup: i3 and Hyprland (hy3), Kitty, Zed, tmux, and the
[pi](https://pi.dev) coding agent with local extensions. System packages come from a Nix flake,
and config files are plain symlinks made by `install.sh`.

```bash
git clone https://github.com/LuisDuarte1/dotfiles ~/dotfiles
cd ~/dotfiles && ./install.sh
```

`install.sh` installs Nix if needed, installs the flake into your Nix profile, installs a few
non-Nix tools (nvm, rustup, pyenv, Docker), links configs, and enables the user timers. Re-run it
at any time. `dotfiles-sync` re-links pi resources and re-renders the config files that tools
rewrite at runtime.

## Highlights

- `pi/extensions/`: subagents with a live inspector, background jobs (`bg_do`), `/btw` side
  sessions in git worktrees, auto-retry, MCP profiles, provider-native web search.
- `hypr/agent-layout/`: snapshots and restores pi agent terminals together with their hy3 layout.
- `nix/`: reproducible builds of pi and several pi extensions, with small patches.
- `bin/`: review helpers for GitHub/GitLab (`solve-mr-comments`, `update-pr-description`, …).

## Overlays

Machine- or employer-specific config belongs in a separate repo that layers on top of this one:
shell drop-ins, settings fragments, an auth hook, extra pi extensions/agents. The hooks are listed
in [AGENTS.md](AGENTS.md#overlay-hooks).
