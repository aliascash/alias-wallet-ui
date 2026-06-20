# GitHub Actions secrets & variables

The release workflow (`.github/workflows/release.yml`) reads the values below.
Configure them under **Settings → Secrets and variables → Actions**.

## Variables (Variables tab)

| Variable | Required? | Used for | Value |
|---|---|---|---|
| `DAEMON_REPO` | Optional | Which repo the desktop downloads the daemon binary from | e.g. `aliascash/alias-wallet`. If unset, defaults to `aliascash/alias-wallet`. |

## Secrets (Secrets tab)

| Secret | Required? | Used for | Value |
|---|---|---|---|
| `GITHUB_TOKEN` | Auto-provided | Checkout / API access | Provided automatically by GitHub Actions — do **not** create it. |
| `DAEMON_REPO_PAT` | Only if the daemon repo is private or in another org | Reading the daemon repo's releases (falls back to `GITHUB_TOKEN` when unset) | A GitHub PAT with read access to the daemon repo (classic: `repo`; fine-grained: Contents = Read). |
| `CSC_LINK` | Optional (code signing) | Signing Windows/macOS installers | Base64 of your code-signing certificate (`.p12` / `.pfx`). |
| `CSC_KEY_PASSWORD` | Optional (code signing) | Certificate password | The password for the certificate above. |

## Minimum to get green builds

Nothing is strictly required if the daemon repo is **public** and named
`aliascash/alias-wallet` (the default for `DAEMON_REPO`):

- Set `DAEMON_REPO` if the daemon lives elsewhere.
- Add `DAEMON_REPO_PAT` only if the daemon repo is private/cross-org.
- Add `CSC_LINK` + `CSC_KEY_PASSWORD` only if you want signed installers; unsigned
  builds still succeed but trigger SmartScreen/Gatekeeper warnings on end-user machines.
