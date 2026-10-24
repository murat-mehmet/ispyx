# Releasing

A release is one tag. `.github/workflows/release.yml` runs on every `v*` tag and

- checks that the tag matches `version` in `package.json` and that every source file parses,
- publishes the npm package (what Windows users, and anyone using `npx -y ispyx`, run),
- builds `Ispyx-<version>.dmg` on macOS (universal, carrying the same version), signed and notarised when the
  Apple secrets are set,
- creates the GitHub release with the DMG (and its `.sha256`, which `scripts/install.sh` checks), the npm tarball,
  `scripts/install.ps1` and `scripts/install.sh` attached. A version with a hyphen (`1.2.0-beta.1`)
  becomes a pre-release and goes to the npm `next` tag instead of `latest`.

```sh
npm version 1.1.0            # bumps package.json and package-lock.json, commits, tags v1.1.0
git push --follow-tags
```

## Secrets

npm needs no secret: the package uses npm trusted publishing (npmjs.com > ispyx > Settings > Trusted Publisher:
GitHub Actions, `murat-mehmet/ispyx`, workflow `release.yml`, npm publish allowed), so the workflow publishes with
its OIDC identity and npm adds a provenance statement.

The macOS secrets are under Settings > Secrets and variables > Actions. Without them the DMG is ad-hoc signed (Gatekeeper blocks it until the user allows it,
and macOS asks for the permissions again after every update).

| Secret | What it is |
| --- | --- |
| `MACOS_CERTIFICATE_P12` | The **Developer ID Application** certificate with its private key, exported as `.p12` and base64 encoded (below). |
| `MACOS_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12`. |
| `APPLE_ID` | The Apple ID email of the developer account (notarisation). |
| `APPLE_TEAM_ID` | The 10-character team ID (developer.apple.com > Membership). |
| `APPLE_APP_PASSWORD` | An app-specific password for that Apple ID (account.apple.com > Sign-In and Security > App-Specific Passwords). |

### The Developer ID certificate

1. Xcode > Settings > Accounts > your team > Manage Certificates > + > **Developer ID Application**.
2. Keychain Access > My Certificates: right-click "Developer ID Application: ..." > Export, as `.p12`, with a
   password.
3. `base64 -i DeveloperID.p12 | pbcopy` and paste it as `MACOS_CERTIFICATE_P12`. Delete the `.p12` file.

Keep the bundle id (`com.ispyx.app` in `native/macos/Ispyx/Resources/Info.plist`) and the team the same from the
first release on: macOS ties the Accessibility and Screen Recording permissions to them, so changing either makes
every user grant them again.

## Local builds

`native/macos/build.sh` builds the same app and DMG on a Mac. It reads `SIGN_IDENTITY` / `NOTARY_PROFILE` from the
environment or from `native/macos/signing.local` (not in git); see the comments at the top of `build.sh`.
