# Releasing

SayType ships as a macOS `.dmg` published to the project's
[GitHub Releases](https://github.com/hellotaotao/WhispLine/releases) page. The
installer is built automatically by the
[`Release`](.github/workflows/release.yml) GitHub Actions workflow — you never
build or upload it by hand.

## What the workflow does

Pushing a tag shaped like `vX.Y.Z` triggers the workflow, which:

1. Spins up a clean macOS runner.
2. Builds a **universal** binary (Intel + Apple Silicon) via
   `tauri build --target universal-apple-darwin`.
3. Signs it with your Developer ID and notarizes it with Apple — **if** the
   signing secrets are configured (see [below](#one-time-setup-signing--notarization)).
4. Creates a **draft** GitHub Release named after the tag and uploads the `.dmg`
   as an asset.

You then review the draft on the Releases page and click **Publish**. (To skip
the manual publish step, set `releaseDraft: false` in the workflow.)

> The workflow only runs on `v*` tag pushes — ordinary commits never trigger it,
> so the file sits dormant until you cut a release.

## Cutting a release

The version shown in the main window and Settings is compiled from `Cargo.toml`
through `env!("CARGO_PKG_VERSION")`, so the version must live in the committed
files and the tag simply mirrors it.

```bash
npm run version:tauri:patch              # bump 1.0.x -> 1.0.(x+1) in package.json, tauri.conf.json, Cargo.toml
git commit -am "chore: release v1.0.90"  # commit the version bump
git tag v1.0.90 && git push origin v1.0.90
```

Then watch the **Actions** tab. The first run takes ~15–25 min (two
architectures plus the notarization queue); later runs are faster thanks to the
Rust cache.

> Don't run `npm run build:mac` to cut a release — it bumps the version a second
> time and produces an unsigned local build. Releasing is just
> bump → commit → tag → push.

## One-time setup: signing & notarization

Without these secrets the workflow still **succeeds**, but the `.dmg` is
**unsigned**: downloaders hit a Gatekeeper warning and must right-click → Open
(or run `xattr -cr /Applications/SayType.app`). To produce an installer that
opens cleanly, add the secrets below under
**Settings → Secrets and variables → Actions → New repository secret**.

Requires a paid Apple Developer account and a **Developer ID Application**
certificate.

| Secret | How to get it |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | The full `Developer ID Application: Name (TEAMID)` string from `security find-identity -v -p codesigning` |
| `APPLE_TEAM_ID` | The 10-character ID in the parentheses above (also on your [Membership page](https://developer.apple.com/account#MembershipDetailsCard)) |
| `APPLE_CERTIFICATE` | Base64 of the exported `.p12` (see below) |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_ID` | Your Apple Developer account email |
| `APPLE_PASSWORD` | An [app-specific password](https://appleid.apple.com) (Sign-In and Security → App-Specific Passwords) — **not** your login password |

**Exporting the certificate:** In Keychain Access → *login* keychain →
*My Certificates*, find the `Developer ID Application` entry (expand it to
confirm it has a private key), right-click → Export as `.p12` with a password,
then copy its base64 to the clipboard:

```bash
base64 -i ~/Desktop/certificate.p12 | pbcopy   # paste into APPLE_CERTIFICATE
```

If `security find-identity` shows no `Developer ID Application` certificate,
create one at
[developer.apple.com](https://developer.apple.com/account/resources/certificates/list)
(Certificates → ➕ → Developer ID Application), download the `.cer`, and
double-click to install it before exporting.

`tauri.conf.json` keeps `signingIdentity: null` on purpose — in CI the
`APPLE_SIGNING_IDENTITY` environment variable takes over, so local builds are
unaffected.
