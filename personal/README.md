# Personal overlay

Machine-specific configuration for this checkout. `bash/bashrc` and
`bin/dotfiles-sync` read this directory before `${XDG_CONFIG_HOME:-~/.config}/dotfiles`,
so a separate overlay repository can still layer on top and override it.

- `bashrc.d/` — shell additions for this machine
- `pi/extensions.exclude` — pi extensions that must not be linked here
  (`web-search`, because `pi-web-access` owns the `web_search` tool name)
- `pi/settings.d/` — pi settings fragments (provider, models, local npm packages)
- `zed/settings.d/` — Zed UI preferences

`pi-web-access` is a flake package (`packages.pi-web-access` and part of the default profile),
not an npm package: do not add `npm:pi-web-access` to `pi/settings.d`.

Commit personal changes here instead of leaving them only in
`~/.config/dotfiles`.
