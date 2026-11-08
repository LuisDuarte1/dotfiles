# pi-web-access extension (https://github.com/nicobailon/pi-web-access).
# Regenerate lockfile via `npm install --package-lock-only --omit=dev --ignore-scripts --legacy-peer-deps`.
{ lib, piExtension }:
piExtension {
  pname = "pi-web-access";
  version = "0.45.0";
  tarballHash = "sha512-AHgUKUas1vvBtdKbcv+7rWTPTIOl8xHR4E7s4dLBAz6soSGGPC4YNq1uVGuH5+bVrMx4X/fmPCm4rsOQIxexdQ==";
  npmDepsHash = "sha256-nAvGC0fOr5NIygOrJ1YTNYjksdbStkCwPPbz7QS+i9Q=";
  lockfile = ./pi-web-access-package-lock.json;
  # pi supplies the @earendil-works/* peers; don't vendor a second copy.
  extraNpmFlags = [ "--legacy-peer-deps" ];
  meta = {
    description = "Web search and content extraction tools for pi";
    homepage = "https://github.com/nicobailon/pi-web-access";
    license = lib.licenses.mit;
  };
}
