local home = assert(os.getenv("HOME"), "HOME must be set")
local configHome = os.getenv("XDG_CONFIG_HOME") or (home .. "/.config")
package.path = configHome .. "/hypr/?.lua;" .. package.path
local mod = "SUPER"

local function bindGlobal(keys, dispatcher, options)
    options = options or {}
    options.dont_inhibit = true
    return hl.bind(keys, dispatcher, options)
end

local monitorsLoaded = pcall(require, "monitors")
pcall(require, "workspaces")

if not monitorsLoaded then
    -- Pin the Dells by model, not port: forcing 4K onto another screen on DP-3 fails
    -- the modeset, and aquamarine then segfaults on the fallback at login.
    for _, model in ipairs({ "P2723QE", "U2723QE" }) do
        hl.monitor({
            output = "desc:Dell Inc. DELL " .. model,
            mode = "3840x2160@60",
            position = "0x0",
            scale = 1.5,
        })
    end

    -- Relative positions keep any screen stacked on the laptop: a fixed eDP-1 offset
    -- leaves auto-placed screens touching it only at a corner, so the cursor can't cross.
    hl.monitor({
        output = "eDP-1",
        mode = "3840x2400@60",
        position = "auto-down",
        scale = 2,
    })

    hl.monitor({
        output = "",
        mode = "preferred",
        position = "auto-up",
        scale = "auto",
    })
end

hl.config({
    general = {
        gaps_in = 5,
        gaps_out = 20,
        border_size = 2,
        resize_on_border = true,
        layout = "dwindle",
        col = {
            active_border = {
                colors = { "rgba(33ccffee)", "rgba(00ff99ee)" },
                angle = 45,
            },
            inactive_border = "rgba(595959aa)",
        },
    },
    decoration = {
        rounding = 10,
        rounding_power = 2,
        active_opacity = 1.0,
        inactive_opacity = 1.0,
        shadow = {
            enabled = true,
            range = 4,
            render_power = 3,
            color = "rgba(1a1a1aee)",
        },
        blur = {
            enabled = true,
            size = 3,
            passes = 1,
            vibrancy = 0.1696,
        },
    },
    animations = {
        enabled = true,
    },
    binds = {
        disable_keybind_grabbing = true,
    },
    input = {
        kb_rules = "evdev",
        kb_model = "pc105",
        kb_layout = "pt",
        kb_variant = "",
        kb_options = "",
        resolve_binds_by_sym = true,
        natural_scroll = false,
        scroll_factor = 1.0,
        touchpad = {
            natural_scroll = false,
            scroll_factor = 1.0,
        },
    },
    dwindle = {
        preserve_split = true,
    },
    misc = {
        disable_hyprland_logo = false,
        disable_splash_rendering = false,
        force_default_wallpaper = -1,
    },
})

-- This device reports inverted scroll polarity; true produces conventional scrolling.
-- Pin both exposed nodes so reconnects cannot restore the broken direction.
for _, deviceName in ipairs({
    "ven_27c6:00-27c6:0f60-mouse",
    "ven_27c6:00-27c6:0f60-touchpad",
}) do
    hl.device({
        name = deviceName,
        natural_scroll = true,
        scroll_factor = 1.0,
    })
end

hl.curve("easeOutQuint", { type = "bezier", points = { { 0.23, 1 }, { 0.32, 1 } } })
hl.curve("easeInOutCubic", { type = "bezier", points = { { 0.65, 0.05 }, { 0.36, 1 } } })
hl.curve("linear", { type = "bezier", points = { { 0, 0 }, { 1, 1 } } })
hl.curve("almostLinear", { type = "bezier", points = { { 0.5, 0.5 }, { 0.75, 1 } } })
hl.curve("quick", { type = "bezier", points = { { 0.15, 0 }, { 0.1, 1 } } })
hl.curve("easy", { type = "spring", mass = 1, stiffness = 71.2633, dampening = 15.8273644 })

hl.animation({ leaf = "global", enabled = true, speed = 10, bezier = "default" })
hl.animation({ leaf = "border", enabled = true, speed = 5.39, bezier = "easeOutQuint" })
hl.animation({ leaf = "windows", enabled = false })
hl.animation({ leaf = "windowsIn", enabled = false })
hl.animation({ leaf = "windowsOut", enabled = false })
hl.animation({ leaf = "fadeIn", enabled = false })
hl.animation({ leaf = "fadeOut", enabled = false })
hl.animation({ leaf = "fade", enabled = false })
hl.animation({ leaf = "layers", enabled = true, speed = 3.81, bezier = "easeOutQuint" })
hl.animation({ leaf = "layersIn", enabled = true, speed = 4, bezier = "easeOutQuint", style = "fade" })
hl.animation({ leaf = "layersOut", enabled = true, speed = 1.5, bezier = "linear", style = "fade" })
hl.animation({ leaf = "fadeLayersIn", enabled = true, speed = 1.79, bezier = "almostLinear" })
hl.animation({ leaf = "fadeLayersOut", enabled = true, speed = 1.39, bezier = "almostLinear" })
hl.animation({ leaf = "workspaces", enabled = true, speed = 1.94, bezier = "almostLinear", style = "fade" })
hl.animation({ leaf = "workspacesIn", enabled = true, speed = 1.21, bezier = "almostLinear", style = "fade" })
hl.animation({ leaf = "workspacesOut", enabled = true, speed = 1.94, bezier = "almostLinear", style = "fade" })
hl.animation({ leaf = "zoomFactor", enabled = true, speed = 7, bezier = "quick" })

hl.on("hyprland.start", function()
    hl.exec_cmd([[hyprctl monitors > "$HOME/hyprland-vt-monitors.txt"]])
    hl.exec_cmd([[hyprctl binds > "$HOME/hyprland-vt-binds.txt"]])
    hl.exec_cmd("waybar")
    hl.exec_cmd("kitty")
end)

bindGlobal(mod .. " + Return", hl.dsp.exec_cmd("kitty"))
bindGlobal(mod .. " + D", hl.dsp.exec_cmd("rofi -show drun"))
bindGlobal(mod .. " + SHIFT + Q", hl.dsp.window.close())
bindGlobal(mod .. " + F", hl.dsp.window.fullscreen())
bindGlobal(mod .. " + SHIFT + space", hl.dsp.window.float({ action = "toggle" }))
bindGlobal(mod .. " + CTRL + L", hl.dsp.exec_cmd("/usr/bin/swaylock -f"))
bindGlobal(mod .. " + SHIFT + C", hl.dsp.exec_cmd("hyprctl reload"))
bindGlobal(mod .. " + SHIFT + E", hl.dsp.exit())

local directions = {
    { key = "J", direction = "left" },
    { key = "K", direction = "down" },
    { key = "L", direction = "up" },
    { key = "ccedilla", direction = "right" },
    { key = "left", direction = "left" },
    { key = "down", direction = "down" },
    { key = "up", direction = "up" },
    { key = "right", direction = "right" },
}

for _, binding in ipairs(directions) do
    bindGlobal(mod .. " + " .. binding.key, hl.dsp.focus({ direction = binding.direction }))
    bindGlobal(mod .. " + SHIFT + " .. binding.key, hl.dsp.window.move({ direction = binding.direction }))
end

local workspaceBindings = {
    { keycode = "code:10", workspace = 1 },
    { keycode = "code:11", workspace = 2 },
    { keycode = "code:12", workspace = 3 },
    { keycode = "code:13", workspace = 4 },
    { keycode = "code:14", workspace = 5 },
    { keycode = "code:15", workspace = 6 },
    { keycode = "code:16", workspace = 7 },
    { keycode = "code:17", workspace = 8 },
    { keycode = "code:18", workspace = 9 },
    { keycode = "code:19", workspace = 10 },
}

for _, binding in ipairs(workspaceBindings) do
    bindGlobal(mod .. " + " .. binding.keycode, hl.dsp.focus({ workspace = binding.workspace }))
    bindGlobal(mod .. " + SHIFT + " .. binding.keycode, hl.dsp.window.move({ workspace = binding.workspace, follow = false }))
end
