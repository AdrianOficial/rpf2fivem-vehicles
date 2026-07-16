# cw-merge-textures.ps1
#
# Injecteaza texturile lipsa in YTD-urile vehiculelor folosind DIRECT
# CodeWalker.Core.dll (load -> merge -> save), pe baza manifestului generat de:
#   node fix-vehshare-textures.js --manifest vehshare_cw_manifest.json
#
# Utilizare:
#   powershell -File cw-merge-textures.ps1 [-Manifest <json>] [-DeployDir <stream folder server>]

param(
    [string]$Manifest = 'vehshare_cw_manifest.json',
    [string]$CodeWalkerDll = 'D:\CodeWalker30_dev48\CodeWalker.Core.dll',
    [string]$DeployDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -Path $CodeWalkerDll

$mf = Get-Content $Manifest -Raw | ConvertFrom-Json

function Load-Ytd([string]$path) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $ytd = New-Object CodeWalker.GameFiles.YtdFile
    [CodeWalker.GameFiles.RpfFile]::LoadResourceFile($ytd, $bytes, 13)
    if ($null -eq $ytd.TextureDict) { throw "TextureDict null pentru $path" }
    return $ytd
}

# incarca biblioteca de dictionare partajate prin CodeWalker
$lib = @{}
foreach ($p in $mf.libraryFiles.PSObject.Properties) {
    try {
        $ytd = Load-Ytd $p.Value
        $map = @{}
        foreach ($t in $ytd.TextureDict.Textures.data_items) {
            $k = $t.Name.ToLowerInvariant()
            if (-not $map.ContainsKey($k)) { $map[$k] = $t }
        }
        $lib[$p.Name] = $map
    } catch {
        Write-Warning ("biblioteca {0} nu s-a putut incarca: {1}" -f $p.Name, $_.Exception.Message)
    }
}
Write-Host ("Biblioteca incarcata prin CodeWalker: {0} dictionare" -f $lib.Count)

$done = 0
foreach ($a in $mf.actions) {
    $texList = New-Object 'System.Collections.Generic.List[CodeWalker.GameFiles.Texture]'
    $existingNames = @{}

    if ($a.baseFile) {
        $ytd = Load-Ytd $a.baseFile
        foreach ($t in $ytd.TextureDict.Textures.data_items) {
            $texList.Add($t)
            $existingNames[$t.Name.ToLowerInvariant()] = $true
        }
    } else {
        $ytd = New-Object CodeWalker.GameFiles.YtdFile
        $ytd.TextureDict = New-Object CodeWalker.GameFiles.TextureDictionary
    }

    $added = 0
    foreach ($ad in $a.additions) {
        $k = $ad.name.ToLowerInvariant()
        if ($existingNames.ContainsKey($k)) { continue }
        if (-not $lib.ContainsKey($ad.dict)) { Write-Warning ("{0}: dictionarul {1} lipseste" -f $a.resource, $ad.dict); continue }
        $src = $lib[$ad.dict][$k]
        if ($null -eq $src) { Write-Warning ("{0}: textura {1} nu e in {2}" -f $a.resource, $ad.name, $ad.dict); continue }
        $texList.Add($src)
        $existingNames[$k] = $true
        $added++
    }

    $ytd.TextureDict.BuildFromTextureList($texList)
    $out = $ytd.Save()
    [IO.File]::WriteAllBytes($a.outFile, $out)
    $done++

    $msg = ("{0}: {1} texturi (+{2}) -> {3}" -f $a.resource, $texList.Count, $added, $a.outFile)
    if ($DeployDir) {
        $dst = Join-Path $DeployDir ([IO.Path]::GetFileName($a.outFile))
        [IO.File]::WriteAllBytes($dst, $out)
        $msg += '  [copiat si pe server]'
    }
    Write-Host $msg
}
Write-Host ("Gata: {0} YTD-uri generate 100% cu CodeWalker.Core" -f $done)
