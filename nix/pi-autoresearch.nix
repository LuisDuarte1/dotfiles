# pi-autoresearch extension (https://github.com/davebcn87/pi-autoresearch).
# Regenerate lockfile via `npm install --package-lock-only --omit=dev --ignore-scripts`.
{ lib, piExtension }:
piExtension {
  pname = "pi-autoresearch";
  version = "1.8.1";
  tarballHash = "sha512-6Z9pnW3JaNAg2vU3Fd+m3lzimqPcATppB+OM9lxrC2DuJXMsqROSNJdDBmVNHeVFybmnVqhf7BR9/sr+2aqDpw==";
  npmDepsHash = "sha256-+XBZdB43DWk9dlY+1SjCIg1QkEx/7cCAaG9X3c4Z6+I=";
  lockfile = ./pi-autoresearch-package-lock.json;
  patches = [
    # Bridge spawn/exec call sites through globalThis.__piDoRemote so
    # the pi-do-remote extension can route experiments and git ops
    # into a Sandbox container when /do-remote is active.
    ./patches/pi-autoresearch-do-remote.patch

    # Gate both compaction takeovers (summary + auto-resume) on run experiments
    # so a plain chat in a dir with autoresearch.jsonl isn't hijacked on compact.
    ./patches/pi-autoresearch-compaction-gate.patch

    # `/autoresearch wrapup`: stop after the in-flight experiment is logged, so the
    # loop ends with a clean tree instead of `off` aborting a half-run benchmark.
    ./patches/pi-autoresearch-wrapup.patch
  ];
  meta = {
    description = "Autonomous experiment loop for pi — run, measure, keep or discard";
    homepage = "https://github.com/davebcn87/pi-autoresearch";
    license = lib.licenses.mit;
  };
}
