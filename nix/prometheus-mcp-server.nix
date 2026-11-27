# Prometheus MCP server (prometheus/prometheus-mcp), pinned to a release's static Go binary.
# To bump: change `version`, rerun `nix-prefetch-url <tarball>` and `nix hash convert --to sri`.
{ lib, stdenv, fetchurl }:
let
  pname = "prometheus-mcp-server";
  version = "0.18.0";
in
stdenv.mkDerivation {
  inherit pname version;

  src = fetchurl {
    url = "https://github.com/prometheus/prometheus-mcp/releases/download/v${version}/${pname}_${version}_linux_amd64.tar.gz";
    hash = "sha256-UAMDRllKS42JKU86LLniU8qgvXXmn++9mt0onK/Wwnw=";
  };

  sourceRoot = ".";
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 ${pname} $out/bin/${pname}
    runHook postInstall
  '';

  meta = with lib; {
    description = "MCP server for querying a Prometheus instance";
    homepage = "https://github.com/prometheus/prometheus-mcp";
    license = licenses.asl20;
    mainProgram = pname;
    platforms = [ "x86_64-linux" ];
  };
}
