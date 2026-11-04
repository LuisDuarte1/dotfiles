# Hyprland rollout

This configuration adds a pinned Lua-based Hyprland and hy3 session without
replacing Ubuntu, GDM, the host graphics stack, or i3.

## Safety invariants

- `i3/config` and `~/.config/i3/config` remain unchanged.
- `~/.Xmodmap` remains unchanged for i3.
- Hyprland stays Intel-primary and leaves NVIDIA in PRIME on-demand mode.
- System Manager is not used.
- The GDM entry and GPU bridge are installed only through separate audited steps.
- Automatic locking is not enabled until Ubuntu swaylock is manually tested.

The Home Manager activation refuses to proceed unless the recorded i3 config,
i3 symlink, and Xmodmap hashes still match their migration baselines.

## Build-only validation

At least 20 GiB of free space is required before building or activating. Old
inactive Bazel output bases and its shared build cache were removed, restoring
about 35 GiB free before Home Manager activation.

```bash
df -h /
nix build path:.#homeConfigurations.lduarte.activationPackage
```

This build does not activate Home Manager, install the GPU helper, add a GDM
session, or launch Hyprland. Inspect the result before switching:

```bash
readlink -f result
find result/home-files -maxdepth 4 -type f -o -type l
nix path-info -Sh path:.#homeConfigurations.lduarte.activationPackage
nix eval --raw path:.#homeConfigurations.lduarte.config.targets.genericLinux.gpu.setupPackage
```

The managed paths must not include `.config/i3` or `.Xmodmap`.

## Manual prerequisites

Before activation, complete all of these from the existing Ubuntu installation:

1. Confirm a second VT can be opened and used for recovery.
2. Test an Ubuntu Wayland login with both monitors.
3. Test suspend and resume from that Ubuntu Wayland session.
4. Confirm `prime-select query` still returns `on-demand`.
5. Confirm i3 remains selectable and functional in GDM.

## Home Manager activation

Home Manager generation 1 has been activated successfully. To reproduce the
activation after a configuration change:

```bash
nix run github:nix-community/home-manager/7690127e7e1c90ab1dcaff525d0dafbeb7e14182 -- \
  switch --flake path:.#lduarte
```

Activation installs only user-owned Home Manager files and packages. It prints
the exact root GPU helper path but does not run that helper automatically.

## Intel GPU bridge

The audited helper has been installed. It created the exact Mesa 26.1.5 driver
link, tmpfiles rule, and GC root without changing PRIME mode or the i3 session.
Use these commands to inspect or reapply the current generation:

```bash
gpu_setup=$(nix eval --raw path:.#homeConfigurations.lduarte.config.targets.genericLinux.gpu.setupPackage)
less "$gpu_setup/bin/non-nixos-gpu-setup"
less "$gpu_setup/lib/tmpfiles.d/non-nixos-gpu.conf"
sudo "$gpu_setup/bin/non-nixos-gpu-setup"
```

Verify the resulting bridge and unchanged PRIME mode:

```bash
readlink -f /run/opengl-driver
prime-select query
```

The expected mode is `on-demand`. No NVIDIA compositor variables should be set.
Nix GLX and EGL probes report the Intel Iris Xe renderer. The tmpfiles rule
recreated `/run/opengl-driver` with the exact expected target after reboot.

## VT tests

Run the plugin-free rescue configuration first from a local VT:

```bash
./hypr/host/hyprland-session --rescue
```

The rescue session starts Waybar and Kitty automatically, uses scale 1.5 on
`DP-3`, and scale 2 on `eDP-1`. Its recovery bindings are:

| Binding | Action |
|---|---|
| Super+Return | Open Kitty |
| Super+D | Open Rofi |
| Super+J/K/L/Ç or arrow | Move focus |
| Super+Shift+direction | Move a window |
| Super+1–0 | Switch workspace |
| Super+F | Toggle fullscreen |
| Super+Shift+Space | Toggle floating |
| Super+Shift+Q | Close a window |
| Super+Shift+C | Reload |
| Super+Shift+E | Exit |

After rescue mode exits cleanly, start the normal hy3 session:

```bash
./hypr/host/hyprland-session
```

Confirm Intel rendering, monitor placement, Xwayland, native Wayland clients,
hy3 parent/tab operations, and a clean exit. The rescue and normal configs use
Hyprland's rounded and blurred styling. Hy3 keeps i3-style groups while its
autotiler creates alternating BSP-style nested splits. Window scale/fade
transitions are disabled to avoid stale client buffers, while workspace and
layer animations remain. Global binds ignore client shortcut inhibition. The
session-aware Chrome wrapper selects native Wayland and PipeWire camera capture
under Hyprland while retaining unchanged X11 behavior under i3. Then return to
i3 and verify its bindings.

## Camera recovery

The Intel IPU6 relay can retain stale root-owned Camera HAL state after a CSI
stream failure and return black frames. Run:

```bash
reset-camera
```

The command stops only `v4l2-relayd@default.service`, clears the orphaned `CAM`
shared-memory segment, warms `icamerasrc`, restarts the relay, and verifies that
`/dev/video0` produces non-blank frames. It does not restart Hyprland.

## Display configuration

Press Super+D and choose **Displays Settings** to launch nwg-displays. There is
no dedicated display-settings hotkey. Applying a layout writes mutable
`~/.config/hypr/monitors.lua` and `workspaces.lua` files, which both Hyprland
configs load ahead of their built-in 1.5/2 fallback.

## Agent restore

Press Super+D and choose **Restore Agents** after logging in. It reopens every
pi terminal from the previous Hyprland session on the same monitor and
workspace, rebuilds the hy3 split/tab tree and its ratios, and resumes each
terminal with `pi --session <file>` through the usual `pi` function, so any
auth wrapper still applies. **Restore Agents (choose snapshot)**
opens a rofi list of stored snapshots instead.

How it works:

- `pi/extensions/session-beacon` makes every interactive pi publish its
  session file to `$XDG_RUNTIME_DIR/pi-beacons/<pid>.json`. Running pi
  processes pick it up after `/reload` or a restart.
- `agent-layout-snapshot.timer` (Hyprland only) runs `agent-layout snapshot`
  every minute. It maps each kitty window to its pi through the process tree
  (and tmux clients, for a pi running inside tmux), and stores geometry under
  `~/.local/state/agent-layout/snapshots`. It keeps the newest 5, plus the
  newest snapshot of the previous session so it survives rearranging before
  a restore.
- `agent-layout restore` uses the newest snapshot with agents from a previous
  Hyprland instance. Sessions already open are skipped. A session still alive
  in a detached `pi-*` tmux session is stopped and relaunched. Terminals not
  running pi, other apps, and pi sessions never prompted are not restored.

```bash
agent-layout list
agent-layout restore --dry-run
agent-layout restore --snapshot ~/.local/state/agent-layout/snapshots/<file>.json
```

The log is `~/.local/state/agent-layout/restore.log`. Keep hands off the mouse
while it runs; it briefly focuses each restored workspace.

## Keyboard validation

The Wayland keymap keeps Portuguese `pt` and translates the Xmodmap override for
`<AE12>` to `less greater less greater`.

```bash
wev
```

Test `<AE12>` unshifted and shifted, `ccedilla`, `<LSGT>`, media keys, and the
Super+Ctrl+less/greater workspace-output bindings in native Wayland and Xwayland
applications. Workspace number-row binds use physical keycodes so Shift does not
turn `1`–`0` into Portuguese punctuation before matching.

## Locking gate

Ubuntu swaylock is intentionally not installed or started by Home Manager. Once
rescue and normal compositor tests pass:

```bash
sudo apt install swaylock
swaylock -f
```

Test successful and failed authentication repeatedly while a second VT remains
available. Only then add the Hyprland-bound swayidle service with a 600-second
timeout and lock-before-sleep behavior.

## Optional GDM session

Do not install this until VT, locking, suspend, and i3 fallback tests pass:

```bash
./install.sh
```

The guarded installer block only adds the session after Home Manager and the GPU
bridge are ready. It does not restart GDM. Log out normally and choose
`Hyprland (Home Manager)` from the session menu.

## Rollback

Select i3 in GDM for compositor, plugin, or keymap failures. Home Manager can be
rolled back independently:

```bash
home-manager generations
home-manager switch --rollback
```

Remove only the optional GDM files if that integration fails:

```bash
sudo rm -f /usr/local/bin/hm-hyprland-session
sudo rm -f /usr/local/share/wayland-sessions/hyprland-hm.desktop
```

Removing the GPU bridge does not remove Ubuntu drivers:

```bash
sudo rm -f /run/opengl-driver
sudo rm -f /etc/tmpfiles.d/non-nixos-gpu.conf
sudo rm -f /nix/var/nix/gcroots/non-nixos-gpu.conf
```
