# Local shell additions for this variant. Loaded after bash/bashrc and before
# any external ~/.config/dotfiles overlay.
alias code='zeditor'
alias ssh='kitten ssh'
alias clip-to-file='wl-paste >'

export PATH="$HOME/.opencode/bin:$PATH"
export PNPM_HOME="$HOME/.local/share/pnpm"
case ":$PATH:" in
    *":$PNPM_HOME:"*) ;;
    *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# pi-web-access is always active here; the repo's provider-native --web-search
# extension is excluded, so don't pass its flag.
pi-web() { pi "$@"; }
export -f pi-web

# The current fallback display is 1080p; uncomment if GTK apps need it.
# export GDK_SCALE=1
