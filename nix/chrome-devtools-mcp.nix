# Chrome DevTools MCP server, pinned to a fixed npm release.
# The published tarball is self-contained (rolled-up build, zero npm deps).

# To bump: change `version`, rerun `nix-prefetch-url <tarball>`, then convert
# the result via `nix hash convert --to sri sha256-<hash>`.
{ lib, stdenv, fetchurl, nodejs, makeWrapper }:
let
  pname = "chrome-devtools-mcp";
  version = "1.0.1";
in
stdenv.mkDerivation {
  inherit pname version;

  src = fetchurl {
    url = "https://registry.npmjs.org/${pname}/-/${pname}-${version}.tgz";
    hash = "sha256-8CyjSlq3caR9BbfmKJsAfSjVcMsNdwIlTeRctEaDra8=";
  };

  nativeBuildInputs = [ makeWrapper ];

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    # Drop the unpacked package under lib/node_modules/<pname>/ and wrap
    # each `bin` entry from package.json as a node-launched binary on PATH.
    mkdir -p $out/lib/node_modules/${pname}
    cp -r . $out/lib/node_modules/${pname}/

    mkdir -p $out/bin
    makeWrapper ${nodejs}/bin/node $out/bin/chrome-devtools-mcp \
      --add-flags $out/lib/node_modules/${pname}/build/src/bin/chrome-devtools-mcp.js
    makeWrapper ${nodejs}/bin/node $out/bin/chrome-devtools \
      --add-flags $out/lib/node_modules/${pname}/build/src/bin/chrome-devtools.js

    runHook postInstall
  '';

  meta = with lib; {
    description = "Chrome DevTools MCP server for AI coding agents";
    homepage = "https://github.com/ChromeDevTools/chrome-devtools-mcp";
    license = licenses.asl20;
    mainProgram = "chrome-devtools-mcp";
    platforms = platforms.unix;
  };
}
