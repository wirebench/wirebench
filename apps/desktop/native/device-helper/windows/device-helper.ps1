# Wirebench's device helper for Windows (#428): makes and uses SSH keys held by Windows Hello.
#
# Experimental until checked on a Windows machine with Hello set up. Runs in Windows PowerShell 5.1, which
# ships with Windows. Main runs it as `powershell.exe -NoProfile -NonInteractive -EncodedCommand <this
# script + one call of Invoke-DeviceHelper>`, the request passed as base64 JSON, so no execution policy
# applies and nothing is read from stdin. It answers one JSON object on stdout, the same protocol as the
# macOS helper: `status`, `create`, `check`, `sign`, `unlock`, and `{ "error": code, "message": text }` with code
# `cancelled`, `missing`, `unsupported` or `failed`.
#
# A key is a Windows Hello key credential (KeyCredentialManager): RSA-2048, signing PKCS#1 v1.5 over
# SHA-256, kept in this user's Hello container on this PC. The handle Wirebench stores is its name.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Answer([hashtable] $Answer, [int] $Code) {
  [Console]::Out.Write(($Answer | ConvertTo-Json -Compress))
  exit $Code
}

function Write-Failure([string] $Code, [string] $Message) {
  Write-Answer @{ error = $Code; message = $Message } 1
}

function Import-WinRt {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime]
    $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
    $null = [Windows.Security.Cryptography.CryptographicBuffer, Windows.Security.Cryptography, ContentType = WindowsRuntime]
  } catch {
    Write-Failure 'unsupported' 'This version of Windows has no Windows Hello key API'
  }
  # WinRT's IAsyncOperation<T> as a .NET task, waited for: PowerShell 5.1 has no await.
  $script:AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
}

function Wait-Operation($Operation, [Type] $ResultType) {
  $task = $script:AsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $null = $task.Wait(-1)
  $task.Result
}

function Get-Field($Request, [string] $Name) {
  $value = $Request.$Name
  if ([string]::IsNullOrEmpty($value)) { Write-Failure 'failed' "The request has no $Name" }
  [string] $value
}

function Invoke-DeviceHelper([string] $Command, [string] $RequestBase64) {
  $request = @{}
  if ($RequestBase64 -ne '') {
    try {
      $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
    } catch {
      Write-Failure 'failed' 'The request is not a JSON object'
    }
  }
  Import-WinRt
  $manager = [Windows.Security.Credentials.KeyCredentialManager]
  $buffers = [Windows.Security.Cryptography.CryptographicBuffer]
  $status = [Windows.Security.Credentials.KeyCredentialStatus]
  $retrieval = [Windows.Security.Credentials.KeyCredentialRetrievalResult]
  switch ($Command) {
    'status' {
      if (Wait-Operation ($manager::IsSupportedAsync()) ([bool])) { Write-Answer @{ supported = $true } 0 }
      Write-Answer @{ supported = $false; reason = 'Windows Hello is not set up on this PC' } 0
    }
    'create' {
      $name = 'wirebench-' + [guid]::NewGuid().ToString('N')
      $option = [Windows.Security.Credentials.KeyCredentialCreationOption]::FailIfExists
      $made = Wait-Operation ($manager::RequestCreateAsync($name, $option)) $retrieval
      if ($made.Status -eq $status::UserCanceled) { Write-Failure 'cancelled' 'The prompt was cancelled' }
      if ($made.Status -ne $status::Success) { Write-Failure 'failed' "Windows Hello did not make the key ($($made.Status))" }
      $publicKey = $buffers::EncodeToBase64String($made.Credential.RetrievePublicKey())
      Write-Answer @{ publicKey = $publicKey; handle = $name } 0
    }
    'check' {
      # Whether this PC's Hello container holds the key; opening it asks for nothing.
      $opened = Wait-Operation ($manager::OpenAsync((Get-Field $request 'handle'))) $retrieval
      Write-Answer @{ present = ($opened.Status -eq $status::Success) } 0
    }
    'sign' {
      $name = Get-Field $request 'handle'
      $data = $buffers::DecodeFromBase64String((Get-Field $request 'data'))
      $opened = Wait-Operation ($manager::OpenAsync($name)) $retrieval
      if ($opened.Status -eq $status::NotFound) { Write-Failure 'missing' 'Windows Hello on this PC does not hold the key' }
      if ($opened.Status -ne $status::Success) { Write-Failure 'failed' "Windows Hello did not open the key ($($opened.Status))" }
      $operation = [Windows.Security.Credentials.KeyCredentialOperationResult]
      $signed = Wait-Operation ($opened.Credential.RequestSignAsync($data)) $operation
      if ($signed.Status -eq $status::UserCanceled) { Write-Failure 'cancelled' 'The prompt was cancelled' }
      if ($signed.Status -ne $status::Success) { Write-Failure 'failed' "Windows Hello did not sign ($($signed.Status))" }
      Write-Answer @{ signature = $buffers::EncodeToBase64String($signed.Result) } 0
    }
    'unlock' {
      $verifier = [Windows.Security.Credentials.UI.UserConsentVerifier]
      $results = [Windows.Security.Credentials.UI.UserConsentVerificationResult]
      $result = Wait-Operation ($verifier::RequestVerificationAsync((Get-Field $request 'reason'))) $results
      if ($result -eq $results::Verified) { Write-Answer @{ ok = $true } 0 }
      if ($result -eq $results::Canceled) { Write-Failure 'cancelled' 'The prompt was cancelled' }
      if ($result -in @($results::DeviceNotPresent, $results::NotConfiguredForUser, $results::DisabledByPolicy)) {
        Write-Failure 'unsupported' "Windows Hello cannot ask on this PC ($result)"
      }
      Write-Failure 'failed' "Windows Hello did not verify ($result)"
    }
    default { Write-Failure 'failed' "Unknown command $Command" }
  }
}
