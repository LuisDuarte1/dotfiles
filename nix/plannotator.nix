# Plannotator pi extension (https://github.com/backnotprop/plannotator): annotate and review only.
# Regenerate lockfile via `npm install --package-lock-only --omit=dev --ignore-scripts`.
{ lib, jq, piExtension }:
piExtension {
  pname = "plannotator";
  npmName = "@plannotator/pi-extension";
  version = "0.28.17";
  tarballHash = "sha512-6OaY/J3oTRhjfQ2CeHS2AkgqPDeVq5Fa3y+qtJB/uRoT0AZoyHtl86Y+9LpxC0FmqLlqai/nof1g6oxzWsAm/Q==";
  npmDepsHash = "sha256-9fragPmjB+X1PnjQDKs+sBEhpM39hOCWZIBQXUSnxT4=";
  lockfile = ./plannotator-package-lock.json;

  # Swap the entry point for our command-filtering wrapper, and blank the plannotator.ai demo
  # media that first-run dialogs fetch unprompted (leaks IP and Referer; no env switch).
  postInstall = ''
    dir=$out/lib/pi-extensions/plannotator
    cp ${../pi/plannotator/entry.ts} $dir/entry.ts
    ${lib.getExe jq} '.pi.extensions = ["./entry.ts"]' $dir/package.json > $dir/package.json.new
    mv $dir/package.json.new $dir/package.json

    for f in $dir/plannotator.html $dir/review-editor.html; do
      grep -q 'https://plannotator.ai/assets' $f || { echo "plannotator: asset host moved in $f, re-audit"; exit 1; }
      sed -i 's#https://plannotator\.ai/assets#data:,#g' $f
    done
  '';

  meta = {
    description = "Annotate files, folders and URLs, or review code changes, in a browser UI and send the feedback to pi";
    homepage = "https://github.com/backnotprop/plannotator";
    license = with lib.licenses; [ mit asl20 ];
  };
}
