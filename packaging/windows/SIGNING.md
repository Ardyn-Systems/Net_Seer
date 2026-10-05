# Code signing the Windows build

Unsigned, `NetSeer.exe` and `NetSeer-Setup-<version>.exe` make Windows SmartScreen show **"Windows protected your PC"** on first run. Signing them with a publicly trusted certificate removes that warning (SmartScreen may still be cautious for a brand-new publisher until downloads build reputation).

The build workflow (`.github/workflows/windows.yml`) signs with **Azure Artifact Signing** (formerly Trusted Signing), Microsoft's cloud signing service. Certificate authorities stopped issuing downloadable `.pfx` code-signing keys in 2023, so CI signing now runs through a cloud service like this one. Until the secrets below exist, the workflow skips signing and the builds still work.

## One-time setup

You need an Azure subscription. Artifact Signing has a monthly fee (check the current price and which countries it's open to on the Azure pricing page before you start).

1. **Create an Artifact Signing account.** In the Azure portal, search for *Artifact Signing Accounts* → **Create**. Pick a region and note the account **name** and its **endpoint** (for example `https://eus.codesigning.azure.net/`).
2. **Verify your identity.** In the account, open **Identity validations** → **New identity** → **Public**, as an individual or an organization. Microsoft checks the details; this can take a few business days. The publisher name people will see comes from here.
3. **Create a certificate profile.** In the account, **Certificate profiles** → **Create** → **Public Trust**, using the validated identity. Note the profile **name**.
4. **Create an app registration for GitHub Actions.** In *Microsoft Entra ID* → **App registrations** → **New registration** (name it `netseer-signing`). Note the **Application (client) ID** and **Directory (tenant) ID**. Under **Certificates & secrets**, create a **client secret** and copy its value.
5. **Let the app sign.** Back in the Artifact Signing account → **Access control (IAM)** → **Add role assignment** → **Artifact Signing Certificate Profile Signer** (older portals: *Trusted Signing Certificate Profile Signer*) → assign it to the `netseer-signing` app.
6. **Add GitHub secrets.** In the NetSeer repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret | Value |
| --- | --- |
| `AZURE_TENANT_ID` | Directory (tenant) ID from step 4 |
| `AZURE_CLIENT_ID` | Application (client) ID from step 4 |
| `AZURE_CLIENT_SECRET` | Client secret value from step 4 |
| `AZURE_SIGNING_ENDPOINT` | Account endpoint from step 1 |
| `AZURE_SIGNING_ACCOUNT` | Account name from step 1 |
| `AZURE_CERT_PROFILE` | Certificate profile name from step 3 |

## What the workflow signs

1. `NetSeer.exe`, right after the smoke test, so the portable zip and the installer both carry the signed program.
2. `NetSeer-Setup-<version>.exe`, after Inno Setup builds it.
3. Then it checks both with `Get-AuthenticodeSignature` and fails the build if either isn't `Valid`.

Signatures are SHA-256 and timestamped, so they stay valid after the certificate rotates. The uninstaller that Inno Setup writes into the install folder isn't signed separately; Windows doesn't show SmartScreen for uninstalls started from Settings → Apps.

## Check a downloaded file

In PowerShell:

```powershell
Get-AuthenticodeSignature .\NetSeer-Setup-0.5.2.exe | Format-List Status, SignerCertificate
```

Or right-click the file → **Properties** → **Digital Signatures**.
