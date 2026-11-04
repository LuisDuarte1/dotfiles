{
  config,
  lib,
  pkgs,
  hyprlandPackage,
  hy3Package,
  xdphPackage,
  hyprlandRev,
  hy3Rev,
  ...
}:
let
  # install.sh points this at the checkout, so the TS and i3 config are read live from wherever
  # the repo lives (standalone, or as a submodule of an overlay repo).
  dotfilesDir = "${config.home.homeDirectory}/.local/share/dotfiles";
  i3Config = "${dotfilesDir}/i3/config";
  i3Hash = "85d9d62c450df0ca194e4d772a4f7dc7203dcf7ea9c4f5f8a1f7cceac04cdbd7";
  xmodmap = "${config.home.homeDirectory}/.Xmodmap";
  xmodmapHash = "8fc6757a31b37a3d38b8e1946a8769bfc38bb991f865ab65f53e2f8449fa9ef1";
  chromeLauncher = pkgs.writeShellScript "google-chrome-session" ''
    if [[ "''${XDG_SESSION_TYPE:-}" == "wayland" && -n "''${WAYLAND_DISPLAY:-}" ]]; then
      exec /usr/bin/google-chrome-stable \
        --ozone-platform=wayland \
        --enable-features=WebRtcPipeWireCamera,WebRtcPipeWireCapturer \
        "$@"
    fi
    exec /usr/bin/google-chrome-stable "$@"
  '';
  chromePackage = pkgs.runCommand "google-chrome-session-wrapper" { } ''
    mkdir -p "$out/bin"
    ln -s ${chromeLauncher} "$out/bin/google-chrome"
    ln -s ${chromeLauncher} "$out/bin/google-chrome-stable"
  '';
  # Runs the TS straight from the checkout so fixes apply without a switch; Node is pinned here
  # because the nvm node on PATH is absent from systemd units and rofi-launched processes.
  agentLayout = pkgs.writeShellScriptBin "agent-layout" ''
    export PATH=${lib.makeBinPath [ hyprlandPackage pkgs.libnotify pkgs.rofi ]}:$PATH:/usr/bin
    exec ${pkgs.nodejs}/bin/node ${dotfilesDir}/hypr/agent-layout/main.ts "$@"
  '';
  portalsConf = pkgs.writeText "hyprland-portals.conf" ''
    [preferred]
    default=hyprland;gtk
    org.freedesktop.impl.portal.FileChooser=gtk
  '';
  # Ubuntu's xdg-desktop-portal 1.18 scans a single dir (XDG_DESKTOP_PORTAL_DIR replaces
  # /usr/share entirely) and, in that test mode, also reads portals.conf from it alone.
  portalsDir = pkgs.runCommand "xdg-desktop-portal-dir" { } ''
    mkdir -p "$out"
    ln -s ${portalsConf} "$out/hyprland-portals.conf"
    ln -s ${xdphPackage}/share/xdg-desktop-portal/portals/hyprland.portal "$out/hyprland.portal"
    for portal in gtk gnome gnome-keyring; do
      ln -s "/usr/share/xdg-desktop-portal/portals/$portal.portal" "$out/$portal.portal"
    done
  '';
in
{
  home = {
    username = "lduarte";
    homeDirectory = "/home/lduarte";
    stateVersion = "26.11";
    packages = [
      agentLayout
      chromePackage
      hyprlandPackage
    ] ++ (with pkgs; [
      grim
      # Ubuntu's kitty 0.32 sends Enter/Tab/Backspace twice to kitty-keyboard-protocol apps
      # (kitty#7136); /usr/bin/kitty stays for the i3 fallback.
      kitty
      libnotify
      nwg-displays
      rofi
      slurp
      swayidle
      waybar
      wev
      wl-clipboard
      xwayland
    ]);
    checks = [
      (pkgs.runCommand "hyprland-source-checks" {
        nativeBuildInputs = [
          pkgs.libxkbcommon
          pkgs.lua5_5
        ];
      } ''
        xkbcli compile-keymap --from-xkb ${../hypr/keymap.xkb} >/dev/null
        luac -p ${../hypr/hyprland.lua}
        luac -p ${../hypr/rescue.lua}
        bash -n ${chromeLauncher}
        touch "$out"
      '')
      (pkgs.runCommand "agent-layout-checks" { nativeBuildInputs = [ pkgs.nodejs ]; } ''
        node --test ${../hypr/agent-layout}/*.test.ts ${../pi/extensions/session-beacon}/*.test.ts
        touch "$out"
      '')
    ];
    activation.verifyI3Fallback = lib.hm.dag.entryBefore [ "writeBoundary" ] ''
      actual_i3_hash=$(sha256sum ${lib.escapeShellArg i3Config} | cut -d' ' -f1)
      actual_i3_target=$(readlink -f "$HOME/.config/i3/config")
      expected_i3_target=$(readlink -f ${lib.escapeShellArg i3Config})
      actual_xmodmap_hash=$(sha256sum ${lib.escapeShellArg xmodmap} | cut -d' ' -f1)
      available_bytes=$(df --output=avail --block-size=1 / | tail -n 1)

      if (( available_bytes < 21474836480 )); then
        errorEcho "Refusing activation with less than 20 GiB free"
        exit 1
      fi
      if [[ "$(/usr/bin/prime-select query)" != "on-demand" ]]; then
        errorEcho "Refusing activation because PRIME is not in on-demand mode"
        exit 1
      fi
      for host_binary in \
        /usr/bin/dunst \
        /usr/bin/kitty \
        /usr/bin/nm-applet \
        /usr/bin/pactl \
        /usr/bin/swaylock \
        /usr/lib/policykit-1-gnome/polkit-gnome-authentication-agent-1; do
        if [[ ! -x "$host_binary" ]]; then
          errorEcho "Refusing activation because $host_binary is unavailable"
          exit 1
        fi
      done
      if [[ "$actual_i3_hash" != ${lib.escapeShellArg i3Hash} ]]; then
        errorEcho "Refusing activation because i3/config changed"
        exit 1
      fi
      if [[ "$actual_i3_target" != "$expected_i3_target" ]]; then
        errorEcho "Refusing activation because the i3 config symlink changed"
        exit 1
      fi
      if [[ "$actual_xmodmap_hash" != ${lib.escapeShellArg xmodmapHash} ]]; then
        errorEcho "Refusing activation because ~/.Xmodmap changed"
        exit 1
      fi
    '';
  };

  programs.home-manager.enable = true;
  xdg.enable = true;

  targets.genericLinux = {
    enable = true;
    gpu = {
      enable = true;
      packages = pkgs;
      nvidia.enable = false;
    };
  };

  wayland.windowManager.hyprland = {
    enable = true;
    package = null;
    portalPackage = null;
    configType = "lua";
    plugins = [ hy3Package ];
    xwayland.enable = true;
    systemd = {
      enable = true;
      enableXdgAutostart = false;
    };
    extraConfig = builtins.readFile ../hypr/hyprland.lua;
  };

  xdg.configFile = {
    "hypr/keymap.xkb".source = ../hypr/keymap.xkb;
    "hypr/rescue.lua".source = ../hypr/rescue.lua;
    "waybar/config.jsonc".source = ../waybar/config.jsonc;
    "waybar/style.css".source = ../waybar/style.css;
    "swaylock/config".source = ../swaylock/config;
    "systemd/user/xdg-desktop-portal.service.d/portals-dir.conf".text = ''
      [Service]
      Environment=XDG_DESKTOP_PORTAL_DIR=${portalsDir}
    '';
  };

  xdg.dataFile."applications/google-chrome.desktop".text = ''
    [Desktop Entry]
    Version=1.0
    Name=Google Chrome
    GenericName=Web Browser
    Comment=Access the Internet
    Exec=google-chrome %U
    Terminal=false
    Icon=google-chrome
    Type=Application
    Categories=Network;WebBrowser;
    MimeType=application/pdf;application/rdf+xml;application/rss+xml;application/xhtml+xml;application/xhtml_xml;application/xml;image/gif;image/jpeg;image/png;image/webp;text/html;text/xml;x-scheme-handler/http;x-scheme-handler/https;
    Actions=new-window;new-private-window;
    StartupNotify=true

    [Desktop Action new-window]
    Name=New Window
    Exec=google-chrome

    [Desktop Action new-private-window]
    Name=New Incognito Window
    Exec=google-chrome --incognito
  '';

  xdg.dataFile."applications/restore-agents.desktop".text = ''
    [Desktop Entry]
    Type=Application
    Name=Restore Agents
    Comment=Reopen the pi agent terminals of the previous Hyprland session in their old layout
    Exec=${agentLayout}/bin/agent-layout restore
    Icon=view-restore
    Terminal=false
    Categories=Utility;
  '';

  xdg.dataFile."applications/restore-agents-pick.desktop".text = ''
    [Desktop Entry]
    Type=Application
    Name=Restore Agents (choose snapshot)
    Comment=Pick which stored snapshot of pi agent terminals to reopen
    Exec=${agentLayout}/bin/agent-layout restore --pick
    Icon=view-restore
    Terminal=false
    Categories=Utility;
  '';

  systemd.user.timers.agent-layout-snapshot = {
    Unit = {
      Description = "Periodic snapshot of pi agent terminals for Restore Agents";
      PartOf = [ "hyprland-session.target" ];
    };
    Timer = {
      OnActiveSec = "1min";
      OnUnitActiveSec = "1min";
      AccuracySec = "10s";
    };
    Install.WantedBy = [ "hyprland-session.target" ];
  };

  systemd.user.services = {
    agent-layout-snapshot = {
      Unit = {
        Description = "Snapshot pi agent terminals, workspaces and monitors";
        PartOf = [ "hyprland-session.target" ];
      };
      Service = {
        Type = "oneshot";
        ExecStart = "${agentLayout}/bin/agent-layout snapshot --quiet";
      };
    };
    hyprland-waybar = {
      Unit = {
        Description = "Waybar for Hyprland";
        PartOf = [ "hyprland-session.target" ];
      };
      Service = {
        ExecStart = "${pkgs.waybar}/bin/waybar";
        Restart = "on-failure";
      };
      Install.WantedBy = [ "hyprland-session.target" ];
    };
    hyprland-dunst = {
      Unit = {
        Description = "Dunst for Hyprland";
        PartOf = [ "hyprland-session.target" ];
      };
      Service.ExecStart = "/usr/bin/dunst";
      Install.WantedBy = [ "hyprland-session.target" ];
    };
    hyprland-network-manager-applet = {
      Unit = {
        Description = "NetworkManager applet for Hyprland";
        PartOf = [ "hyprland-session.target" ];
      };
      Service.ExecStart = "/usr/bin/nm-applet";
      Install.WantedBy = [ "hyprland-session.target" ];
    };
    hyprland-xdg-portal = {
      Unit = {
        Description = "xdg-desktop-portal-hyprland backend";
        PartOf = [ "hyprland-session.target" ];
      };
      Service = {
        Type = "dbus";
        BusName = "org.freedesktop.impl.portal.desktop.hyprland";
        ExecStart = "${xdphPackage}/libexec/xdg-desktop-portal-hyprland";
        Restart = "on-failure";
      };
      Install.WantedBy = [ "hyprland-session.target" ];
    };
    # The host portal daemon only enumerates backends at startup, so it must restart
    # after the Hyprland backend is up or ScreenCast never appears in a fresh session.
    hyprland-portal-reload = {
      Unit = {
        Description = "Restart host xdg-desktop-portal after the Hyprland backend";
        After = [ "hyprland-xdg-portal.service" ];
        PartOf = [ "hyprland-session.target" ];
      };
      Service = {
        Type = "oneshot";
        # sd-switch re-runs dead oneshots on every switch, and a portal restart kills
        # live screencasts, so stay resident and skip when ScreenCast is already up.
        RemainAfterExit = true;
        ExecStart = "/bin/sh -c 'busctl --user introspect org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop 2>/dev/null | grep -q ScreenCast || /usr/bin/systemctl --user try-restart xdg-desktop-portal.service'";
      };
      Install.WantedBy = [ "hyprland-session.target" ];
    };
    hyprland-polkit-agent = {
      Unit = {
        Description = "PolicyKit agent for Hyprland";
        PartOf = [ "hyprland-session.target" ];
      };
      Service.ExecStart = "/usr/lib/policykit-1-gnome/polkit-gnome-authentication-agent-1";
      Install.WantedBy = [ "hyprland-session.target" ];
    };
  };

  assertions = [
    {
      assertion = hyprlandRev == "36b2e0cfe0c6094dbc47bd42a437431315bb3087";
      message = "The Hyprland input must remain pinned to v0.56.0.";
    }
    {
      assertion = hy3Rev == "42b7ed8fd9aefd3f36e5f617afd5071245c67853";
      message = "The hy3 input must remain pinned to hl0.56.0.1.";
    }
    {
      assertion = config.wayland.windowManager.hyprland.finalPackage == null;
      message = "Hyprland must be installed explicitly to prevent hot plugin reloads during upgrades.";
    }
  ];
}
