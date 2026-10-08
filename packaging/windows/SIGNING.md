# Code signing the Windows build

Unsigned, `NetSeer.exe` and `NetSeer-Setup-<version>.exe` make Windows SmartScreen show **"Windows protected your PC"** on first run. Signing them with a publicly trusted certificate removes that warning (SmartScreen may still be cautious for a brand-new publisher until downloads build reputation).

The Windows build (`.github/workflows/electron.yml`) packages with **electron-builder**, which signs with a `.pfx`/`.p12` code-signing certificate supplied through two secrets. When they're absent the installer and the portable zip build **unsigned**, and everything still works.

## One-time setup

1. **Get a code-signing certificate.** Buy an OV (or EV) code-signing certificate from a certificate authority and export it as a password-protected `.pfx`. EV certificates get SmartScreen reputation immediately; OV certificates build it over time.
2. **Base64-encode the `.pfx`** so it can live in a GitHub secret:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("netseer.pfx")) | Set-Content netseer.pfx.b64
   ```

3. **Add GitHub secrets.** In the NetSeer repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

   | Secret | Value |
   | --- | --- |
   | `WINDOWS_CSC_LINK` | The base64 from step 2 (or a URL to the `.pfx`) |
   | `WINDOWS_CSC_KEY_PASSWORD` | The certificate's password |

electron-builder reads `CSC_LINK` / `CSC_KEY_PASSWORD` (the workflow maps the secrets onto them) and signs `NetSeer.exe` and `NetSeer-Setup-<version>.exe` automatically. Signatures are SHA-256 and timestamped, so they stay valid after the certificate rotates.

## Check a downloaded file

In PowerShell:

```powershell
Get-AuthenticodeSignature .\NetSeer-Setup-0.7.3.exe | Format-List Status, SignerCertificate
```

Or right-click the file → **Properties** → **Digital Signatures**.

## Optional: Azure Artifact Signing

Certificate authorities stopped issuing downloadable `.pfx` keys to some buyers in 2023, so an alternative is **Azure Artifact Signing** (formerly Trusted Signing), Microsoft's cloud signing service (monthly fee; check availability in your country). To use it instead of a `.pfx`, add an electron-builder [custom `sign` hook](https://www.electron.build/code-signing) that calls the Azure Trusted Signing client, and swap the two `WINDOWS_CSC_*` secrets for the Azure credentials (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, plus the signing endpoint, account, and certificate-profile names).
