# Resolving paths

$metadataJson = cargo metadata --format-version 1 --no-deps
$metadata = $metadataJson | ConvertFrom-Json
$targetDir = $metadata.target_directory

New-Item -ItemType Directory "./finalOutput" -Force
$outputDir = Resolve-Path "./finalOutput"

$moonlightRoot = Resolve-Path "."
$moonlightFrontend = Join-Path -Path $moonlightRoot -ChildPath "/moonlight-web/web-server"

function Get-BuildAssetHash {
    param(
        [Parameter(Mandatory = $true)]
        [string]$distDir
    )

    $fileHashes = Get-ChildItem -Path $distDir -Recurse -File |
        Sort-Object FullName |
        ForEach-Object { (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash }

    $combined = [string]::Join("", $fileHashes)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($combined)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash($bytes)
    }
    finally {
        $sha.Dispose()
    }

    return ([System.BitConverter]::ToString($digest).Replace("-", "").ToLower()).Substring(0, 12)
}

function Add-CacheBustToReferences {
    param(
        [Parameter(Mandatory = $true)]
        [string]$distDir,

        [Parameter(Mandatory = $true)]
        [string]$versionHash
    )

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $textExt = @(".html", ".js", ".mjs", ".css")

    $appendVersion = {
        param($match)

        $prefix = $match.Groups["prefix"].Value
        $path = $match.Groups["path"].Value
        $query = $match.Groups["query"].Value
        $suffix = $match.Groups["suffix"].Value

        if ($path -match "^(https?:|data:|blob:|//|#)") {
            return $match.Value
        }

        $newQuery = ""
        if ([string]::IsNullOrEmpty($query)) {
            $newQuery = "?v=$versionHash"
        }
        elseif ($query -match "(^|[?&])v=") {
            $newQuery = $query
        }
        else {
            $newQuery = "$query&v=$versionHash"
        }

        return "$prefix$path$newQuery$suffix"
    }

    $assetExtensions = "(?:js|mjs|css|json|wasm|svg|png|wav)"
    $patterns = @(
        ('(?<prefix>(?:src|href)\s*=\s*["''])(?<path>(?!https?:|data:|blob:|//|#)[^"''\?]+?\.{0})(?<query>\?[^"'']*)?(?<suffix>["''])' -f $assetExtensions),
        ('(?<prefix>(?:from\s+|import\s*\(\s*)["''])(?<path>(?!https?:|data:|blob:|//|#)[^"''\?]+?\.{0})(?<query>\?[^"'']*)?(?<suffix>["''])' -f $assetExtensions),
        ('(?<prefix>url\(\s*["'']?)(?<path>(?!https?:|data:|blob:|//|#)[^"''\)\?]+?\.{0})(?<query>\?[^"''\)]*)?(?<suffix>["'']?\s*\))' -f $assetExtensions)
    )

    $files = Get-ChildItem -Path $distDir -Recurse -File | Where-Object { $textExt -contains $_.Extension.ToLower() }
    foreach ($file in $files) {
        $content = [System.IO.File]::ReadAllText($file.FullName)
        $updated = $content

        foreach ($pattern in $patterns) {
            $updated = [System.Text.RegularExpressions.Regex]::Replace($updated, $pattern, $appendVersion)
        }

        if ($updated -ne $content) {
            [System.IO.File]::WriteAllText($file.FullName, $updated, $utf8NoBom)
        }
    }
}

if(!$moonlightRoot -or !$moonlightFrontend) {
    Write-Output "No root directory found!"
    exit 0
}

Write-Output "Target directory at $targetDir"
Write-Output "Putting final output into $outputDir"
Write-Output "Moonlight Root Directory $moonlightRoot"

$targets = @(
    "x86_64-pc-windows-gnu"
    "x86_64-unknown-linux-gnu"
    "arm-unknown-linux-gnueabihf"
    "aarch64-unknown-linux-gnu"
)

Remove-Item -Path "$outputDir/*" -Recurse -Force

Write-Output "------------- Starting Build for Frontend -------------"
Set-Location $moonlightFrontend

New-Item -ItemType Directory "$outputDir/static" -Force | Out-Null

Remove-Item -Path "$moonlightFrontend/dist" -Recurse -Force
npm run build

$frontendDist = Join-Path -Path $moonlightFrontend -ChildPath "dist"
$assetHash = Get-BuildAssetHash -distDir $frontendDist
Write-Output "Applying frontend cache-bust hash: $assetHash"
Add-CacheBustToReferences -distDir $frontendDist -versionHash $assetHash

Copy-Item -Path "$moonlightFrontend/dist/*" -Destination "$outputDir/static" -Recurse -Force
Write-Output "------------- Finished Build for Frontend -------------"

Set-Location $moonlightRoot

foreach($target in $targets) {
    Write-Output "------------- Starting Build for $target -------------"
    $messages = cross build --release --target $target --message-format=json | ForEach-Object { $_ | ConvertFrom-Json }
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    Write-Output "------------- Finished Build for $target -------------"

    $artifact = $messages | Where-Object { $_.reason -eq "compiler-artifact" -and $_.executable }
    $binaryPaths = $artifact | ForEach-Object { Join-Path -Path $targetDir -ChildPath ($_.executable.Substring("/target".length)) }

    $binaryPaths | ForEach-Object { Write-Host "Binary: $_" }

    Write-Output "------------- Starting Zipping for $target -------------"
    $itemsToZip = @($binaryPaths) + "$outputDir/static"
    $archiveName = "$outputDir/moonlight-web-$target"

    if ($target -clike "*windows*") {
        # Create zip
        $zipDestination = "$archiveName.zip"
        7z a -tzip $zipDestination $itemsToZip -y
    } else {
        # Create tar.gz
        New-Item -ItemType Directory "$archiveName" -Force | Out-Null

        foreach ($item in $itemsToZip) {
            Copy-Item $item -Recurse -Destination $archiveName
        }

        $tarDestination = "$archiveName.tar"
        $gzDestination = "$archiveName.tar.gz"
        7z a -ttar $tarDestination $archiveName -y
        7z a -tgzip $gzDestination $tarDestination -y
        
        Remove-Item $tarDestination

        Remove-Item $archiveName -Recurse
    }

    Write-Output "Created Zip file at $archiveName"
    Write-Output "------------- Finished Zipping for $target -------------"
}

Remove-Item "$outputDir/static" -Recurse

Write-Output "Finished!"