# Release Checklist

Use this for every tagged release and hotfix batch. A GitHub Release is not complete until the public website download buttons are verified against the exact uploaded asset names.

## Release Steps

1. Promote `CHANGELOG.md` `[Unreleased]` into the new version section.
2. Bump both root and Electron package versions.
3. Run release checks and build all supported platforms.
4. Upload the release assets and updater manifests to GitHub Releases.
5. Verify the remote GitHub assets:
   - `Constellation-Setup-<version>.exe`
   - `Constellation-<version>-arm64-mac.zip`
   - `Constellation-<version>.AppImage`
   - `latest.yml`
   - `latest-mac.yml`
   - `latest-linux.yml`
6. Update `/home/devin/constellation-engine-web/index.html` download links to those exact asset names.
7. Deploy the website with `/home/devin/constellation-engine-web/scripts/deploy-clean.sh`.
8. Verify `https://constellation-engine.com` serves the new version links, not cached old HTML.
9. Verify all three public website download buttons return HTTP 200:
   - Windows
   - macOS Apple Silicon
   - Linux AppImage

## Hard Rule

Do not call a release finished while the website still points at the previous version or at guessed asset names. The release asset names are the source of truth.
