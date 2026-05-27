import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isWindows } from './machine.js'

const execFileAsync = promisify(execFile)

/**
 * KAN-62 — wrap the agent's at-rest key material in an OS-bound keystore.
 *
 * A `KeyMaterialProtector` encrypts ("protects") and decrypts ("unprotects")
 * small secret blobs. The whole point is that the protected blob can only be
 * unprotected inside the same security context that protected it — so a copy
 * of the file alone, lifted off disk, is useless.
 *
 * Two implementations ship:
 *  - `DpapiProtector` (Windows) — wraps the blob with the Windows Data
 *    Protection API (`System.Security.Cryptography.ProtectedData`,
 *    `CurrentUser` scope) so the blob is bound to the logged-in Windows user
 *    account and cannot be unwrapped by another user — or another machine.
 *  - `PassthroughProtector` (non-Windows) — a no-op. The agent is a
 *    Windows-first desktop app; on Linux/macOS (CI, dev) there is no DPAPI, so
 *    the salt keeps its existing 0600-plaintext behaviour. A real
 *    libsecret/Keychain protector is future work (see KAN-62 description).
 */
export interface KeyMaterialProtector {
  /** True when this protector binds the blob to an OS keystore. */
  readonly bindsToOsKeystore: boolean
  /** Encrypt a secret blob so it can only be decrypted in this OS context. */
  protect(plain: Buffer): Promise<Buffer>
  /** Reverse `protect`. Throws if the blob was protected in a different context. */
  unprotect(wrapped: Buffer): Promise<Buffer>
}

/**
 * Windows DPAPI protector. Invokes PowerShell rather than a native addon so
 * the cross-platform build (CI runs on Linux) needs zero extra dependencies
 * and `npm ci` cannot fail on a postinstall native compile.
 *
 * The blob is round-tripped as base64 on the PowerShell command line. DPAPI
 * payloads here are tiny (a 32-byte salt wraps to a few hundred bytes), well
 * within command-line limits.
 *
 * KAN-431 S5 — the PowerShell script is passed via `-EncodedCommand`
 * (UTF-16LE base64 of the full script) rather than string-interpolating the
 * base64 payload into a `-Command` literal. -EncodedCommand decodes inside
 * PowerShell, so no quote/escape boundary exists in the constructed command
 * line. Today's base64 payload is quote-safe, but a future encoding swap
 * (hex, raw text, etc.) won't reintroduce an injection footgun.
 */
export class DpapiProtector implements KeyMaterialProtector {
  readonly bindsToOsKeystore = true

  private async runPowerShell(script: string): Promise<string> {
    // PowerShell's -EncodedCommand expects a base64-encoded UTF-16LE
    // (little-endian) string of the entire script body.
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    return stdout.trim()
  }

  async protect(plain: Buffer): Promise<Buffer> {
    const b64 = plain.toString('base64')
    const script = [
      'Add-Type -AssemblyName System.Security;',
      `$plain = [Convert]::FromBase64String('${b64}');`,
      '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser;',
      '$wrapped = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, $scope);',
      '[Convert]::ToBase64String($wrapped)',
    ].join(' ')
    const out = await this.runPowerShell(script)
    if (!out) throw new Error('DPAPI Protect produced no output')
    return Buffer.from(out, 'base64')
  }

  async unprotect(wrapped: Buffer): Promise<Buffer> {
    const b64 = wrapped.toString('base64')
    const script = [
      'Add-Type -AssemblyName System.Security;',
      `$wrapped = [Convert]::FromBase64String('${b64}');`,
      '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser;',
      '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($wrapped, $null, $scope);',
      '[Convert]::ToBase64String($plain)',
    ].join(' ')
    const out = await this.runPowerShell(script)
    if (!out) throw new Error('DPAPI Unprotect produced no output')
    return Buffer.from(out, 'base64')
  }
}

/**
 * No-op protector for non-Windows platforms. `protect`/`unprotect` are the
 * identity function: the salt is stored as-is (still 0600). This keeps the
 * Linux build and CI green without DPAPI, and preserves the KAN-60 behaviour
 * on platforms where the agent is not officially shipped.
 */
export class PassthroughProtector implements KeyMaterialProtector {
  readonly bindsToOsKeystore = false

  async protect(plain: Buffer): Promise<Buffer> {
    return Buffer.from(plain)
  }

  async unprotect(wrapped: Buffer): Promise<Buffer> {
    return Buffer.from(wrapped)
  }
}

/**
 * Returns the protector appropriate for the current platform: real DPAPI on
 * Windows, passthrough everywhere else.
 */
export function defaultKeyMaterialProtector(): KeyMaterialProtector {
  return isWindows() ? new DpapiProtector() : new PassthroughProtector()
}
