# pi sleep-guard: Rust rules built to wasm, shipped as a pi package.

# The wasm lands next to index.ts inside the store so the extension resolves it
# relatively — no install-time copy, no env var, no path search.
{ lib, rustPlatform, lld }:

rustPlatform.buildRustPackage {
  pname = "pi-sleep-guard";
  version = "0.1.0";

  src = ../pi/sleep-guard;
  cargoLock.lockFile = ../pi/sleep-guard/Cargo.lock;

  # The wasm target links with lld, which nixpkgs' rustc wrapper does not provide.
  nativeBuildInputs = [ lld ];

  # nixpkgs rustc ships wasm32-unknown-unknown std, so no rust-overlay is needed.
  buildPhase = ''
    runHook preBuild
    cargo build --release --offline --target wasm32-unknown-unknown
    runHook postBuild
  '';

  # Tests are host-native (the rules are a plain Rust function); the release
  # profile aborts on panic, which the test harness cannot use.
  checkPhase = ''
    runHook preCheck
    cargo test --offline
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    dir=$out/lib/pi-extensions/sleep-guard/extensions
    mkdir -p $dir
    cp target/wasm32-unknown-unknown/release/sleep_guard.wasm $dir/
    cp extensions/index.ts $dir/
    runHook postInstall
  '';

  meta = {
    description = "pi guardrail that blocks blind sleeps in agent commands";
    platforms = lib.platforms.unix;
  };
}
