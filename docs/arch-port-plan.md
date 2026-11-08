# Arch port plan for `LuisDuarte1/dotfiles`

Status: the Arch/Hyprland port is still plan-only. The pi-only work in [section 13](#13-pi-only-phase-current-work)
has been implemented, built, installed into the Nix profile, and synced into `~/.pi/agent`.
Checkout: `~/dotfiles` (private repo, branch `arch-port`, based on `main` @ `26f4d34`).
Date: 2026-11-08.

## 1. What is here

The repo is a Linux workstation setup built around:

| Area | Contents |
|---|---|
| `install.sh` | Installs Nix, installs the flake into the Nix profile, installs non-Nix tools, creates symlinks, installs a GDM session, oomd drop-ins, and the `pi-update` timer. |
| `flake.nix` | `nixpkgs-unstable`, pinned Home Manager, pinned Hyprland 0.56.0 + hy3, pi and pi extensions, CLI tools. |
| `home-manager/hyprland.nix` | Home Manager module for the Hyprland session, waybar/swaylock configs, agent-layout, systemd user services, and Ubuntu-specific safety gates. |
| `hypr/` | Lua Hyprland config, rescue config, host session wrapper, `agent-layout` TypeScript tools. |
| `pi/` | pi settings, MCP config, agents, prompts, and many local extensions. |
| `bash/`, `tmux/`, `i3/`, `zed/`, `git/`, `systemd/`, `bin/` | Shell, tmux, i3 fallback, Zed, global gitignore, user units, and review/update scripts. |
| `docs/` | Hyprland rollout and script docs. |

The repo's design is: **Nix owns CLI/user packages and Home Manager config; raw `ln -sf` owns a few dotfiles; the host OS owns the compositor components on Ubuntu**. On Arch we can keep that shape while changing the host-specific parts.

## 2. Current machine (facts gathered)

| Item | Value |
|---|---|
| OS | Arch Linux rolling, kernel `7.1.8-arch1-3`, x86_64 |
| User / home | `luisd` / `/home/luisd` (repo assumes `lduarte` / `/home/lduarte`) |
| Session | GDM 50.2 active; Hyprland 0.56.2 running as a Wayland session |
| GPU | NVIDIA RTX 4070 (`nvidia` 610.57.04) + AMD Phoenix1 iGPU; current Hyprland renderer is **NVIDIA** |
| Monitors | All DRM connectors disconnected; Hyprland exposes `FALLBACK` 1920x1080@60 |
| Nix | 2.33.0, flakes enabled, `trusted-users = root luisd`, `~/.nix-profile` exists |
| Home Manager | **not installed** |
| Existing configs | `~/.bashrc`, `~/.bash_profile`, `~/.config/hypr/hyprland.conf`, `~/.config/i3/config`, `~/.config/zed/settings.json`, `~/.config/kitty/kitty.conf`, `~/.pi/agent/*` |
| Missing desktop tools | `tmux`, `fzf`, `glab`, `swaylock`, `dunst`, `polkit-gnome` agent, `nwg-displays`, `swayidle`, `dex`, `xautolock`, `flameshot` |
| Installed desktop tools | `hyprland`, `waybar`, `rofi`, `kitty`, `grim`, `slurp`, `wl-clipboard`, `nm-applet`, `pipewire-pulse`, `gh`, `google-chrome-stable`, Zed (`zeditor`) |
| Existing pi | npm install at `~/.local/bin/pi` (v1.4.0), auth only for `opencode-go`, custom `models.json` |
| Disk | 52 GiB free on `/` |

Note: the running Hyprland is **system** Hyprland 0.56.2, not a Nix-pinned Hyprland. The repo pins Hyprland 0.56.0 + hy3 `hl0.56.0.1`. That mismatch is the single most important design decision.

## 3. Ubuntu assumptions found in the repo

| Repo assumption | Where | Arch equivalent |
|---|---|---|
| `sudo apt-get install swaylock` | `install.sh` | `sudo pacman -S --needed swaylock` |
| Docker via `get.docker.com` | `install.sh` | `pacman -S docker docker-compose`, then `systemctl enable --now docker` |
| pyenv via `pyenv.run` | `install.sh` | `pacman -S pyenv` (or keep installer); bashrc must guard it |
| User `lduarte`, home `/home/lduarte` | `flake.nix`, `home-manager/hyprland.nix` | `luisd`, `/home/luisd` |
| `prime-select query == on-demand` gate | HM activation | Remove; no `prime-select` on Arch |
| Intel-only Mesa GPU bridge (`nvidia.enable = false`) | HM `targets.genericLinux.gpu` | Not needed if the Nix compositor is dropped; otherwise needs NVIDIA host-driver bridge (`version` + `sha256`) |
| `/usr/lib/policykit-1-gnome/...` | HM polkit service + activation gate | `/usr/lib/polkit-gnome/polkit-gnome-authentication-agent-1` |
| `/usr/bin/{dunst,kitty,nm-applet,pactl,swaylock}` | HM activation gate/services | Same paths on Arch (install `dunst`/`swaylock`) |
| Ubuntu xdg-desktop-portal 1.18 `XDG_DESKTOP_PORTAL_DIR` workaround | HM `portalsDir` + systemd drop-in | Remove. Arch has xdg-desktop-portal 1.22.1; `XDG_DESKTOP_PORTAL_DIR` is not supported, and `/usr/share/xdg-desktop-portal/hyprland-portals.conf` already configures hyprland+gtk |
| i3 config hash + `~/.Xmodmap` hash gate | HM activation | i3 hash already matches repo (`85d9d62…`); drop the Xmodmap gate |
| `sudo apt install swaylock` docs | `docs/hyprland.md` | Rewrite for pacman/Arch |
| `systemd-oomd` assumed enabled | `install.sh` drop-ins | Arch ships systemd-oomd but disables it; drop-ins are compatible, enable only if wanted |
| `DISPLAY=:1` in `pi-update.service` | `systemd/pi-update.service` | Remove; Wayland session uses DBus |
| Intel IPU6 `v4l2-relayd`/`icamerasrc` | `bin/reset-camera` | Skip linking on this machine |
| Laptop-specific monitors `DP-3`, `eDP-1` | `hypr/hyprland.lua`, `rescue.lua` | Remove hardcoded entries; keep wildcard / use `nwg-displays` |
| Laptop touchpad device names `ven_27c6:…` | Hypr Lua | Remove; this workstation has different input devices |
| Debian snippets (`lesspipe`, `/etc/debian_chroot`) | `bash/bashrc` | Harmless; leave or clean |
| Unguarded `eval "$(pyenv init - bash)"` | `bash/bashrc` | Guard with `command -v pyenv` |
| pi default `anthropic/claude-opus-5-5` | `pi/settings.json` | Local auth is `opencode-go` only; override via overlay settings fragment |
| Local npm pi v1.4.0 shadows Nix pi v1.5.0 | `~/.local/bin/pi` vs Nix profile | Remove/rename the npm shim or ensure Nix profile wins in `PATH` |

## 4. Recommended strategy

### Option B (recommended): Arch-native desktop, repo-managed configs + Nix CLI

Keep the working Arch stack:

- System **Hyprland 0.56.2 + hy3 built for that exact version** via `hyprpm` (tag `hl0.56.0.1`).
- System GDM, system xdg-desktop-portal-hyprland, system NVIDIA/Mesa, system watchers.
- Pacman for all GUI/desktop tools: waybar, rofi, kitty, dunst, swaylock, polkit-gnome, nwg-displays, grim/slurp/wl-clipboard, tmux, fzf, glab, dex, flameshot.
- Home Manager only for generated configs, `agent-layout`, the Chrome wrapper, systemd user services, and the safety checks.
- Nix flake only for CLI/user tooling: pi, pi extensions, Go, Bun, Node, jq, pspg, xonsh, glab, Helm, hunk, chrome-devtools-mcp.

Why:

- No `/run/opengl-driver` or NVIDIA runfile download is needed.
- No Nix-built Hyprland competing with the running compositor, and no 0.56.0/0.56.2 plugin ABI risk.
- The machine already has a working Hyprland + GDM + portal stack; we do not replace it.
- `hyprpm` compiles hy3 against the installed Hyprland headers, which is the most reliable path for 0.56.2.

Trade-off: this is a fork of the repo's "Nix owns Hyprland" design. Keep the changes on the `arch-port` branch and document them for future merges.

### Option A (faithful fallback): Nix-pinned Hyprland 0.56.0 + hy3

Use the repo's HM `hyprlandPackage`/`hy3Package` and `~/.nix-profile/bin/start-hyprland`, and adapt the GPU bridge:

- `targets.genericLinux.gpu.nvidia.enable = true`
- `targets.genericLinux.gpu.nvidia.version = "610.57.04"` (must match host)
- `targets.genericLinux.gpu.nvidia.sha256 = "sha256-…"` (prefetch the NVIDIA `.run`)
- Run the generated `non-nixos-gpu-setup` helper with sudo once; verify `/run/opengl-driver`.
- Keep the pinned Hyprland/hy3.
- Remove only the Ubuntu gates and paths.

Use this only if Option B's hy3 build fails, or if reproducibility of the compositor matters more than the risk/effort. It costs a large Hyprland build, a host-driver bridge, and another full session to debug.

## 5. Planned repository edits (Option B)

### 5.1 `flake.nix`

- Remove `hyprland` and `hy3` inputs.
- Change Home Manager's nixpkgs follow to the top-level `nixpkgs`.
- Rename `homeConfigurations.lduarte` → `homeConfigurations.luisd`.
- Use `pkgs` directly for the HM config; drop `graphicalPkgs`, `hyprlandPackage`, `hy3Package`, `xdphPackage`, `hyprlandRev`, `hy3Rev`.
- Keep `packages.${system}.default` (CLI tools + pi + extensions) and `pi-coding-agent`.

Sketch:

```nix
inputs = {
  nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  hunk = { url = "github:modem-dev/hunk"; inputs.nixpkgs.follows = "nixpkgs"; };
  home-manager = {
    url = "github:nix-community/home-manager/7690127e7e1c90ab1dcaff525d0dafbeb7e14182";
    inputs.nixpkgs.follows = "nixpkgs";
  };
};
# ...
homeConfigurations.luisd = home-manager.lib.homeManagerConfiguration {
  pkgs = pkgs;
  modules = [ ./home-manager/hyprland.nix ];
};
```

Then run `nix flake lock` (not `nix flake update`) to prune the removed inputs while preserving versions.

### 5.2 `home-manager/hyprland.nix`

- `home.username = "luisd"`, `home.homeDirectory = "/home/luisd"`.
- Remove `xmodmap`, `xmodmapHash`, the `prime-select` check, the `.Xmodmap` check, and the `portalsConf`/`portalsDir` workaround.
- Keep the i3 hash check (repo i3 config hashes to `85d9d62…`, exactly what the module expects) or replace it with a softer warning. Recommend keeping it until the session is stable.
- Remove the `targets.genericLinux.gpu` block; keep `targets.genericLinux.enable = true` only if Nix CLI tools need its env integration (they generally do).
- `home.packages`: keep `agentLayout` and `chromePackage`; remove `hyprlandPackage`, `grim`, `libnotify`, `nwg-displays`, `rofi`, `slurp`, `swayidle`, `waybar`, `wev`, `wl-clipboard`, `xwayland` (system packages provide them).
- `agentLayout`: build the wrapper with `pkgs.nodejs` only and `PATH=/usr/bin:/usr/local/bin`, so it uses system `hyprctl`, `rofi`, and `notify-send`.
- `wayland.windowManager.hyprland`:
  - `package = null;`
  - `portalPackage = null;`
  - `plugins = [ "/home/luisd/.local/lib/hyprland/hy3.so" ];` **only after hy3 is built**; otherwise `[]` and run dwindle temporarily.
  - keep `configType = "lua"`, `xwayland.enable = true`, `systemd.enable = true`, `extraConfig = builtins.readFile ../hypr/hyprland.lua`.
- `xdg.configFile`: keep `hypr/keymap.xkb`, `hypr/rescue.lua`, `waybar/config.jsonc`, `waybar/style.css`, `swaylock/config`; remove the `xdg-desktop-portal.service.d/portals-dir.conf`.
- `systemd.user.services`:
  - `hyprland-waybar` → `ExecStart = "/usr/bin/waybar";`
  - `hyprland-dunst` → `/usr/bin/dunst`
  - `hyprland-network-manager-applet` → `/usr/bin/nm-applet`
  - `hyprland-polkit-agent` → `/usr/lib/polkit-gnome/polkit-gnome-authentication-agent-1`
  - **remove** `hyprland-xdg-portal` and `hyprland-portal-reload`; Arch's `xdg-desktop-portal-hyprland` service is already D-Bus activated.
- Keep `hyprland-session.target` + `agent-layout-snapshot.timer`.
- Keep the `finalPackage == null` assertion.
- Update the `checks` to keep `luac -p` and agent-layout tests; `xkbcli compile-keymap` remains useful.

### 5.3 `hypr/host/hyprland-session`

Use the **system** compositor and the HM-generated Lua config:

```sh
#!/bin/sh
set -eu

profile="$HOME/.nix-profile"
session_vars="$profile/etc/profile.d/hm-session-vars.sh"
# HM may use ~/.nix-profile or ~/.local/state/nix/profile; check both.
for candidate in "$session_vars" "$HOME/.local/state/nix/profile/etc/profile.d/hm-session-vars.sh"; do
    if [ -r "$candidate" ]; then
        . "$candidate"
        break
    fi
done
export PATH="$HOME/.nix-profile/bin:/usr/local/bin:/usr/bin:$PATH"
export TERM="${TERM:-xterm-256color}"

case "${1-}" in
    "")
        exec /usr/bin/start-hyprland -- --config "$HOME/.config/hypr/hyprland.lua"
        ;;
    --rescue)
        exec /usr/bin/start-hyprland -- --config "$HOME/.config/hypr/rescue.lua"
        ;;
    *)
        echo "Usage: hyprland-session [--rescue]" >&2
        exit 2
        ;;
esac
```

`start-hyprland` passes arguments after `--` to Hyprland (verified with `/usr/bin/start-hyprland --help`). Keep the repo's NVIDIA env `unset` lines if this machine ever uses PRIME; they are harmless.

### 5.4 `install.sh`

- Add an Arch branch for external dependencies:
  - `swaylock` → `sudo pacman -S --needed --noconfirm swaylock`
  - Docker → `pacman -S docker docker-compose`, `systemctl enable --now docker`, `usermod -aG docker "$USER"`
  - pyenv → `pacman -S pyenv` (or leave the installer; if left, guard bashrc)
  - nvm/rustup can stay as curl installers or move to pacman; rustup is already installed.
- GDM guard:
  - Option B: `[ -x /usr/bin/start-hyprland ] && [ -r "$HOME/.config/hypr/hyprland.lua" ]`
  - also require the HM session vars file (find it in `~/.nix-profile` or `~/.local/state/nix/profile`).
  - remove the `/run/opengl-driver` requirement.
- Rename the installed session files if desired (`/usr/local/bin/hyprland-session-dotfiles`, `/usr/local/share/wayland-sessions/hyprland-dotfiles.desktop`); keeping the existing `hm-hyprland-session` name is fine.
- `systemd-oomd`: install the drop-ins as today, but **do not enable oomd by default**. Add an optional `--enable-oomd` flag that runs `sudo systemctl enable --now systemd-oomd.service`.
- Do **not** link `bin/reset-camera` on Arch (Intel IPU6 only). Add a comment or guard.
- Keep `pi-update.timer` enabling, but only after the Nix profile exists.
- Keep `~/.local/share/dotfiles` symlink and all existing config symlinks.

### 5.5 `bash/bashrc`

- Guard pyenv:
  ```bash
  if command -v pyenv >/dev/null; then
      export PYENV_ROOT="${PYENV_ROOT:-$HOME/.pyenv}"
      [[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
      eval "$(pyenv init - bash)"
      eval "$(pyenv virtualenv-init -)"
  fi
  ```
- Remove the `$HOME/luisd/plugins/shell.bash` line (it expands to `/home/luisd/luisd/...` on this machine).
- Keep the Debian snippets; they are inert on Arch.
- Keep the overlay hook at the end (`$XDG_CONFIG_HOME/dotfiles/bashrc.d/*.sh`).
- Consider GDK scale: the repo exports `GDK_SCALE=2`, but the current fallback display is 1080p. Put `export GDK_SCALE=1` in the local overlay if GTK apps look oversized; do not fork the repo value just for this.

### 5.6 `hypr/hyprland.lua` and `hypr/rescue.lua`

- Remove the hardcoded `DP-3` and `eDP-1` monitor blocks. Keep the wildcard:

  ```lua
  hl.monitor({ output = "", mode = "preferred", position = "auto", scale = "auto" })
  ```

  Use `nwg-displays` later to write `~/.config/hypr/monitors.lua`/`workspaces.lua` (already loaded by the config).
- Remove the `ven_27c6:…` touchpad/mouse device pinning; it is Ubuntu-laptop-specific.
- Keep the `pt` keymap and `keymap.xkb` (local `localectl` already uses `pt`).
- Keep `Super+Ctrl+L` → `/usr/bin/swaylock`; install swaylock.
- Keep the screenshot command (`grim`/`slurp`/`wl-copy` are installed).
- The config already degrades to `dwindle` if `hy3` is nil, so it is safe to start without the plugin.

### 5.7 `systemd/pi-update.service`

- Remove `Environment=DISPLAY=:1`.
- Keep `DBUS_SESSION_BUS_ADDRESS` and the 30-minute timeout.
- Optionally add `Environment=WAYLAND_DISPLAY=wayland-1` if `notify-send` needs it (usually DBus is enough).

### 5.8 Docs

- Rewrite the Ubuntu-specific sections of `docs/hyprland.md` for this machine:
  - GDM + system Hyprland + hyprpm hy3.
  - No `prime-select`, no `/run/opengl-driver`, no apt.
  - Use `nwg-displays` for monitors.
  - Keep the "second VT / i3 fallback / rollback" safety guidance.

## 6. Local overlay (outside the repo)

The repo intentionally supports an overlay under `~/.config/dotfiles`. Create it **before** running `dotfiles-sync`, because the sync renders `~/.pi/agent/settings.json` and `~/.config/zed/settings.json` from the repo.

```
~/.config/dotfiles/
├── bashrc.d/50-local.sh
├── pi/settings.d/10-local.json
├── pi/mcp.d/10-local.json          # optional
└── zed/settings.d/10-local.json
```

Suggested `bashrc.d/50-local.sh`:

```bash
alias code='zeditor'
alias ssh='kitten ssh'
alias clip-to-file='wl-paste >'
export PATH="$HOME/.opencode/bin:$PATH"
export PNPM_HOME="$HOME/.local/share/pnpm"
case ":$PATH:" in *":$PNPM_HOME:"*) ;; *) export PATH="$PNPM_HOME:$PATH" ;; esac
# export GDK_SCALE=1   # uncomment if GTK apps are oversized on the 1080p fallback
```

Suggested `pi/settings.d/10-local.json`:

```json
{
  "defaultProvider": "opencode-go",
  "defaultModel": "deepseek-v4.1-flash",
  "defaultThinkingLevel": "high",
  "enabledModels": ["opencode-go/*", "llama-local/*"],
  "packages": ["npm:@narumitw/pi-chrome-devtools"]
}
```

`pi-web-access` is no longer listed as an npm package: it comes from the Nix derivation and
`dotfiles-sync` appends it. The repo's `web-search` extension must be excluded on this PC because
both extensions register `web_search` (see section 13); `$OVERLAY/pi/extensions.exclude` contains
`web-search`. The local chrome-devtools npm package is kept and the repo's Nix packages are appended.

Suggested `zed/settings.d/10-local.json`:

```json
{
  "project_panel": { "dock": "left" },
  "outline_panel": { "dock": "left" },
  "collaboration_panel": { "dock": "left" },
  "git_panel": { "dock": "left" },
  "agent": { "dock": "right" },
  "buffer_font_size": 15,
  "theme": { "mode": "dark", "light": "Ayu Light", "dark": "Ayu Dark" }
}
```

Also resolve the local pi binary: remove or rename `~/.local/bin/pi` (the npm v1.4.0 shim) after the Nix pi is installed, otherwise it can shadow v1.5.0. Keep `~/.pi/agent/auth.json`, `models.json`, `models-store.json`, and `trust.json`; they are not managed by the repo.

## 7. Pacman bootstrap

Already present: `hyprland`, `waybar`, `rofi`, `kitty`, `grim`, `slurp`, `wl-clipboard`, `nm-applet`, `pipewire-pulse`, `gh`, Chrome, Zed, `polkit`, `mesa`, NVIDIA userspace.

Install:

```bash
sudo pacman -S --needed --noconfirm \
  dunst polkit-gnome swaylock swayidle nwg-displays \
  tmux fzf glab dex flameshot \
  cmake ninja base-devel \
  docker docker-compose pyenv \
  ttf-nerd-fonts-symbols
```

- `xautolock` is not in the official repos; either install it from the AUR (`yay -S xautolock`) or comment out the `xautolock` line in `i3/config`. The i3 fallback also wants `dex`, `i3lock`, `i3status`, `flameshot`, `nm-applet`, `pactl`.
- `docker` and `pyenv` are optional; skip them if not wanted. Docker group changes require a re-login.
- `systemd-oomd` is part of systemd, not a separate package.

## 8. hy3 build (the gating step)

```bash
sudo pacman -S --needed cmake ninja base-devel
hyprpm add https://github.com/outfoxxed/hy3 hl0.56.0.1
hyprpm enable hy3
hyprpm reload
hyprctl plugin list
find "$HOME/.local/share/hyprpm" "$HOME/.cache/hyprpm" -name 'hy3.so' -print
```

Then create a stable path for Home Manager:

```bash
mkdir -p "$HOME/.local/lib/hyprland"
ln -sfn "$(find "$HOME/.local/share/hyprpm" "$HOME/.cache/hyprpm" -name hy3.so | head -n1)" \
  "$HOME/.local/lib/hyprland/hy3.so"
```

Only after this succeeds, set `plugins = [ "/home/luisd/.local/lib/hyprland/hy3.so" ]` in the HM module. If `hyprpm` refuses or fails to compile against 0.56.2, either:

1. start with `plugins = []` and `dwindle` while investigating, or
2. fall back to Option A (Nix-pinned Hyprland 0.56.0 + hy3).

Do not install the AUR `hyprland-plugin-hy3` 0.57.1 package: it targets Hyprland 0.57.1, not the installed 0.56.2.

## 9. Execution phases

### Phase 0 — backup and snapshot (no repo changes)

```bash
backup="$HOME/backups/pre-dotfiles-$(date +%F-%H%M)"
mkdir -p "$backup"
cp -a ~/.bashrc ~/.bash_profile "$backup"/
[ -f ~/.tmux.conf ] && cp -a ~/.tmux.conf "$backup"/
for d in hypr i3 zed systemd/user git; do
  [ -e "$HOME/.config/$d" ] && mkdir -p "$backup/.config/$d" && cp -a "$HOME/.config/$d/." "$backup/.config/$d/"
done
[ -e ~/.pi/agent ] && cp -a ~/.pi/agent "$backup/"
[ -e ~/.local/bin ] && cp -a ~/.local/bin "$backup/"
nix profile list > "$backup/nix-profile-list.txt"
pacman -Qqe > "$backup/pacman-explicit.txt"
```

Snapshot the current Hyprland state and keep a second VT available.

### Phase 1 — patch the branch

Apply the edits from section 5 on `arch-port`. Do not run `install.sh` yet.

Validation before installing anything:

```bash
bash -n install.sh bin/*.sh 2>/dev/null || true
luac -p hypr/hyprland.lua hypr/rescue.lua
Hyprland --verify-config --config "$PWD/hypr/hyprland.lua"
Hyprland --verify-config --config "$PWD/hypr/rescue.lua"
```

### Phase 2 — system prerequisites and hy3

Run the pacman bootstrap from section 7 and the hy3 build from section 8. Verify `hyprctl plugin list` while the current session is running.

### Phase 3 — create the overlay

Create `~/.config/dotfiles/...` from section 6 **before** any sync. Back up the current `~/.pi/agent/settings.json` and `~/.config/zed/settings.json`.

### Phase 4 — Nix flake and Home Manager

```bash
cd ~/dotfiles
nix flake check
nix build .#homeConfigurations.luisd.activationPackage
nix profile install . --accept-flake-config
nix run github:nix-community/home-manager/7690127e7e1c90ab1dcaff525d0dafbeb7e14182 -- \
  switch --flake .#luisd
```

Then verify the profile paths, because Home Manager may use `~/.nix-profile` or `~/.local/state/nix/profile`:

```bash
command -v home-manager
command -v pi
pi --version
find "$HOME/.nix-profile" "$HOME/.local/state/nix" -name hm-session-vars.sh 2>/dev/null
```

If the Nix pi is shadowed by `~/.local/bin/pi`, remove/rename the npm shim now.

### Phase 5 — symlinks and services

```bash
cd ~/dotfiles
./install.sh
dotfiles-sync --help   # idempotence check
dotfiles-sync
systemctl --user daemon-reload
systemctl --user enable --now pi-update.timer
```

`install.sh` will install the GDM session if the guard passes. It writes `/usr/local/bin/hm-hyprland-session` and `/usr/local/share/wayland-sessions/hyprland-hm.desktop` (requires sudo).

### Phase 6 — verify from a new session / second VT

Do not log out of the current working session until the new one is proven. Use a second VT and GDM, or test `hyprland-session` directly from a VT (the repo docs recommend this).

Minimum checks:

- `systemctl --user status hyprland-waybar hyprland-dunst hyprland-polkit-agent`
- `systemctl --user status agent-layout-snapshot.timer`
- `hyprctl plugin list` and `hyprctl getoption general:layout` (expect `hy3`)
- `hyprctl systeminfo` still reports the NVIDIA renderer
- Waybar visible; `Super+Return`, `Super+D`, screenshot, `Super+Ctrl+L`
- Screen sharing: `busctl --user introspect org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop | grep ScreenCast`
- `notify-send test`
- `pi`: starts, `/model` shows `opencode-go/deepseek-v4.1-flash`, extensions load, `/reload`
- `dotfiles-sync` twice: no diff/second-run surprises
- Zed: settings overlay merged, `Ctrl+Shift+C` opens kitty
- `tmux` starts with the repo config
- i3 session still selectable and functional; `i3 -C -c ~/.config/i3/config`
- `pi-update --dry-run`
- `systemctl --user status systemd-oomd` only if deliberately enabled

### Phase 7 — commit the port

Commit the Arch changes on `arch-port` (Conventional Commits style). Keep the plan doc if useful for future merges. Do not push unless asked; `pi-update` auto-commits to this branch.

## 10. Rollback

- Restore `~/.bashrc`, `~/.tmux.conf`, `~/.config/{hypr,i3,zed,systemd/user,git}`, `~/.pi/agent`, `~/.local/bin` from the Phase 0 backup.
- `home-manager switch --rollback` (or `nix run` the same HM rev with `--rollback`).
- `nix profile history` / `nix profile rollback`; remove the dotfiles element with `nix profile remove <element>` if needed.
- Remove `/usr/local/bin/hm-hyprland-session` and `/usr/local/share/wayland-sessions/hyprland-hm.desktop`.
- `systemctl --user disable --now pi-update.timer`.
- If the Hyprland session fails: select i3 in GDM, then remove `~/.config/hypr/hyprland.lua` or disable the plugin (`hyprpm disable hy3`) and re-run HM.
- If the NVIDIA/GPU bridge is involved (Option A only): remove `/run/opengl-driver` and the generated tmpfiles/GC root as documented in the repo's existing `docs/hyprland.md`.

## 11. Risks / unknowns

| Risk | Mitigation |
|---|---|
| hy3 `hl0.56.0.1` fails to compile against 0.56.2 | Build early; fall back to dwindle, AUR `hy3-git`, or Option A |
| HM-generated Lua config assumes Hyprland 0.56.0 Lua API | `--verify-config` first; system 0.56.2 parsed the repo config OK already |
| HM overwrites `~/.pi/agent/settings.json` / Zed settings | Create overlay fragments first; backup |
| Local npm pi shadows Nix pi | Remove/rename `~/.local/bin/pi`; verify `pi --version` |
| pi default model is not authenticated | Overlay `defaultProvider`/`defaultModel` to `opencode-go` |
| Nix GUI binaries need host GL | Option B avoids Nix GUI packages; if any are added later, use `nixGL` or the genericLinux GPU bridge |
| oomd kills the session | Leave oomd disabled by default; install drop-ins only |
| GDM session points at the wrong Hyprland/config | Session wrapper explicitly uses `/usr/bin/start-hyprland -- --config ~/.config/hypr/hyprland.lua`; system `.conf` session remains untouched |
| `pi-update` timer commits unexpectedly | Timer is optional; disable until the port is committed |
| `GDK_SCALE=2` on 1080p | Override to `1` in the local bash overlay |
| Hardcoded monitor/input names | Removed; use wildcard + `nwg-displays` |
| `install.sh` reruns and changes GDM session files | It compares with `cmp` before installing; keep the guard narrow |

## 12. Decisions requested before execution

1. **Option B vs Option A**: keep system Hyprland 0.56.2 + hyprpm hy3 (recommended), or use the repo's pinned Nix Hyprland 0.56.0 + GPU bridge?
2. **Docker / pyenv**: install them now, or leave them out until needed?
3. **systemd-oomd**: keep the drop-ins but leave oomd disabled (recommended), or enable it?
4. **i3 fallback**: keep the repo i3 config and its hash gate, or leave the current local i3 config untouched?
5. **pi packages**: use the repo's Nix extensions + MCP and drop the local npm `pi-web-access`/`@narumitw/pi-chrome-devtools`, or preserve both?
6. **GDK scale**: set `GDK_SCALE=1` for this 1080p fallback, or keep the repo's `2`?
7. **Commit**: commit the Arch port on `arch-port`, or leave the changes uncommitted for review?

## 13. Pi-only phase (current work)

This phase is independent of the Arch/Hyprland port and is safe to land first.

### `pi-web-access` as a Nix derivation

- Added `nix/pi-web-access.nix` (pinned to 0.45.0, matching the currently installed npm package).
- Added `nix/pi-web-access-package-lock.json`, generated from the published tarball with
  `npm install --package-lock-only --omit=dev --ignore-scripts --legacy-peer-deps`.
- Added it to the flake's `pi-extensions` list so `dotfiles-sync` discovers it under
  `~/.nix-profile/lib/pi-extensions/pi-web-access` and appends it to the rendered pi settings.
- Exposed it as `packages.x86_64-linux.pi-web-access` for isolated builds.
- `--legacy-peer-deps` keeps the pi-provided `@earendil-works/*` and `typebox` peers out of the package.

Verified:

```bash
nix build .#pi-web-access
nix build .#default                 # includes pi-web-access
nix build .#pi-coding-agent
/nix/store/.../bin/pi --no-extensions \
  -e ./result/lib/pi-extensions/pi-web-access --offline --list-models
```

### Conflict with the repo's `web-search` extension

`pi/extensions/web-search` and `pi-web-access` both register `web_search`, so pi refuses to load
the second one:

```text
Tool "web_search" conflicts with /home/luisd/dotfiles/pi/extensions/web-search
```

The repo now supports an overlay exclusion hook: `bin/dotfiles-sync` reads
`~/.config/dotfiles/pi/extensions.exclude` (one extension name per line) and skips those links.
On this PC that file contains `web-search`; `pi-web-access` is the web-search provider instead.
The repo's `web-search` remains available for other machines.

### Local pi overlay

Created outside the repo:

- `~/.config/dotfiles/pi/extensions.exclude` → `web-search`
- `~/.config/dotfiles/pi/settings.d/10-local.json` → `opencode-go` /
  `deepseek-v4.1-flash`, opencode-go + llama-local model cycling, and the local
  `@narumitw/pi-chrome-devtools` npm package.

Applied on 2026-11-08:

- `nix profile install git+file:///home/luisd/dotfiles#default` installed the dotfiles profile;
  `~/.nix-profile/lib/pi-extensions/pi-web-access` now exists.
- Renamed the npm shim `~/.local/bin/pi` → `~/.local/bin/pi-npm-1.4.0`; `pi` is now the Nix
  `pi-coding-agent` 1.5.0.
- Backed up `~/.pi/agent` to `~/backups/pre-pi-2026-11-08-073747` and ran `dotfiles-sync` twice.
- Rendered `~/.pi/agent/settings.json` now lists the Nix `pi-web-access` path and not
  `npm:pi-web-access`; `web-search` is excluded; `pi list` and `pi --no-mcp --offline --list-models`
  both load cleanly.
