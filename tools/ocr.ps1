# Windows built-in OCR (Windows.Media.Ocr) fallback used by lib/ocr.js.
# Kept ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less script as ANSI,
# so non-ASCII text here would corrupt quoting and fail to parse.
#
# Input : env OCR_IMAGE (absolute image path), OCR_OUT (result JSON path)
# Output: UTF-8 JSON written to OCR_OUT: {"ok":true,"lang":"zh-Hans-CN","lines":[...]}
$ErrorActionPreference = 'Stop'

function Write-Result($payload) {
  $json = $payload | ConvertTo-Json -Compress -Depth 4
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($env:OCR_OUT, $json, $utf8)
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

  function Await($op, $resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) {
    Write-Result @{ ok = $false; error = 'no OCR language pack' }
    exit 0
  }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:OCR_IMAGE)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($result.Lines | ForEach-Object { $_.Text })
  Write-Result @{ ok = $true; lang = $engine.RecognizerLanguage.LanguageTag; lines = $lines }
} catch {
  $message = $_.Exception.Message -replace '"', "'"
  Write-Result @{ ok = $false; error = $message }
}
