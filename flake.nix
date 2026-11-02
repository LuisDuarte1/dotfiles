{
  description = "Dotfiles dependencies";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    hunk = {
      url = "github:modem-dev/hunk";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager/7690127e7e1c90ab1dcaff525d0dafbeb7e14182";
      inputs.nixpkgs.follows = "hyprland/nixpkgs";
    };
    hyprland.url = "github:hyprwm/Hyprland/36b2e0cfe0c6094dbc47bd42a437431315bb3087";
    hy3 = {
      url = "github:outfoxxed/hy3/42b7ed8fd9aefd3f36e5f617afd5071245c67853";
      inputs.hyprland.follows = "hyprland";
    };
  };

  outputs = { self, nixpkgs, hunk, home-manager, hyprland, hy3 }:
    let
      system = "x86_64-linux";

      graphicalPkgs = hyprland.inputs.nixpkgs.legacyPackages.${system};
      hyprlandPackage = hyprland.packages.${system}.hyprland;
      hy3Package = hy3.packages.${system}.hy3;

      pkgs = nixpkgs.legacyPackages.${system};

      pi-coding-agent = pkgs.callPackage ./nix/pi.nix { };

      chrome-devtools-mcp = pkgs.callPackage ./nix/chrome-devtools-mcp.nix { };

      # Factory for npm-published pi extensions. Each per-extension nix file
      # is a thin wrapper that calls this factory with pname/hashes/lockfile.
      piExtension = pkgs.callPackage ./nix/pi-extension.nix { };

      pi-extensions = [
        (pkgs.callPackage ./nix/pi-autoresearch.nix { inherit piExtension; })
        (pkgs.callPackage ./nix/plannotator.nix { inherit piExtension; })
        (pkgs.callPackage ./nix/pi-tldraw.nix { inherit piExtension; })
        (pkgs.callPackage ./nix/sleep-guard.nix { })
      ];
    in
    {
      homeConfigurations.lduarte = home-manager.lib.homeManagerConfiguration {
        pkgs = graphicalPkgs;
        extraSpecialArgs = {
          inherit hyprlandPackage hy3Package;
          xdphPackage = hyprland.packages.${system}.xdg-desktop-portal-hyprland;
          hyprlandRev = hyprland.rev;
          hy3Rev = hy3.rev;
        };
        modules = [ ./home-manager/hyprland.nix ];
      };

      # Expose `pi-coding-agent` as its own attribute so `pi-update` can build
      # it in isolation, without dragging in unrelated failures.
      packages.${system} = {
        inherit pi-coding-agent;

        default = pkgs.buildEnv {
          name = "dotfiles-deps";
          paths = with pkgs; [
            jq
            pspg
            xonsh
            util-linux
            go_1_26
            bun
            nodejs
            fd
            ripgrep
            glab
            git
            git-lfs
            kubernetes-helm
            pi-coding-agent
            chrome-devtools-mcp
            hunk.packages.${system}.default
          ] ++ pi-extensions;
        };
      };
    };
}
