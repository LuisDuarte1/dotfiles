# Generic factory for npm-published pi extensions.
# Drops sources at $out/lib/pi-extensions/<pname>/ for install.sh to discover.

# Per-extension wrappers pass pname/version/hashes/lockfile. TS sources stay
# uncompiled because pi loads extensions through jiti at runtime.
{ lib, buildNpmPackage, runCommand, fetchurl }:
{ pname
, npmName ? pname # scoped names (@scope/name) can't be derivation names or dirs
, version
, tarballHash
, npmDepsHash
, lockfile
, patches ? [ ]
, extraNpmFlags ? [ ]
, postInstall ? ""
, meta ? { }
}:
let
  tarball = fetchurl {
    url = "https://registry.npmjs.org/${npmName}/-/${lib.last (lib.splitString "/" npmName)}-${version}.tgz";
    hash = tarballHash;
  };

  # Patches are applied inside the src derivation so the patched tree
  # is what buildNpmPackage sees. npmDepsHash is not affected because
  # we only patch source files — never package.json / package-lock.json.
  src = runCommand "${pname}-${version}-src" { } ''
    mkdir -p $out
    tar -xzf ${tarball} -C $out --strip-components=1
    cp ${lockfile} $out/package-lock.json
    ${lib.concatMapStringsSep "\n"
      (p: "patch -p1 -d $out < ${p}") patches}
  '';
in
buildNpmPackage {
  inherit pname version src npmDepsHash postInstall;

  # No TS compilation — pi loads sources via jiti.
  dontNpmBuild = true;

  # Skip install scripts and dev deps; runtime doesn't need them.
  npmFlags = [ "--ignore-scripts" "--omit=dev" ] ++ extraNpmFlags;

  installPhase = ''
    runHook preInstall

    # One dir per extension under lib/pi-extensions/ so install.sh can
    # auto-discover all of them via a single glob.
    mkdir -p $out/lib/pi-extensions/${pname}
    cp -r . $out/lib/pi-extensions/${pname}/
    rm -rf $out/lib/pi-extensions/${pname}/.npm-cache 2>/dev/null || true

    runHook postInstall
  '';

  meta = meta // {
    platforms = lib.platforms.unix;
  };
}
