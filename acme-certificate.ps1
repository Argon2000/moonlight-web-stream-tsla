<#
.SYNOPSIS
    Obtains a Let's Encrypt SSL certificate using the server's built-in ACME challenge handler.

.DESCRIPTION
    This script automates the ACME HTTP-01 challenge flow:
    1. Generates an account key (or reuses existing one)
    2. Requests a certificate from Let's Encrypt
    3. Sets the challenge token via the server's authenticated API
    4. Waits for validation
    5. Downloads the certificate and private key
    6. Optionally updates the server config to use the new certificate

.PARAMETER Domain
    The domain name to obtain a certificate for (e.g., "my.domain.com")

.PARAMETER ServerUrl
    The URL of your moonlight-web server (default: http://localhost:8080)

.PARAMETER SessionToken
    Your session token for the server API (from browser localStorage "mlSession")

.PARAMETER OutputDir
    Directory to save the certificate files (default: ./server/certs)

.PARAMETER Staging
    Use Let's Encrypt staging environment (for testing, avoids rate limits)

.EXAMPLE
    .\acme-certificate.ps1 -Domain "myhost.asuscomm.com" -SessionToken "your-session-token"
#>

param(
    [string]$Domain = "",

    [string]$ServerUrl = "",

    [string]$SessionToken = "",

    [string]$OutputDir = "",

    [switch]$Staging
)

$ErrorActionPreference = "Continue"

# Resolve OutputDir to an absolute path anchored to the script's own directory.
# This prevents failures when the script is launched from a different working directory
# (e.g. C:\WINDOWS\system32 when re-launched as Administrator via UAC).
if (-not $OutputDir) { $OutputDir = "server" }
if (-not [System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir = Join-Path $PSScriptRoot $OutputDir
}


# Keep the window open on unhandled errors so the user can read the message.
trap {
    Write-Host ""
    Write-Host "[ERROR] Script failed:" -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Red
    Write-Host ""
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
    Write-Host ""
    Read-Host "Press Enter to close"
    break
}

Write-Host "=== Moonlight Web ACME Certificate Tool ===" -ForegroundColor Cyan
Write-Host ""

# Prompt for Domain if not provided
if (-not $Domain) {
    Write-Host "Enter the domain name to obtain a certificate for." -ForegroundColor Yellow
    Write-Host "  Example: myhost.asuscomm.com" -ForegroundColor DarkGray
    $Domain = (Read-Host "Domain").Trim()
    if (-not $Domain) { Write-Error "Domain is required."; exit 1 }
}

# Prompt for ServerUrl if not provided
if (-not $ServerUrl) {
    # Try to read bind_address from server/config.json
    $defaultUrl = "http://localhost:43780"
    $configPath = Join-Path $OutputDir "config.json"
    if (Test-Path $configPath) {
        try {
            $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
            if ($cfg.bind_address) {
                # bind_address is "ip:port" — build a URL from it
                $defaultUrl = "http://$($cfg.bind_address)"
                Write-Host "  (Detected server address from config.json: $defaultUrl)" -ForegroundColor DarkGray
            }
        } catch {
            # Ignore parse errors, fall back to default
        }
    }

    Write-Host ""
    Write-Host "Enter the URL of your Moonlight Web server (used to set the challenge token)." -ForegroundColor Yellow
    Write-Host "  Example: http://192.168.1.100:43780" -ForegroundColor DarkGray
    Write-Host "  Note: port 80 must be forwarded to this server on your router for Let's Encrypt validation." -ForegroundColor DarkGray
    $URL = (Read-Host "Server URL [$defaultUrl]").Trim()
    $ServerUrl = if ($URL) { $URL } else { $defaultUrl }
}

Write-Host ""
Write-Host "Domain: $Domain"
Write-Host "Server: $ServerUrl"
Write-Host "ACME:   $(if ($Staging) { 'STAGING' } else { 'PRODUCTION' })"
Write-Host ""

# ACME directory URLs
$acmeDir = if ($Staging) {
    "https://acme-staging-v02.api.letsencrypt.org/directory"
} else {
    "https://acme-v02.api.letsencrypt.org/directory"
}

# Ensure output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# Helper: Base64url encode
function ConvertTo-Base64Url([byte[]]$bytes) {
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# Helper: Encode RSA private key as PKCS#1 PEM (works on .NET Framework 4.x / PowerShell 5.1)
# ExportRSAPrivateKey() is .NET Core 3.0+ only; this uses ExportParameters instead.
function ConvertTo-DerLength([int]$len) {
    if ($len -lt 0x80) {
        return [byte[]]@($len)
    } elseif ($len -lt 0x100) {
        return [byte[]]@(0x81, [byte]$len)
    } else {
        return [byte[]]@(0x82, [byte](($len -shr 8) -band 0xFF), [byte]($len -band 0xFF))
    }
}
function ConvertTo-DerInteger([byte[]]$bytes) {
    # Strip leading zeros (keep at least one byte)
    $i = 0
    while ($i -lt ($bytes.Length - 1) -and $bytes[$i] -eq 0) { $i++ }
    if ($i -gt 0) { $bytes = $bytes[$i..($bytes.Length - 1)] }
    # Prepend 0x00 if high bit is set (prevent sign bit misinterpretation)
    if ($bytes[0] -band 0x80) { $bytes = [byte[]]@(0x00) + $bytes }
    return [byte[]]@(0x02) + (ConvertTo-DerLength $bytes.Length) + $bytes
}
function Export-RsaPrivateKeyPem([System.Security.Cryptography.RSA]$rsa) {
    $p = $rsa.ExportParameters($true)
    $version = [byte[]]@(0x02, 0x01, 0x00)  # INTEGER 0
    $seq = $version +
           (ConvertTo-DerInteger $p.Modulus) +
           (ConvertTo-DerInteger $p.Exponent) +
           (ConvertTo-DerInteger $p.D) +
           (ConvertTo-DerInteger $p.P) +
           (ConvertTo-DerInteger $p.Q) +
           (ConvertTo-DerInteger $p.DP) +
           (ConvertTo-DerInteger $p.DQ) +
           (ConvertTo-DerInteger $p.InverseQ)
    $der = [byte[]]@(0x30) + (ConvertTo-DerLength $seq.Length) + $seq
    $b64 = [Convert]::ToBase64String($der, [System.Base64FormattingOptions]::InsertLineBreaks)
    return "-----BEGIN RSA PRIVATE KEY-----`n$b64`n-----END RSA PRIVATE KEY-----`n"
}

# Helper: Make request to our server
function Invoke-ServerApi {
    param([string]$Method, [string]$Path, [string]$Body = $null)
    $headers = @{ "Content-Type" = "text/plain" }
    if ($SessionToken) { $headers["Authorization"] = "Bearer $SessionToken" }
    $uri = "$ServerUrl$Path"
    if ($Body) {
        Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Body $Body
    } else {
        Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers
    }
}

# Helper: JWS-signed ACME request using .NET crypto
function New-AcmeRequest {
    param([string]$Url, [object]$Payload, [string]$Nonce, [object]$AccountKey, [string]$Kid = $null)

    $header = @{}
    if ($Kid) {
        $header["alg"] = "RS256"
        $header["kid"] = $Kid
        $header["nonce"] = $Nonce
        $header["url"] = $Url
    } else {
        $params = $AccountKey.ExportParameters($false)
        $jwk = @{
            "kty" = "RSA"
            "n" = ConvertTo-Base64Url $params.Modulus
            "e" = ConvertTo-Base64Url $params.Exponent
        }
        $header["alg"] = "RS256"
        $header["jwk"] = $jwk
        $header["nonce"] = $Nonce
        $header["url"] = $Url
    }

    $headerJson = $header | ConvertTo-Json -Compress
    $headerB64 = ConvertTo-Base64Url ([System.Text.Encoding]::UTF8.GetBytes($headerJson))

    if ($null -eq $Payload) {
        $payloadB64 = ""
    } elseif ($Payload -eq "") {
        $payloadB64 = ""
    } else {
        $payloadJson = $Payload | ConvertTo-Json -Compress
        $payloadB64 = ConvertTo-Base64Url ([System.Text.Encoding]::UTF8.GetBytes($payloadJson))
    }

    $signingInput = "$headerB64.$payloadB64"
    $inputBytes = [System.Text.Encoding]::UTF8.GetBytes($signingInput)
    $sigBytes = $AccountKey.SignData($inputBytes, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $sigB64 = ConvertTo-Base64Url $sigBytes

    return @{
        "protected" = $headerB64
        "payload" = $payloadB64
        "signature" = $sigB64
    } | ConvertTo-Json -Compress
}

# Helper: Get JWK thumbprint
function Get-JwkThumbprint([object]$AccountKey) {
    $params = $AccountKey.ExportParameters($false)
    $jwk = '{"e":"' + (ConvertTo-Base64Url $params.Exponent) + '","kty":"RSA","n":"' + (ConvertTo-Base64Url $params.Modulus) + '"}'
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($jwk))
    return ConvertTo-Base64Url $hash
}

# Helper: get nonce
function Get-Nonce([string]$NewNonceUrl) {
    $resp = Invoke-WebRequest -Uri $NewNonceUrl -Method Head -UseBasicParsing
    return $resp.Headers["Replay-Nonce"]
}

# Step 1: Generate or load account key
$accountKeyPath = Join-Path $OutputDir "acme-account-key.xml"
$keyWasLoaded = Test-Path $accountKeyPath
if ($keyWasLoaded) {
    Write-Host "[1/7] Loading existing account key..." -ForegroundColor Yellow
    $rsa = [System.Security.Cryptography.RSA]::Create()
    $rsa.FromXmlString((Get-Content $accountKeyPath -Raw))
} else {
    Write-Host "[1/7] Generating new account key (RSA 2048)..." -ForegroundColor Yellow
    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    [System.IO.File]::WriteAllText($accountKeyPath, $rsa.ToXmlString($true), (New-Object System.Text.UTF8Encoding $true))
}

# Step 2: Get ACME directory
Write-Host "[2/7] Fetching ACME directory..." -ForegroundColor Yellow
$directory = Invoke-RestMethod -Uri $acmeDir
$newNonceUrl = $directory.newNonce
$newAccountUrl = $directory.newAccount
$newOrderUrl = $directory.newOrder

# Step 3: Create/find account
Write-Host "[3/7] Registering ACME account..." -ForegroundColor Yellow

if ($keyWasLoaded) {
    # Verify the loaded key is registered on THIS ACME endpoint (staging vs production are separate).
    # If the key was registered elsewhere or the account was deleted, we must create a new key.
    $nonce = Get-Nonce $newNonceUrl
    $checkPayload = @{ "onlyReturnExisting" = $true }
    $body = New-AcmeRequest -Url $newAccountUrl -Payload $checkPayload -Nonce $nonce -AccountKey $rsa
    try {
        $response = Invoke-WebRequest -Uri $newAccountUrl -Method Post -Body $body `
            -ContentType "application/jose+json" -UseBasicParsing
        $accountUrl = $response.Headers["Location"].Trim()
        Write-Host "  Existing account: $accountUrl"
    } catch {
        # Only discard the key if Let's Encrypt explicitly says the account doesn't exist.
        # For any other error (bad nonce, network, JWS issue) re-throw so the user sees it.
        $errBody = ""
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $errBody = $reader.ReadToEnd()
            $reader.Close()
        } catch {}
        if ($errBody -notmatch "accountDoesNotExist") {
            Write-Host "  ACME account check failed unexpectedly:" -ForegroundColor Red
            Write-Host "  $errBody" -ForegroundColor Red
            throw
        }
        Write-Host "  Loaded key has no account on this ACME server. Generating a new key..." -ForegroundColor Yellow
        Remove-Item $accountKeyPath -Force
        $rsa = [System.Security.Cryptography.RSA]::Create(2048)
        [System.IO.File]::WriteAllText($accountKeyPath, $rsa.ToXmlString($true), (New-Object System.Text.UTF8Encoding $true))
        $keyWasLoaded = $false
    }
}

if (-not $keyWasLoaded) {
    $nonce = Get-Nonce $newNonceUrl
    $accountPayload = @{ "termsOfServiceAgreed" = $true }
    $body = New-AcmeRequest -Url $newAccountUrl -Payload $accountPayload -Nonce $nonce -AccountKey $rsa
    $response = Invoke-WebRequest -Uri $newAccountUrl -Method Post -Body $body `
        -ContentType "application/jose+json" -UseBasicParsing
    $accountUrl = $response.Headers["Location"].Trim()
    Write-Host "  New account: $accountUrl"
    Write-Host "  Waiting for account to propagate..." -ForegroundColor Yellow
    Start-Sleep -Seconds 8
}

# Step 4: Create order
Write-Host "[4/7] Creating certificate order for $Domain..." -ForegroundColor Yellow
$orderPayload = @{
    "identifiers" = @(
        @{ "type" = "dns"; "value" = $Domain }
    )
}
$order = $null
$orderUrl = $null
for ($attempt = 1; $attempt -le 5; $attempt++) {
    $nonce = Get-Nonce $newNonceUrl
    $body = New-AcmeRequest -Url $newOrderUrl -Payload $orderPayload -Nonce $nonce -AccountKey $rsa -Kid $accountUrl
    try {
        $response = Invoke-WebRequest -Uri $newOrderUrl -Method Post -Body $body -ContentType "application/jose+json" -UseBasicParsing
        $order = $response.Content | ConvertFrom-Json
        $orderUrl = $response.Headers["Location"].Trim()
        break
    } catch {
        $errBody = ""
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $errBody = $reader.ReadToEnd()
            $reader.Close()
        } catch {}
        if ($errBody -match "accountDoesNotExist" -and $attempt -lt 5) {
            Write-Host "  Account not yet propagated, retrying in 3s (attempt $attempt/5)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        } else {
            throw
        }
    }
}
Write-Host "  Order status: $($order.status)"

# Step 5: Process authorization (HTTP-01 challenge)
Write-Host "[5/7] Setting up HTTP-01 challenge..." -ForegroundColor Yellow
$authzUrl = $order.authorizations[0]
$authz = $null
for ($attempt = 1; $attempt -le 5; $attempt++) {
    $nonce = Get-Nonce $newNonceUrl
    $body = New-AcmeRequest -Url $authzUrl -Payload "" -Nonce $nonce -AccountKey $rsa -Kid $accountUrl
    try {
        $response = Invoke-WebRequest -Uri $authzUrl -Method Post -Body $body -ContentType "application/jose+json" -UseBasicParsing
        $authz = $response.Content | ConvertFrom-Json
        break
    } catch {
        $errBody = ""
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $errBody = $reader.ReadToEnd()
            $reader.Close()
        } catch {}
        if ($errBody -match "No such authorization" -and $attempt -lt 5) {
            Write-Host "  Authorization not yet propagated, retrying in 3s (attempt $attempt/5)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        } else {
            throw
        }
    }
}

$httpChallenge = $authz.challenges | Where-Object { $_.type -eq "http-01" }
if (-not $httpChallenge) {
    Write-Error "No HTTP-01 challenge available!"
    exit 1
}

$token = $httpChallenge.token
$thumbprint = Get-JwkThumbprint $rsa
$keyAuth = "$token.$thumbprint"

Write-Host "  Token: $token"
Write-Host "  Key Authorization: $($keyAuth.Substring(0, 40))..."

# Set the challenge on our server
Write-Host "  Setting challenge on server..." -ForegroundColor Yellow
try {
    Invoke-ServerApi -Method "PUT" -Path "/api/acme/challenge/$token" -Body $keyAuth
    Write-Host "  Challenge set successfully!" -ForegroundColor Green
} catch {
    $errMsg = $_.ToString()
    Write-Error "Failed to set challenge on server: $errMsg"
    if ($errMsg -match "501") {
        Write-Host ""
        Write-Host "  501 Not Implemented means your web-server binary is outdated." -ForegroundColor Red
        Write-Host "  The ACME API endpoints were added in a recent build." -ForegroundColor Red
        Write-Host "  Please replace web-server.exe with a current build and restart." -ForegroundColor Red
    } elseif ($errMsg -match "404") {
        Write-Host "  Make sure the server is running at: $ServerUrl" -ForegroundColor Yellow
    } else {
        Write-Host "  Make sure the server is running and reachable at: $ServerUrl" -ForegroundColor Yellow
    }
    exit 1
}

# Verify it's accessible
Write-Host "  Verifying challenge is accessible..."
try {
    $verify = Invoke-RestMethod -Uri "$ServerUrl/.well-known/acme-challenge/$token" -Method Get
    if ($verify -eq $keyAuth) {
        Write-Host "  Verification OK!" -ForegroundColor Green
    } else {
        Write-Warning "  Challenge response doesn't match! Got: $verify"
    }
} catch {
    Write-Warning "  Could not verify locally (this might be OK if server is on a different machine)"
}

# Step 6: Notify ACME server we're ready
Write-Host "[6/7] Notifying ACME server to validate..." -ForegroundColor Yellow
$challengeUrl = $httpChallenge.url
$nonce = Get-Nonce $newNonceUrl
$body = New-AcmeRequest -Url $challengeUrl -Payload @{} -Nonce $nonce -AccountKey $rsa -Kid $accountUrl
$response = Invoke-WebRequest -Uri $challengeUrl -Method Post -Body $body -ContentType "application/jose+json" -UseBasicParsing

# Poll for validation
$maxAttempts = 30
for ($i = 0; $i -lt $maxAttempts; $i++) {
    Start-Sleep -Seconds 2
    $pollOk = $false
    for ($retry = 1; $retry -le 5; $retry++) {
        $nonce = Get-Nonce $newNonceUrl
        $body = New-AcmeRequest -Url $authzUrl -Payload "" -Nonce $nonce -AccountKey $rsa -Kid $accountUrl
        try {
            $response = Invoke-WebRequest -Uri $authzUrl -Method Post -Body $body -ContentType "application/jose+json" -UseBasicParsing
            $authz = $response.Content | ConvertFrom-Json
            $pollOk = $true
            break
        } catch {
            $errBody = ""
            try { $stream = $_.Exception.Response.GetResponseStream(); $reader = New-Object System.IO.StreamReader($stream); $errBody = $reader.ReadToEnd(); $reader.Close() } catch {}
            if ($errBody -match "accountDoesNotExist" -and $retry -lt 5) {
                Start-Sleep -Seconds 3
            } else { throw }
        }
    }
    if (-not $pollOk) { throw "Authorization poll failed after retries" }
    $authz = $response.Content | ConvertFrom-Json
    Write-Host "  Authorization status: $($authz.status)" -NoNewline
    if ($authz.status -eq "valid") {
        Write-Host " - Success!" -ForegroundColor Green
        break
    } elseif ($authz.status -eq "invalid") {
        Write-Host ""
        $detail = ($authz.challenges | Where-Object { $_.type -eq "http-01" }).error.detail
        Write-Error "Challenge validation failed: $detail"
        # Cleanup
        Invoke-ServerApi -Method "DELETE" -Path "/api/acme/challenge/$token" 2>$null
        exit 1
    }
    Write-Host ""
}

# Cleanup challenge
Invoke-ServerApi -Method "DELETE" -Path "/api/acme/challenge/$token" 2>$null

# Step 7: Finalize order and download certificate
Write-Host "[7/7] Finalizing order and downloading certificate..." -ForegroundColor Yellow

# Generate CSR
$certKey = [System.Security.Cryptography.RSA]::Create(2048)
$certReq = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=$Domain", $certKey, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$csrDer = $certReq.CreateSigningRequest()
$csrB64 = ConvertTo-Base64Url $csrDer

# Finalize
$nonce = Get-Nonce $newNonceUrl
$finalizePayload = @{ "csr" = $csrB64 }
$body = New-AcmeRequest -Url $order.finalize -Payload $finalizePayload -Nonce $nonce -AccountKey $rsa -Kid $accountUrl
$response = Invoke-WebRequest -Uri $order.finalize -Method Post -Body $body -ContentType "application/jose+json" -UseBasicParsing
$order = $response.Content | ConvertFrom-Json

# Poll order until ready
for ($i = 0; $i -lt $maxAttempts; $i++) {
    if ($order.status -eq "valid") { break }
    Start-Sleep -Seconds 2
    $nonce = Get-Nonce $newNonceUrl
    $body = New-AcmeRequest -Url $orderUrl -Payload "" -Nonce $nonce -AccountKey $rsa -Kid $accountUrl
    $response = Invoke-WebRequest -Uri $orderUrl -Method Post -Body $body -ContentType "application/jose+json" -UseBasicParsing
    $order = $response.Content | ConvertFrom-Json
    Write-Host "  Order status: $($order.status)"
}

if ($order.status -ne "valid") {
    Write-Error "Order did not become valid in time"
    exit 1
}

# Download certificate
$nonce = Get-Nonce $newNonceUrl
$body = New-AcmeRequest -Url $order.certificate -Payload "" -Nonce $nonce -AccountKey $rsa -Kid $accountUrl
$response = Invoke-WebRequest -Uri $order.certificate -Method Post -Body $body -ContentType "application/jose+json" -UseBasicParsing
# .Content is a byte[] in PS5.1 with -UseBasicParsing; decode to string
if ($response.Content -is [byte[]]) {
    $certPem = [System.Text.Encoding]::UTF8.GetString($response.Content)
} else {
    $certPem = $response.Content
}

# Export private key as PEM (compatible with .NET Framework / PowerShell 5.1)
$keyPem = Export-RsaPrivateKeyPem $certKey

# Save files
$certPath = Join-Path $OutputDir "cert.pem"
$keyPath = Join-Path $OutputDir "key.pem"
[System.IO.File]::WriteAllText($certPath, $certPem)
[System.IO.File]::WriteAllText($keyPath, $keyPem)

Write-Host ""
Write-Host "=== Certificate obtained successfully! ===" -ForegroundColor Green
Write-Host "  Certificate: $certPath"
Write-Host "  Private Key: $keyPath"
Write-Host ""

# Update config.json with the certificate paths (create certificate block if missing)
$configPath = Join-Path $OutputDir "config.json"
$certAbsPath = $certPath  # already an absolute path
$keyAbsPath  = $keyPath   # already an absolute path

if (Test-Path $configPath) {
    try {
        $json = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)

        if ($json -match '"certificate"\s*:\s*\{') {
            # Block already exists with an object value — update just the two values in-place, preserving all formatting
            $certEscaped = $certAbsPath -replace '\\', '\\\\'
            $keyEscaped  = $keyAbsPath  -replace '\\', '\\\\'
            $json = $json -replace '("certificate_pem"\s*:\s*)"[^"]*"', ('$1"' + $certEscaped + '"')
            $json = $json -replace '("private_key_pem"\s*:\s*)"[^"]*"', ('$1"' + $keyEscaped + '"')
            Write-Host "  Updating certificate config in $configPath..." -ForegroundColor Yellow
        } elseif ($json -match '"certificate"\s*:\s*null') {
            # Null placeholder — replace the whole null value with the certificate object
            $certEscaped = $certAbsPath -replace '\\', '\\\\'
            $keyEscaped  = $keyAbsPath  -replace '\\', '\\\\'
            $indentMatch = [regex]::Match($json, '(?m)^(\s+)"')
            $indent = if ($indentMatch.Success) { $indentMatch.Groups[1].Value } else { '  ' }
            $inner  = $indent + '  '
            $block  = "{`r`n${inner}`"certificate_pem`": `"$certEscaped`",`r`n${inner}`"private_key_pem`": `"$keyEscaped`"`r`n${indent}}"
            $json = $json -replace '"certificate"\s*:\s*null', ('"certificate": ' + $block)
            Write-Host "  Adding certificate config to $configPath..." -ForegroundColor Yellow
        } else {
            # No certificate block yet — insert one before the root closing brace.
            # Detect indentation from the first quoted key in the file.
            $certEscaped = $certAbsPath -replace '\\', '\\\\'
            $keyEscaped  = $keyAbsPath  -replace '\\', '\\\\'
            $indentMatch = [regex]::Match($json, '(?m)^(\s+)"')
            $indent = if ($indentMatch.Success) { $indentMatch.Groups[1].Value } else { '  ' }
            $inner  = $indent + '  '
            $block  = ",`r`n${indent}`"certificate`": {`r`n${inner}`"certificate_pem`": `"$certEscaped`",`r`n${inner}`"private_key_pem`": `"$keyEscaped`"`r`n${indent}}"
            # Insert immediately before the final closing brace
            $lastBrace = $json.LastIndexOf('}')
            $json = $json.Substring(0, $lastBrace).TrimEnd() + $block + "`r`n}"
            Write-Host "  Adding certificate config to $configPath..." -ForegroundColor Yellow
        }

        [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding $true))
        Write-Host "  Config updated. Restart the server to apply the certificate." -ForegroundColor Green
    } catch {
        Write-Warning "Could not update config.json automatically: $_"
        Write-Host "  Add this to $configPath manually:" -ForegroundColor Cyan
        Write-Host "  `"certificate`": { `"certificate_pem`": `"$certAbsPath`", `"private_key_pem`": `"$keyAbsPath`" }"
    }
} else {
    Write-Host "  config.json not found at $configPath" -ForegroundColor Yellow
    Write-Host "  Add this to your config.json manually:" -ForegroundColor Cyan
    Write-Host "  `"certificate`": { `"certificate_pem`": `"$certAbsPath`", `"private_key_pem`": `"$keyAbsPath`" }"
}
Write-Host ""
Read-Host "Press Enter to close"
exit 0