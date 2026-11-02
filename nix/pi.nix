# Pi coding-agent.
#
# Installs the published @earendil-works/pi-coding-agent npm tarball, which
# already ships a prebuilt dist/. We avoid building from source because pi's
# build script needs network access (generate-models hits models.dev /
# OpenRouter / Vercel AI gateway) and pulls native devDeps (canvas) that
# aren't required at runtime.
#
# The tarball lacks a usable lockfile (recent releases ship an
# npm-shrinkwrap.json that's missing `integrity` for inter-workspace
# @earendil-works/* deps, which buildNpmPackage's Rust prefetcher rejects).
# We regenerate nix/pi-package-lock.json from scratch via
# `npm install --package-lock-only` inside the unpacked tarball -- run
# `pi-update` (or do it manually) when bumping `version`.
{ lib, buildNpmPackage, runCommand, fetchurl, nodejs, makeWrapper }:
let
  version = "1.5.0";

  tarball = fetchurl {
    url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-${version}.tgz";
    hash = "sha256-W/tmhIpMS4HGN86NITa+AZRbcKrI6FVrCRywIkGzhd8=";
  };

  # Stage the unpacked tarball with the committed lockfile alongside it so
  # buildNpmPackage's npmConfigHook can validate them in the same source tree.
  src = runCommand "pi-coding-agent-${version}-src" { } ''
    mkdir -p $out
    tar -xzf ${tarball} -C $out --strip-components=1
    # Drop the upstream npm-shrinkwrap.json (when present): it lacks
    # integrity for inter-workspace @earendil-works/* deps and would win
    # over our regenerated lockfile in buildNpmPackage's prefetcher.
    rm -f $out/npm-shrinkwrap.json
    cp ${./pi-package-lock.json} $out/package-lock.json
  '';
in
buildNpmPackage {
  pname = "pi-coding-agent";
  inherit version src;

  npmDepsHash = "sha256-ggFJSBK3d+8UhsGNN6YovgrWo2HGxg9CQtGbjc+1i7E=";

  # Tarball ships dist/ already; nothing to compile.
  dontNpmBuild = true;

  # Skip install scripts to avoid native compilation of optional deps
  # (none of pi's runtime deps require them).
  npmFlags = [ "--ignore-scripts" "--omit=dev" ];

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/pi-coding-agent $out/bin
    cp -r dist node_modules package.json $out/lib/pi-coding-agent/

    # Ship docs and examples so AGENTS.md references resolve and users can
    # browse extension examples that come with the upstream tarball.
    for extra in README.md CHANGELOG.md docs examples; do
      if [ -e "$extra" ]; then
        cp -r "$extra" $out/lib/pi-coding-agent/
      fi
    done

    makeWrapper ${nodejs}/bin/node $out/bin/pi \
      --add-flags "$out/lib/pi-coding-agent/dist/cli.js"

    runHook postInstall
  '';

  # Keep signed thinking replayable after mid-output Anthropic fallbacks, and inline extension
  # statuses into the footer's stats line when they fit; each patch's header says why.
  postInstall = ''
    patch -p1 \
      -d $out/lib/pi-coding-agent/node_modules/@earendil-works/pi-ai \
      < ${../pi/patches/pi-ai-anthropic-midstream-fallback.patch}
    patch -p1 -d $out/lib/pi-coding-agent < ${../pi/patches/pi-footer-inline-statuses.patch}
  '';

  meta = {
    description = "Pi minimal terminal coding harness (CLI)";
    homepage = "https://github.com/earendil-works/pi";
    license = lib.licenses.mit;
    mainProgram = "pi";
    platforms = lib.platforms.unix;
  };
}
