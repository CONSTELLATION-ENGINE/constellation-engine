# Release Checklist

Use this for every tagged release and hotfix batch. A GitHub Release is not complete until the public website download buttons are verified against the exact uploaded asset names.

This file is also injected automatically by Constellation Engine's Tool Context Binding when a turn looks like an OSS release, hotfix, version bump, packaging, push, or website-download update.

## Preflight

1. Confirm the release scope from the diff since the previous tag.
2. Confirm `CHANGELOG.md` `[Unreleased]` contains every OSS-shippable fix in the batch.
3. Run a sensitive-term/token scan before packaging.
4. Confirm package versions are still on the previous version before the bump, then bump both root and Electron package versions together.
5. Run release checks. If a check is skipped or known-bad, record the exact reason in the release summary.

## Release Steps

1. Promote `CHANGELOG.md` `[Unreleased]` into the new version section.
2. Bump both root and Electron package versions.
3. Run release checks and build all supported platforms.
4. Upload the release assets and updater manifests to GitHub Releases.
5. Verify the local artifact names match the updater manifests (`latest*.yml`) before upload.
6. Verify the remote GitHub assets:
   - `Constellation-Setup-<version>.exe`
   - `Constellation-<version>-arm64-mac.zip`
   - `Constellation-<version>.AppImage`
   - `latest.yml`
   - `latest-mac.yml`
   - `latest-linux.yml`
7. Push `main` and the version tag.
8. Update `/home/devin/constellation-engine-web/index.html` download links to those exact asset names.
9. Deploy the website with `/home/devin/constellation-engine-web/scripts/deploy-clean.sh`.
10. Verify `https://constellation-engine.com` serves the new version links, not cached old HTML.
11. Verify all three public website download buttons return HTTP 200:
   - Windows
   - macOS Apple Silicon
   - Linux AppImage

## Hard Rule

Do not call a release finished while the website still points at the previous version or at guessed asset names. The release asset names are the source of truth.
