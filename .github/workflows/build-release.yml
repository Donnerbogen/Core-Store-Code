name: Build Core Store Windows Installer

on:
  release:
    types: [published]

permissions:
  contents: write

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - name: Repository auschecken
        uses: actions/checkout@v4

      - name: Node.js einrichten
        uses: actions/setup-node@v4
        with:
          node-version: 22

      # Die Version wird bei jedem Release direkt aus dem privaten
      # Core-Store-Files-Repository gelesen. package.json muss nicht mehr
      # manuell angepasst werden.
      - name: Store-Version aus Core-Store-Files lesen
        shell: pwsh
        env:
          FILES_REPO: ${{ secrets.CORE_STORE_FILES_REPO }}
          FILES_TOKEN: ${{ secrets.CORE_STORE_FILES_TOKEN }}
          FILES_BRANCH: ${{ secrets.CORE_STORE_FILES_BRANCH || 'main' }}
        run: |
          if ([string]::IsNullOrWhiteSpace($env:FILES_REPO)) {
            throw "GitHub Secret CORE_STORE_FILES_REPO fehlt. Erwartet wird OWNER/REPOSITORY."
          }
          if ([string]::IsNullOrWhiteSpace($env:FILES_TOKEN)) {
            throw "GitHub Secret CORE_STORE_FILES_TOKEN fehlt. Es wird ein read-only Token für das private Repository benötigt."
          }

          $parts = $env:FILES_REPO.Split('/')
          if ($parts.Length -ne 2) {
            throw "CORE_STORE_FILES_REPO muss OWNER/REPOSITORY sein."
          }

          $branch = if ([string]::IsNullOrWhiteSpace($env:FILES_BRANCH)) { 'main' } else { $env:FILES_BRANCH }
          $encodedBranch = [System.Uri]::EscapeDataString($branch)
          $uri = "https://api.github.com/repos/$($parts[0])/$($parts[1])/contents/config/store.json?ref=$encodedBranch"
          $headers = @{
            Authorization = "Bearer $env:FILES_TOKEN"
            Accept = 'application/vnd.github+json'
            'X-GitHub-Api-Version' = '2022-11-28'
          }

          $response = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers
          if ($response.encoding -ne 'base64') {
            throw "config/store.json konnte nicht als Base64 gelesen werden."
          }
          $jsonText = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($response.content))
          $storeConfig = $jsonText | ConvertFrom-Json
          $version = [string]$storeConfig.version
          if ($version -notmatch '^\d+\.\d+\.\d+$') {
            throw "Ungültige Version in Core-Store-Files/config/store.json: '$version'. Erwartet wird z. B. 1.2.3."
          }

          $packagePath = Join-Path $env:GITHUB_WORKSPACE 'desktop/package.json'
          $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
          $package.version = $version
          $packageJson = ($package | ConvertTo-Json -Depth 100) + [Environment]::NewLine
          [System.IO.File]::WriteAllText($packagePath, $packageJson, [System.Text.UTF8Encoding]::new($false))

          "CORE_STORE_VERSION=$version" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
          Write-Host "Core Store wird mit Version $version gebaut."

      - name: Electron-Abhaengigkeiten installieren
        run: npm install
        working-directory: desktop

      - name: Windows-Installer bauen
        run: npm run dist
        working-directory: desktop

      - name: Setup-Datei an GitHub Release anhaengen
        uses: softprops/action-gh-release@v2
        with:
          files: desktop/dist/Core-Store-Setup.exe
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
