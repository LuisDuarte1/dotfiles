# pi-tldraw extension (https://github.com/zeebeeCoder/pi-tldraw): tldraw's MCP app as a local canvas.
# Regenerate lockfile via `npm install --package-lock-only --omit=dev --ignore-scripts --legacy-peer-deps`.
{ lib, fetchurl, jq, piExtension }:
let
  tldrawAssetsVersion = "5.1.1"; # the tldraw bundled into mcp-app/dist/mcp-app.html; bump with pi-tldraw
  tldrawAssets = fetchurl {
    url = "https://registry.npmjs.org/@tldraw/assets/-/assets-${tldrawAssetsVersion}.tgz";
    hash = "sha512-/e6QqDADtkbrDtOIHl3TkPQwr+v1lpQz0QDwEOHxoOeroPZmDWTOKxX9kOUV/8dTYVHbQc2CTinK7qhQhmJGaA==";
  };
in
piExtension {
  pname = "pi-tldraw";
  version = "0.2.0";
  tarballHash = "sha512-CvvgvOAdGZ0yXfPtmLSq9BMGzW4G089+VVavScrXl7t55Vz6aqrt1qNCAWCzGMcS+UQmsgUvhCzpXZFR4WygCA==";
  npmDepsHash = "sha256-Yu7KdZkalIZmE2dI9O3n7OUi4yj1d+CuIH+lt0pY04k=";
  lockfile = ./pi-tldraw-package-lock.json;
  extraNpmFlags = [ "--legacy-peer-deps" ]; # pi provides the pi-coding-agent peer, so don't vendor a second copy
  patches = [
    # Start the MCP worker with pi's node (no yarn), offline, from a writable mirror of mcp-app/;
    # serve pinned tldraw assets locally; hand the canvas host to our session-aware entry.ts.
    ./patches/pi-tldraw-nix-runtime.patch
  ];

  # Swap in the codemode-only wrapper. The widget would load Inter from Google Fonts and tldraw's
  # assets from cdn.tldraw.com; point both at nothing remote, failing the build if they move.
  postInstall = ''
    dir=$out/lib/pi-extensions/pi-tldraw
    cp ${../pi/pi-tldraw/entry.ts} $dir/entry.ts
    ${lib.getExe jq} '.pi.extensions = ["./entry.ts"]' $dir/package.json > $dir/package.json.new
    mv $dir/package.json.new $dir/package.json

    html=$dir/mcp-app/dist/mcp-app.html
    grep -q '`${tldrawAssetsVersion}`' $html || { echo "pi-tldraw: widget no longer bundles tldraw ${tldrawAssetsVersion}"; exit 1; }
    grep -q 'https://cdn\.tldraw\.com' $html || { echo "pi-tldraw: tldraw CDN base moved in $html, re-audit"; exit 1; }
    grep -q "@import url('https://fonts\.googleapis\.com" $html || { echo "pi-tldraw: font import moved in $html, re-audit"; exit 1; }
    sed -i -e 's#https://cdn\.tldraw\.com#/tldraw-assets#' -e "\#@import url('https://fonts\.googleapis\.com#d" $html
    if grep -qE 'https://(cdn\.tldraw\.com|fonts\.googleapis\.com)' $html; then echo "pi-tldraw: remote assets left in $html"; exit 1; fi

    # The widget opens its dev-mode log panel whenever wrangler runs in dev mode, which is always
    # here; keep the toggle but start it hidden, failing the build if the bundle changes shape.
    devlog='enableDevMode:(0,\([A-Za-z_$]*\)\.useCallback)(()=>{\([A-Za-z_$]*\)\.current=!0,\([A-Za-z_$]*\)(!0),\([A-Za-z_$]*\)(!0)}'
    grep -q "$devlog" $html || { echo "pi-tldraw: enableDevMode moved in $html, re-audit"; exit 1; }
    sed -i "s/$devlog/enableDevMode:(0,\1.useCallback)(()=>{\2.current=!0,\3(!0),\4(!1)}/" $html

    # The worker's per-session rate limit (30 MCP requests a minute) guards the hosted service, but
    # locally a single drawing turn can exceed it, and execs then fail with HTTP 429.
    grep -q '^limit = 30$' $dir/mcp-app/wrangler.toml || { echo "pi-tldraw: rate limit moved in wrangler.toml, re-audit"; exit 1; }
    sed -i 's/^limit = 30$/limit = 1000000/' $dir/mcp-app/wrangler.toml

    mkdir -p $dir/static/tldraw-assets/${tldrawAssetsVersion}
    tar -xzf ${tldrawAssets} -C $dir/static/tldraw-assets/${tldrawAssetsVersion} --strip-components=1 \
      package/fonts package/icons package/translations package/embed-icons
  '';

  meta = {
    description = "Local tldraw canvas for pi, driven through tldraw's MCP app";
    homepage = "https://github.com/zeebeeCoder/pi-tldraw";
    license = lib.licenses.mit;
  };
}
