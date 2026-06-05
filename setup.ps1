<#
.SYNOPSIS
    Interactive setup wizard for Moonlight Web (Tesla-optimized).

.DESCRIPTION
    Walks through all configuration needed to stream to a Tesla browser:
    - Sets password
    - Detects/configures LAN and WAN IPs
    - Configures ports and firewall rules
    - Sets up a domain name (or helps create one via DuckDNS)
    - Obtains an SSL certificate (Let's Encrypt or user-provided)
    - Schedules automatic certificate renewal
    - Starts the server and verifies connectivity

.EXAMPLE
    .\setup.ps1
#>

$ErrorActionPreference = "Continue"

# Always run from the script's own directory so relative paths (server/, acme-certificate.ps1, etc.)
# resolve correctly regardless of where PowerShell was launched from.
Set-Location $PSScriptRoot

# ─── Self-elevation ────────────────────────────────────────────────────────────
# Firewall rules, scheduled tasks, and UPnP all require administrator rights.
# If not already elevated, relaunch this script with a UAC prompt.

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Requesting administrator access (UAC prompt)..." -ForegroundColor Yellow
    $scriptPath = $MyInvocation.MyCommand.Path
    # Preserve the working directory so relative paths (server/, etc.) still resolve correctly
    $escapedPwd = $PWD.Path -replace "'", "''"
    Start-Process powershell.exe -Verb RunAs -ArgumentList `
        "-NoProfile -ExecutionPolicy Bypass -Command `"Set-Location '$escapedPwd'; & '$scriptPath'`""
    exit
}

# Keep the window open on unhandled errors so the user can read the message.
trap {
    Write-Host ""
    Write-Host "[ERROR] Setup failed:" -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Red
    Write-Host ""
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkRed
    Write-Host ""
    Read-Host "Press Enter to close"
    break
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) { Write-Host "`n━━━ $msg ━━━" -ForegroundColor Cyan }

# UPnP IGD helpers — SSDP discovery + direct SOAP to the router.
# HNetCfg.NATUPnP only controls Windows ICS (local NAT), NOT an external router.
# This implementation uses proper UPnP IGD protocol over HTTP/SOAP.
#
# The gateway is discovered once via SSDP and cached for the session so the
# UDP port loop doesn't re-discover 100+ times.
$script:_upnpGw      = $null
$script:_upnpGwTried = $false

function Get-UPnPGateway {
    param([string]$LocalIp = "")
    if ($script:_upnpGwTried) { return $script:_upnpGw }
    $script:_upnpGwTried = $true
    try {
        $gatewayIp = $null
        if ($LocalIp -match '^(\d+\.\d+\.\d+)\.\d+$') { $gatewayIp = "$($matches[1]).1" }
        try {
            $rtGw = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop |
                     Sort-Object RouteMetric | Select-Object -First 1).NextHop
            if ($rtGw -and $rtGw -ne "0.0.0.0") { $gatewayIp = $rtGw }
        } catch {}

        # Get LOCATION headers from a UDP socket, reading all responses until timeout.
        function Get-SSDP([System.Net.Sockets.UdpClient]$sock, [string]$dest, [int]$dport, [string]$st) {
            $msg = "M-SEARCH * HTTP/1.1`r`nHOST: ${dest}:${dport}`r`nMAN: `"ssdp:discover`"`r`nMX: 3`r`nST: $st`r`n`r`n"
            $bytes = [Text.Encoding]::ASCII.GetBytes($msg)
            $null = $sock.Send($bytes, $bytes.Length, $dest, $dport)
            $locs = @()
            for ($i = 0; $i -lt 12; $i++) {
                try {
                    $remote = New-Object Net.IPEndPoint([Net.IPAddress]::Any, 0)
                    $resp = [Text.Encoding]::ASCII.GetString($sock.Receive([ref]$remote))
                    if ($resp -match '(?im)^LOCATION:\s*(\S+)') { $locs += $matches[1].Trim() }
                } catch { break }
            }
            return $locs
        }

        # Gather all responding SSDP locations across multiple search targets + unicast fallback.
        # Use a hashtable to deduplicate while preserving insertion order.
        $seen = @{}
        $allLocs = @()

        $searchTargets = @(
            "upnp:rootdevice",
            "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
            "urn:schemas-upnp-org:service:WANIPConnection:1"
        )
        foreach ($st in $searchTargets) {
            if ($LocalIp) {
                try {
                    $udp = New-Object System.Net.Sockets.UdpClient
                    $udp.Client.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Parse($LocalIp), 0))
                    $udp.Client.ReceiveTimeout = 3500
                    foreach ($l in (Get-SSDP $udp "239.255.255.250" 1900 $st)) {
                        if (-not $seen.ContainsKey($l)) { $seen[$l] = $true; $allLocs += $l }
                    }
                    $udp.Close()
                } catch {}
            }
        }
        # Unicast fallback directly to gateway — covers routers that block multicast
        if ($gatewayIp) {
            try {
                $udp = New-Object System.Net.Sockets.UdpClient
                if ($LocalIp) { $udp.Client.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Parse($LocalIp), 0)) }
                $udp.Client.ReceiveTimeout = 3500
                foreach ($l in (Get-SSDP $udp $gatewayIp 1900 "upnp:rootdevice")) {
                    if (-not $seen.ContainsKey($l)) { $seen[$l] = $true; $allLocs += $l }
                }
                $udp.Close()
            } catch {}
        }

        if ($allLocs.Count -eq 0) {
            Write-Host "    [UPnP] SSDP: no devices responded (gateway=$gatewayIp)" -ForegroundColor Yellow
            return $null
        }

        # Sort: gateway-IP-matching locations first so we try the real router before virtual devices
        $sorted = @($allLocs | Where-Object { $gatewayIp -and $_ -match [regex]::Escape($gatewayIp) }) +
                  @($allLocs | Where-Object { -not ($gatewayIp -and $_ -match [regex]::Escape($gatewayIp)) })

        Write-Host "    [UPnP] Found $($allLocs.Count) device(s): $($sorted -join ', ')" -ForegroundColor DarkGray

        # Try each location in order — skip any that don't expose a WANIPConnection service
        foreach ($loc in $sorted) {
            $rawContent = $null
            try { $rawContent = (Invoke-WebRequest -Uri $loc -UseBasicParsing -TimeoutSec 5).Content }
            catch { Write-Host "    [UPnP] Could not fetch $loc`: $_" -ForegroundColor DarkGray; continue }

            # PS5.1 UseBasicParsing returns byte[] — decode to string
            $xml = if ($rawContent -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($rawContent) } else { $rawContent }

            $serviceMatches = [regex]::Matches($xml, '(?s)<service>(.*?)</service>')
            foreach ($m in $serviceMatches) {
                $block = $m.Groups[1].Value
                if ($block -match '<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:[^<]+)</serviceType>') {
                    $svcType = $matches[1].Trim()
                    if ($block -match '<controlURL>([^<]+)</controlURL>') {
                        $ctl = [Uri]::new([Uri]$loc, $matches[1].Trim()).ToString()
                        Write-Host "    [UPnP] Using gateway at $loc (control: $ctl)" -ForegroundColor DarkGray
                        $script:_upnpGw = @{ ControlUrl = $ctl; ServiceType = $svcType }
                        break
                    }
                }
            }
            if ($script:_upnpGw) { break }
            Write-Host "    [UPnP] $loc has no WANIPConnection service, skipping" -ForegroundColor DarkGray
        }

        if (-not $script:_upnpGw) {
            Write-Host "    [UPnP] No device with WANIPConnection found among $($allLocs.Count) responding device(s)" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "    [UPnP] Discovery exception: $_" -ForegroundColor Yellow
    }
    return $script:_upnpGw
}

function Invoke-UPnPSoap {
    param([hashtable]$Gw, [string]$Action, [string]$Body)
    $soap = @"
<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>$Body</s:Body>
</s:Envelope>
"@
    $resp = Invoke-WebRequest -Uri $Gw.ControlUrl -Method POST -Body $soap `
        -ContentType 'text/xml; charset="utf-8"' `
        -Headers @{ SOAPAction = "`"$($Gw.ServiceType)#$Action`"" } `
        -UseBasicParsing -ErrorAction Stop
    # PS5.1 UseBasicParsing returns Content as byte[] — normalise to string
    if ($resp.Content -is [byte[]]) {
        $resp | Add-Member -Force -MemberType NoteProperty -Name Content -Value ([System.Text.Encoding]::UTF8.GetString($resp.Content))
    }
    return $resp
}

function Invoke-UPnPPortMapping {
    param(
        [string]$LocalIp,
        [int]$ExternalPort,
        [int]$InternalPort,
        [string]$Protocol,   # "TCP" or "UDP"
        [string]$Description
    )
    $gw = Get-UPnPGateway -LocalIp $LocalIp
    if (-not $gw) { return $false }

    # Always delete first to clear any stale/conflicting mapping (error 718)
    try {
        Invoke-UPnPSoap $gw "DeletePortMapping" @"

    <u:DeletePortMapping xmlns:u="$($gw.ServiceType)">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>$ExternalPort</NewExternalPort>
      <NewProtocol>$Protocol</NewProtocol>
    </u:DeletePortMapping>
"@ | Out-Null
    } catch {}  # ignore 714 (no such entry) — that's fine

    try {
        $r = Invoke-UPnPSoap $gw "AddPortMapping" @"

    <u:AddPortMapping xmlns:u="$($gw.ServiceType)">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>$ExternalPort</NewExternalPort>
      <NewProtocol>$Protocol</NewProtocol>
      <NewInternalPort>$InternalPort</NewInternalPort>
      <NewInternalClient>$LocalIp</NewInternalClient>
      <NewEnabled>1</NewEnabled>
      <NewPortMappingDescription>$Description</NewPortMappingDescription>
      <NewLeaseDuration>0</NewLeaseDuration>
    </u:AddPortMapping>
"@
        if ($r.StatusCode -ne 200) { return $false }
        # Verify the mapping was actually stored — some routers accept SOAP but don't create the entry
        try {
            $qr = Invoke-UPnPSoap $gw "GetSpecificPortMappingEntry" @"

    <u:GetSpecificPortMappingEntry xmlns:u="$($gw.ServiceType)">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>$ExternalPort</NewExternalPort>
      <NewProtocol>$Protocol</NewProtocol>
    </u:GetSpecificPortMappingEntry>
"@
            if ($qr.Content -match '<NewInternalClient>([^<]+)</NewInternalClient>') { $qrIp = $matches[1] } else { $qrIp = $null }
            if ($qr.Content -match '<NewInternalPort>([^<]+)</NewInternalPort>')    { $qrPort = [int]$matches[1] } else { $qrPort = 0 }
            if ($qrIp -eq $LocalIp -and $qrPort -eq $InternalPort) {
                return $true  # confirmed: correct IP and port
            }
            if ($qrIp) {
                Write-Host "    [UPnP] Entry maps $Protocol/$ExternalPort to $qrIp`:$qrPort but expected $LocalIp`:$InternalPort — wrong device targeted?" -ForegroundColor Yellow
            } else {
                Write-Host "    [UPnP] AddPortMapping 200 OK but entry not found — router may be ignoring UPnP requests" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "    [UPnP] Verification failed: $_" -ForegroundColor Yellow
        }
        return $false
    } catch {
        $errStr = "$_"
        # 718 = ConflictInMappingEntry — a mapping already exists that we couldn't remove.
        # Check if it already points where we want; if so, accept it as success.
        if ($errStr -match '718') {
            try {
                $qr = Invoke-UPnPSoap $gw "GetSpecificPortMappingEntry" @"

    <u:GetSpecificPortMappingEntry xmlns:u="$($gw.ServiceType)">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>$ExternalPort</NewExternalPort>
      <NewProtocol>$Protocol</NewProtocol>
    </u:GetSpecificPortMappingEntry>
"@
                if ($qr.Content -match '<NewInternalClient>([^<]+)</NewInternalClient>' -and
                    $qr.Content -match '<NewInternalPort>([^<]+)</NewInternalPort>') {
                    $existingIp   = $matches[1]  # last match; re-check both
                    $qr.Content -match '<NewInternalClient>([^<]+)</NewInternalClient>' | Out-Null
                    $existingIp   = $matches[1]
                    $qr.Content -match '<NewInternalPort>([^<]+)</NewInternalPort>' | Out-Null
                    $existingPort = $matches[1]
                    if ($existingIp -eq $LocalIp -and [int]$existingPort -eq $InternalPort) {
                        return $true  # already mapped correctly
                    } else {
                        Write-Host "    [UPnP debug] $Protocol/$($ExternalPort) conflict: existing mapping is $existingIp/$existingPort (cannot override)" -ForegroundColor DarkGray
                        return $false
                    }
                }
            } catch {}
        }
        Write-Host "    [UPnP debug] AddPortMapping $Protocol/$($ExternalPort) failed: $errStr" -ForegroundColor DarkGray
        return $false
    }
}

function Remove-UPnPPortMapping {
    param([int]$ExternalPort, [string]$Protocol, [string]$LocalIp = "")
    $gw = Get-UPnPGateway -LocalIp $LocalIp
    if (-not $gw) { return }
    try {
        Invoke-UPnPSoap $gw "DeletePortMapping" @"

    <u:DeletePortMapping xmlns:u="$($gw.ServiceType)">
      <NewRemoteHost></NewRemoteHost>
      <NewExternalPort>$ExternalPort</NewExternalPort>
      <NewProtocol>$Protocol</NewProtocol>
    </u:DeletePortMapping>
"@ | Out-Null
    } catch {}
}
function Write-Info([string]$msg) { Write-Host "  $msg" -ForegroundColor DarkGray }
function Write-Ok([string]$msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }

function Get-Input([string]$prompt, [string]$default = "") {
    $suffix = if ($default) { " [$default]" } else { "" }
    $val = (Read-Host "$prompt$suffix").Trim()
    if (-not $val -and $default) { return $default }
    return $val
}

function Get-YesNo([string]$prompt, [bool]$default = $true) {
    $hint = if ($default) { "Y/n" } else { "y/N" }
    $val = (Read-Host "$prompt ($hint)").Trim().ToLower()
    if (-not $val) { return $default }
    return $val -eq "y" -or $val -eq "yes"
}

function Stop-ServerProcess {
    $procs = Get-Process -Name "web-server" -ErrorAction SilentlyContinue
    if ($procs) {
        Write-Host "  Stopping running web-server..." -ForegroundColor Yellow
        $procs | Stop-Process -Force
        Start-Sleep -Seconds 1
    }
}

function Start-ServerProcess {
    $exe = "./web-server.exe"
    if (-not (Test-Path $exe)) {
        $exe = "./web-server"
        if (-not (Test-Path $exe)) {
            Write-Warn "web-server executable not found in current directory!"
            return $false
        }
    }
    Write-Host "  Starting web-server..." -ForegroundColor Yellow
    Start-Process -FilePath (Resolve-Path $exe).Path -WorkingDirectory $PSScriptRoot -WindowStyle Minimized
    Start-Sleep -Seconds 2
    $proc = Get-Process -Name "web-server" -ErrorAction SilentlyContinue
    if ($proc) {
        Write-Ok "Server is running (PID: $($proc.Id))"
        return $true
    } else {
        Write-Warn "Server failed to start. Check the console output."
        return $false
    }
}

function Save-Config($config) {
    # Preserve certificate from disk if not set in memory.
    # acme-certificate.ps1 writes cert paths directly to config.json;
    # without this the final Save-Config at Step 10 would overwrite them.
    if (-not $config.certificate) {
        try {
            $onDisk = Get-Content "$PWD/server/config.json" -Raw -ErrorAction Stop | ConvertFrom-Json
            if ($onDisk.certificate) { $config.certificate = $onDisk.certificate }
        } catch {}
    }
    $json = $config | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText("$PWD/server/config.json", $json)
    Write-Ok "Saved server/config.json"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║      Moonlight Web - Interactive Setup Wizard        ║" -ForegroundColor Cyan
Write-Host "║                  (Tesla-optimized)                   ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Info "This wizard will configure your server for streaming to a Tesla browser."
Write-Info "Press Ctrl+C at any time to abort."
Write-Host ""

# ─── Step 1: Prerequisites ────────────────────────────────────────────────────

Write-Step "Step 1: Checking prerequisites"

if (-not (Test-Path "./server")) {
    New-Item -ItemType Directory -Path "./server" -Force | Out-Null
    Write-Ok "Created server/ directory"
}

$hasExe = (Test-Path "./web-server.exe") -or (Test-Path "./web-server")
if (-not $hasExe) {
    Write-Warn "web-server executable not found in current directory."
    Write-Warn "Make sure you run this script from the same folder as web-server.exe"
    if (-not (Get-YesNo "Continue anyway?")) { exit 0 }
}

# Load existing config or create default
$configPath = "./server/config.json"
if (Test-Path $configPath) {
    Write-Ok "Found existing server/config.json"
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
} else {
    Write-Info "No config found, creating fresh configuration."
    $config = [PSCustomObject]@{
        credentials = "default"
        totp_secret = $null
        data_path = "server/data.json"
        bind_address = "0.0.0.0:43780"
        moonlight_default_http_port = 47989
        pair_device_name = "roth"
        webrtc_ice_servers = @(
            [PSCustomObject]@{
                urls = @(
                    "stun:stun.cloudflare.com:3478",
                    "stun:stun.l.google.com:19302",
                    "stun:stun1.l.google.com:3478",
                    "stun:stun2.l.google.com:19302",
                    "stun:stun3.l.google.com:3478",
                    "stun:stun4.l.google.com:19302"
                )
                username = ""
                credential = ""
            }
        )
        webrtc_port_range = [PSCustomObject]@{ min = 40000; max = 40100 }
        webrtc_nat_1to1 = [PSCustomObject]@{
            ips = @()
            ice_candidate_type = "srflx"
        }
        webrtc_network_types = @("udp4")
        web_path_prefix = ""
        certificate = $null
        streamer_path = "./streamer"
    }
}

# ─── Step 2: Password ─────────────────────────────────────────────────────────

Write-Step "Step 2: Access credentials"
Write-Info "This password protects the web interface."

$currentCreds = $config.credentials
if ($currentCreds -and $currentCreds -ne "default") {
    Write-Info "Current password: $('*' * $currentCreds.Length) (already set)"
    if (Get-YesNo "Keep current password?" $true) {
        # keep it
    } else {
        $newPass = Get-Input "New password"
        if ($newPass) { $config.credentials = $newPass }
    }
} else {
    $newPass = Get-Input "Choose a password for the web interface"
    if ($newPass) {
        $config.credentials = $newPass
    } else {
        Write-Warn "No password set — using 'default'. Change this later!"
    }
}

# ─── Step 3: Network — LAN IP ─────────────────────────────────────────────────

Write-Step "Step 3: Network configuration"

# Detect LAN IPs
$lanIps = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    Select-Object -ExpandProperty IPAddress

if ($lanIps.Count -eq 1) {
    $lanIp = $lanIps[0]
    Write-Ok "Detected LAN IP: $lanIp"
} elseif ($lanIps.Count -gt 1) {
    Write-Host "  Multiple network interfaces detected:" -ForegroundColor Yellow
    for ($i = 0; $i -lt $lanIps.Count; $i++) {
        Write-Host "    $($i+1). $($lanIps[$i])"
    }
    $choice = Get-Input "Choose interface (1-$($lanIps.Count))" "1"
    $lanIp = $lanIps[[int]$choice - 1]
} else {
    $lanIp = Get-Input "Could not detect LAN IP. Enter it manually" "192.168.1.100"
}
Write-Ok "Using LAN IP: $lanIp"

# ─── Step 4: Port selection ───────────────────────────────────────────────────

Write-Step "Step 4: Port selection"
Write-Info "The web server port is used for the browser interface."
Write-Info "Default is 43780 (a non-standard port that avoids ISP/router restrictions on 80/443/8080)."
Write-Info "Port 443 requires admin rights and may be blocked; 80 and 8080 are often filtered by ISPs."

$currentPort = 43780
if ($config.bind_address -match ":(\d+)$") { $currentPort = [int]$Matches[1] }

$portInput = Get-Input "Web server port" "$currentPort"
$webPort = [int]$portInput

# WebRTC port range
Write-Info "WebRTC media ports (UDP) — used for the actual video/audio stream."
$rtcMin = $config.webrtc_port_range.min
$rtcMax = $config.webrtc_port_range.max
if (Get-YesNo "Keep WebRTC port range $rtcMin-$rtcMax?" $true) {
    # keep
} else {
    $rtcMin = [int](Get-Input "WebRTC min port" "40000")
    $rtcMax = [int](Get-Input "WebRTC max port" "40100")
    $config.webrtc_port_range = [PSCustomObject]@{ min = $rtcMin; max = $rtcMax }
}

# Update bind address
$config.bind_address = "${lanIp}:${webPort}"
Write-Ok "Server will listen on $($config.bind_address)"

# ─── Step 5: WAN IP ──────────────────────────────────────────────────────────

Write-Step "Step 5: Public (WAN) IP"
Write-Info "Your public IP is needed so remote clients (Tesla) can find your stream."

$wanIp = ""
try {
    $wanIp = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 5).Trim()
    Write-Ok "Detected public IP: $wanIp"
    if (-not (Get-YesNo "Is this correct?")) {
        $wanIp = Get-Input "Enter your public IP"
    }
} catch {
    Write-Warn "Could not auto-detect public IP."
    $wanIp = Get-Input "Enter your public IP (find it at whatismyip.com)"
}

if ($wanIp) {
    $config.webrtc_nat_1to1 = [PSCustomObject]@{
        ips = @($wanIp)
        ice_candidate_type = "srflx"
    }
    Write-Ok "Public IP set: $wanIp"
}

# ─── Step 6: Firewall ────────────────────────────────────────────────────────

Write-Step "Step 6: Windows Firewall"
Write-Info "The server needs inbound rules for the web port and WebRTC UDP ports."

if (Get-YesNo "Create Windows Firewall rules automatically?" $true) {
    try {
        # Remove old rules if they exist
        Remove-NetFirewallRule -DisplayName "Moonlight Web - HTTP/HTTPS" -ErrorAction SilentlyContinue
        Remove-NetFirewallRule -DisplayName "Moonlight Web - WebRTC UDP" -ErrorAction SilentlyContinue

        New-NetFirewallRule -DisplayName "Moonlight Web - HTTP/HTTPS" `
            -Direction Inbound -Protocol TCP -LocalPort $webPort -Action Allow -Profile Private,Public | Out-Null
        Write-Ok "Firewall rule created: TCP $webPort (web interface)"

        New-NetFirewallRule -DisplayName "Moonlight Web - WebRTC UDP" `
            -Direction Inbound -Protocol UDP -LocalPort "$rtcMin-$rtcMax" -Action Allow -Profile Private,Public | Out-Null
        Write-Ok "Firewall rule created: UDP $rtcMin-$rtcMax (WebRTC media)"
    } catch {
        Write-Warn "Failed to create firewall rules (run as Administrator for this)."
        Write-Info "You can add them manually: TCP $webPort and UDP $rtcMin-$rtcMax inbound."
    }
} else {
    Write-Info "Skipped. Make sure TCP $webPort and UDP $rtcMin-$rtcMax are open."
}

# ─── Step 6b: Router port forwarding ─────────────────────────────────────────

Write-Step "Step 6b: Router port forwarding"

# TCP web port via UPnP
Write-Info "Attempting to open TCP $webPort via UPnP..."
$ok = Invoke-UPnPPortMapping -LocalIp $lanIp -ExternalPort $webPort -InternalPort $webPort -Protocol "TCP" -Description "Moonlight Web HTTP"
if ($ok) {
    Write-Ok "UPnP: opened TCP $webPort (web interface)"
} else {
    Write-Warn "UPnP could not open TCP $webPort — add it manually in your router's port forwarding."
}

# UDP WebRTC range — manual only (UPnP doesn't work reliably for WebRTC on Tesla)
Write-Host ""
Write-Host "  ┌─ MANUAL STEP REQUIRED ───────────────────────────────────────────┐" -ForegroundColor Yellow
Write-Host "  │ Add STATIC port forwards in your router admin panel:             │" -ForegroundColor Yellow
Write-Host "  │                                                                  │" -ForegroundColor Yellow
Write-Host "  │   UDP $rtcMin-$rtcMax  ->  $lanIp   (WebRTC media stream)" -ForegroundColor Yellow
Write-Host "  │   TCP 80  ->  $lanIp`:$webPort   (Let's Encrypt — keep open for renewals)" -ForegroundColor Yellow
Write-Host "  │                                                                  │" -ForegroundColor Yellow
Write-Host "  │ Use the 'Port Forwarding' section (NOT UPnP) — UPnP mappings     │" -ForegroundColor Yellow
Write-Host "  │ are not used by the Tesla browser for WebRTC streams.            │" -ForegroundColor Yellow
Write-Host "  └──────────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
Write-Host ""
Read-Host "  Press Enter once you have added the UDP $rtcMin-$rtcMax port forward"

# ─── Step 7: Domain ──────────────────────────────────────────────────────────

Write-Step "Step 7: Domain name"
Write-Info "The Tesla browser blocks raw IP addresses. You need a domain name."
Write-Host ""
Write-Host "  Options:" -ForegroundColor Yellow
Write-Host "    1. I already have a domain / DDNS set up"
Write-Host "    2. Help me set up a free domain (DuckDNS)"
Write-Host "    3. Skip for now (won't work from Tesla)"
Write-Host ""

$domainChoice = Get-Input "Choose (1/2/3)" "1"
$domain = ""

switch ($domainChoice) {
    "1" {
        $domain = Get-Input "Enter your domain name (e.g. myhost.duckdns.org)"
    }
    "2" {
        Write-Host ""
        Write-Host "  ┌─ DuckDNS Setup ─────────────────────────────────────────────┐" -ForegroundColor Green
        Write-Host "  │ 1. Go to https://www.duckdns.org/ and sign in (free)        │" -ForegroundColor Green
        Write-Host "  │ 2. Create a subdomain (e.g. 'mypc' → mypc.duckdns.org)     │" -ForegroundColor Green
        Write-Host "  │ 3. Point it to your public IP: $wanIp" -ForegroundColor Green
        Write-Host "  │ 4. Copy your DuckDNS token from the top of the page         │" -ForegroundColor Green
        Write-Host "  └──────────────────────────────────────────────────────────────┘" -ForegroundColor Green
        Write-Host ""

        Start-Process "https://www.duckdns.org/"
        Write-Host "  Opening DuckDNS in your browser..." -ForegroundColor Yellow
        Write-Host ""

        $duckSubdomain = Get-Input "Enter the subdomain you created (e.g. mypc)"
        if ($duckSubdomain) {
            $domain = "$duckSubdomain.duckdns.org"

            $duckToken = Get-Input "Enter your DuckDNS token (from the website)"
            if ($duckToken) {
                # Update DuckDNS record to point to our WAN IP
                Write-Host "  Updating DuckDNS record..." -ForegroundColor Yellow
                try {
                    $duckUrl = "https://www.duckdns.org/update?domains=$duckSubdomain&token=$duckToken&ip=$wanIp"
                    $result = Invoke-RestMethod -Uri $duckUrl -TimeoutSec 10
                    if ($result -eq "OK") {
                        Write-Ok "DuckDNS updated: $domain → $wanIp"
                    } else {
                        Write-Warn "DuckDNS returned: $result (check your token and subdomain)"
                    }
                } catch {
                    Write-Warn "Failed to update DuckDNS: $_"
                }

                # Offer to create an update script for dynamic IP
                if (Get-YesNo "Create a script to auto-update DuckDNS when your IP changes?" $true) {
                    $duckScript = @"
# DuckDNS IP updater — run periodically or at startup
`$result = Invoke-RestMethod -Uri "https://www.duckdns.org/update?domains=$duckSubdomain&token=$duckToken&ip="
if (`$result -eq "OK") { Write-Host "DuckDNS updated" } else { Write-Host "DuckDNS failed: `$result" }
"@
                    [System.IO.File]::WriteAllText("$PWD/update-duckdns.ps1", $duckScript)
                    Write-Ok "Created update-duckdns.ps1"
                }
            }
        }
    }
    "3" {
        Write-Warn "Skipping domain setup. The Tesla browser will not be able to connect."
        Write-Info "You can re-run this setup later to configure a domain."
    }
}

if ($domain) {
    Write-Ok "Domain: $domain"
}

# ─── Step 8: Save config & start server (needed for ACME) ────────────────────

Write-Step "Step 8: Saving configuration"
Save-Config $config

# Start/restart the server so the ACME endpoint is available
Stop-ServerProcess
$serverRunning = Start-ServerProcess

# ─── Step 9: SSL Certificate ─────────────────────────────────────────────────

Write-Step "Step 9: SSL Certificate (HTTPS)"

if ($domain) {
    Write-Info "HTTPS is recommended for Tesla access and required for Keyboard Lock."
    Write-Host ""
    Write-Host "  Options:" -ForegroundColor Yellow
    Write-Host "    1. Obtain a free certificate from Let's Encrypt (recommended)"
    Write-Host "    2. I have my own certificate files (cert.pem + key.pem)"
    Write-Host "    3. Skip HTTPS for now"
    Write-Host ""

    $sslChoice = Get-Input "Choose (1/2/3)" "1"

    switch ($sslChoice) {
        "1" {
            Write-Host ""
            Write-Host "  ┌─ Important ─────────────────────────────────────────────────┐" -ForegroundColor Yellow
            Write-Host "  │ Let's Encrypt validates by making a request to port 80.     │" -ForegroundColor Yellow
            Write-Host "  │ Port 80 must be forwarded on your router to ${lanIp}.       │" -ForegroundColor Yellow
            Write-Host "  │ Keep this forward in place — it is reused every renewal.    │" -ForegroundColor Yellow
            Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
            Write-Host ""

            # Port 80 → $webPort must be open in the router for ACME validation AND renewal.
            # Keep this mapping permanently — it is reused every time the cert renews.
            Write-Host "  Trying UPnP to open port 80 on your router (kept permanently for renewal)..." -ForegroundColor Yellow
            $port80Ok = Invoke-UPnPPortMapping -LocalIp $lanIp -ExternalPort 80 -InternalPort $webPort -Protocol "TCP" -Description "Moonlight Web ACME"
            if ($port80Ok) {
                Write-Ok "UPnP: opened TCP 80 → ${lanIp}:${webPort} (kept for renewal)"
            } else {
                Write-Warn "UPnP could not open port 80 automatically."
                Write-Info "Please add a PERMANENT port forward in your router: TCP 80 → ${lanIp}:${webPort}"
                Write-Info "This is needed every time the certificate renews (every ~2 months)."
                Read-Host "  Press Enter when port 80 is forwarded"
            }

            if (-not $serverRunning) {
                Write-Warn "Server is not running. Starting it for certificate validation..."
                $serverRunning = Start-ServerProcess
            }

            # Run the ACME certificate script

            $acmeScript = Join-Path $PWD "acme-certificate.ps1"
            if (Test-Path $acmeScript) {
                Write-Host "  Running Let's Encrypt certificate generation..." -ForegroundColor Yellow
                & $acmeScript -Domain $domain -ServerUrl "http://${lanIp}:${webPort}"
                if ($LASTEXITCODE -eq 0) {
                    Write-Ok "Certificate obtained successfully!"
                    $config.certificate = [PSCustomObject]@{
                        private_key_pem = (Join-Path $PSScriptRoot "server\key.pem")
                        certificate_pem  = (Join-Path $PSScriptRoot "server\cert.pem")
                    }

                    # Bind HTTPS on port 443 in addition to the existing port
                    $config | Add-Member -Force -MemberType NoteProperty -Name bind_address_https -Value "${lanIp}:443"
                    Write-Ok "HTTPS will also be served on port 443 (existing port $webPort stays as HTTP)"

                    # Firewall rule for 443
                    try {
                        Remove-NetFirewallRule -DisplayName "Moonlight Web - HTTPS 443" -ErrorAction SilentlyContinue
                        New-NetFirewallRule -DisplayName "Moonlight Web - HTTPS 443" `
                            -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Private,Public | Out-Null
                        Write-Ok "Firewall rule created: TCP 443"
                    } catch {
                        Write-Warn "Could not create firewall rule for TCP 443."
                    }

                    # UPnP for 443
                    $ok443 = Invoke-UPnPPortMapping -LocalIp $lanIp -ExternalPort 443 -InternalPort 443 -Protocol "TCP" -Description "Moonlight Web HTTPS"
                    if ($ok443) {
                        Write-Ok "UPnP: opened TCP 443 on router"
                    } else {
                        Write-Warn "UPnP could not open TCP 443 automatically."
                        Write-Host ""
                        Write-Host "  Add this port forward in your router admin panel:" -ForegroundColor Yellow
                        Write-Host "    TCP 443  ->  ${lanIp}:443" -ForegroundColor Yellow
                        Write-Host ""
                        Read-Host "  Press Enter once TCP 443 is forwarded to ${lanIp}:443"
                    }

                    Save-Config $config  # save immediately so cert paths survive any later crash
                    # Port 80 mapping is kept permanently for future renewals.
                } else {
                    Write-Warn "Certificate generation failed. You can retry later with:"
                    Write-Info "  .\acme-certificate.ps1 -Domain `"$domain`" -ServerUrl `"http://${lanIp}:${webPort}`""
                }
            } else {
                Write-Warn "acme-certificate.ps1 not found in current directory!"
            }
        }
        "2" {
            $certPath = Get-Input "Path to certificate PEM file" "./server/cert.pem"
            $keyPath = Get-Input "Path to private key PEM file" "./server/key.pem"

            if ((Test-Path $certPath) -and (Test-Path $keyPath)) {
                $config.certificate = [PSCustomObject]@{
                    private_key_pem = $keyPath
                    certificate_pem = $certPath
                }

                Write-Host ""
                Write-Host "  How do you want to serve HTTPS?" -ForegroundColor Yellow
                Write-Host "    1. HTTPS on port $webPort only  (single binding — router forwards $webPort → $webPort, no 443 needed)"
                Write-Host "    2. HTTPS on port 443 as well    (dual binding  — keeps HTTP on $webPort for other tools, adds 443)"
                Write-Host ""
                $httpsPortChoice = Get-Input "Choose (1/2)" "1"

                if ($httpsPortChoice -eq "2") {
                    # Dual bind: HTTP stays on webPort, HTTPS added on 443
                    $config | Add-Member -Force -MemberType NoteProperty -Name bind_address_https -Value "${lanIp}:443"
                    Write-Ok "HTTPS will also be served on port 443 (existing port $webPort stays as HTTP)"

                    # Firewall rule for 443
                    try {
                        Remove-NetFirewallRule -DisplayName "Moonlight Web - HTTPS 443" -ErrorAction SilentlyContinue
                        New-NetFirewallRule -DisplayName "Moonlight Web - HTTPS 443" `
                            -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Private,Public | Out-Null
                        Write-Ok "Firewall rule created: TCP 443"
                    } catch {
                        Write-Warn "Could not create firewall rule for TCP 443."
                    }

                    # UPnP for 443
                    $ok443 = Invoke-UPnPPortMapping -LocalIp $lanIp -ExternalPort 443 -InternalPort 443 -Protocol "TCP" -Description "Moonlight Web HTTPS"
                    if ($ok443) {
                        Write-Ok "UPnP: opened TCP 443 on router"
                    } else {
                        Write-Warn "UPnP could not open TCP 443 automatically."
                        Write-Host ""
                        Write-Host "  Add this port forward in your router admin panel:" -ForegroundColor Yellow
                        Write-Host "    TCP 443  ->  ${lanIp}:443" -ForegroundColor Yellow
                        Write-Host ""
                        Read-Host "  Press Enter once TCP 443 is forwarded to ${lanIp}:443"
                    }
                } else {
                    # Single bind: HTTPS on webPort — remove any stale dual-bind setting
                    if ($config.PSObject.Properties["bind_address_https"]) {
                        $config.PSObject.Properties.Remove("bind_address_https")
                    }
                    Write-Ok "HTTPS will be served on port $webPort (single binding — router forward $webPort → $webPort)"
                }

                Write-Ok "Certificate configured."
            } else {
                Write-Warn "Certificate files not found. Skipping HTTPS."
            }
        }
        "3" {
            Write-Info "Skipping HTTPS. You can set it up later."
        }
    }
} else {
    Write-Info "No domain configured — skipping HTTPS setup."
}

# ─── Step 10: Save final config & restart ─────────────────────────────────────

Write-Step "Step 10: Finalizing"
Save-Config $config

Stop-ServerProcess
$serverRunning = Start-ServerProcess

# ─── Step 11: Scheduled certificate renewal ───────────────────────────────────

if ($config.certificate -and $sslChoice -eq "1") {
    Write-Step "Step 11: Automatic certificate renewal"
    Write-Info "Let's Encrypt certificates expire after 90 days."
    Write-Info "A scheduled task can renew them automatically every 60 days."

    if (Get-YesNo "Create a scheduled task for automatic renewal?" $true) {
        $taskName = "Moonlight Web - Certificate Renewal"
        $acmeFullPath = (Resolve-Path "./acme-certificate.ps1").Path
        $workDir = (Resolve-Path ".").Path
        # Always use plain HTTP on the main port for renewal — ACME HTTP-01 hits port 80 on the router
        # which forwards to $webPort on this machine.  Using HTTPS here would cause cert validation
        # failures if the cert is expired at renewal time.
        $arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$acmeFullPath`" -Domain `"$domain`" -ServerUrl `"http://${lanIp}:${webPort}`""

        try {
            # Remove existing task if present
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

            $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $workDir
            $trigger = New-ScheduledTaskTrigger -Daily -DaysInterval 60 -At "3:00AM"
            $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries

            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
                -Settings $settings -RunLevel Highest -Description "Renews the Let's Encrypt certificate for Moonlight Web" | Out-Null

            Write-Ok "Scheduled task created: '$taskName'"
            Write-Info "Runs every 60 days at 3:00 AM."
        } catch {
            Write-Warn "Failed to create scheduled task (try running as Administrator)."
            Write-Info "You can create it manually or run the renewal script periodically:"
            Write-Info "  .\acme-certificate.ps1 -Domain `"$domain`" -ServerUrl `"http://${lanIp}:${webPort}`""
        }
    }
} else {
    Write-Step "Step 11: Skipping certificate renewal (no Let's Encrypt cert)"
}

# ─── Step 12: Verify & open browser ──────────────────────────────────────────

Write-Step "Step 12: Verification"

$hasDualBind = $config.PSObject.Properties["bind_address_https"] -and $config.bind_address_https
$scheme = if ($config.certificate -and -not $hasDualBind) { "https" } else { "http" }
$portSuffix = if (($scheme -eq "http" -and $webPort -eq 80)) { "" } else { ":$webPort" }
$localUrl = "${scheme}://${lanIp}${portSuffix}"
$publicUrl = if ($domain) { "${scheme}://${domain}${portSuffix}" } else { $null }
# HTTPS URLs for dual-bind mode
$localHttpsUrl  = if ($hasDualBind) { "https://${lanIp}" } else { $null }
$publicHttpsUrl = if ($hasDualBind -and $domain) { "https://${domain}" } else { $null }

Write-Host ""
Write-Host "  ┌─ Your Setup ────────────────────────────────────────────────┐" -ForegroundColor Green
Write-Host "  │ Local URL:   $localUrl" -ForegroundColor Green
if ($localHttpsUrl)  { Write-Host "  │ Local HTTPS: $localHttpsUrl" -ForegroundColor Green }
if ($publicUrl)      { Write-Host "  │ Public URL:  $publicUrl" -ForegroundColor Green }
if ($publicHttpsUrl) { Write-Host "  │ Public HTTPS: $publicHttpsUrl" -ForegroundColor Green }
Write-Host "  │ Password:   $($config.credentials)" -ForegroundColor Green
Write-Host "  │ WebRTC:     UDP $rtcMin-$rtcMax" -ForegroundColor Green
if ($wanIp) {
Write-Host "  │ Public IP:  $wanIp" -ForegroundColor Green
}
Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Green

if ($serverRunning) {
    Write-Host ""
    Write-Info "Testing local connectivity..."
    try {
        $testUrl = $localUrl
        # Skip cert validation for self-signed/new certs
        if ($testUrl -match '^https') {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        }
        $resp = Invoke-WebRequest -Uri $testUrl -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        Write-Ok "Server is responding on $testUrl (HTTP $($resp.StatusCode))"
    } catch {
        Write-Warn "Could not reach server locally. It may still be starting up."
    }

    # Build the list of reachable public URLs for verification.
    # Single-bind HTTPS  → $publicUrl is "https://domain:webPort"
    # Dual-bind          → $publicUrl is "http://domain:webPort" + $publicHttpsUrl is "https://domain"
    # No cert            → $publicUrl is "http://domain:webPort"
    $verifyUrls = @()
    if ($publicUrl)      { $verifyUrls += $publicUrl }
    if ($publicHttpsUrl) { $verifyUrls += $publicHttpsUrl }

    if ($verifyUrls.Count -gt 0) {
        Write-Host ""
        Write-Host "  Open one of these in your browser to verify remote access:" -ForegroundColor Cyan
        foreach ($u in $verifyUrls) { Write-Host "    $u" -ForegroundColor Cyan }
        Write-Host ""
        if (Get-YesNo "Open $($verifyUrls[-1]) in your browser now?") {
            Start-Process $verifyUrls[-1]
        }
    }
} else {
    Write-Warn "Server is not running. Start it manually with: .\web-server.exe"
}

# ─── Summary ──────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║                  Setup Complete!                     ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

if ($domain) {
    # Determine the best URL to advertise
    $bestUrl = if ($publicHttpsUrl) { $publicHttpsUrl } elseif ($publicUrl) { $publicUrl } else { $null }

    # Determine whether 443 dual-bind is active
    $isDualBind = $config.PSObject.Properties["bind_address_https"] -and $config.bind_address_https

    Write-Host "  Next steps:" -ForegroundColor Yellow
    Write-Host "    1. Confirm these router port forwards are in place:" -ForegroundColor White
    Write-Host "       • TCP $webPort → ${lanIp}:${webPort}" -ForegroundColor White
    Write-Host "       • UDP $rtcMin-$rtcMax → ${lanIp}  (WebRTC)" -ForegroundColor White
    if ($sslChoice -eq "1") {
        # Let's Encrypt — always dual-bind; 80 is for ACME renewal
        Write-Host "       • TCP 80  → ${lanIp}:${webPort}  (cert renewal — keep permanently)" -ForegroundColor White
        Write-Host "       • TCP 443 → ${lanIp}:443  (HTTPS)" -ForegroundColor White
    } elseif ($sslChoice -eq "2" -and $isDualBind) {
        # User cert, dual-bind chosen
        Write-Host "       • TCP 443 → ${lanIp}:443  (HTTPS)" -ForegroundColor White
    }
    if ($bestUrl) {
        Write-Host "    2. Open $bestUrl from your Tesla browser" -ForegroundColor White
    }
    Write-Host "    3. Log in and pair with your PC (Sunshine)" -ForegroundColor White
} else {
    Write-Host "  To use from Tesla, you'll need a domain. Re-run this setup to add one." -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Press Enter to close"
