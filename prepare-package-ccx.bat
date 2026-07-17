@echo off
set "DEST=%~dp0_PluginToCCX"

echo Cleaning destination folder...
if exist "%DEST%" rd /s /q "%DEST%"
mkdir "%DEST%"

echo Copying plugin files...
copy manifest.json "%DEST%\" >nul
copy index.html "%DEST%\" >nul
copy index.js "%DEST%\" >nul
copy styles.css "%DEST%\" >nul

echo Adjusting manifest.json for production (ID and Name)...
powershell -Command "$p = '%DEST%\manifest.json'; $c = (Get-Content $p) -replace 'com\.fromps-tops\.dev', 'com.fromps-tops' -replace 'FromPS-ToPS Dev', 'FromPS-ToPS'; [System.IO.File]::WriteAllLines($p, $c, (New-Object System.Text.UTF8Encoding($false)))"

echo Copying modules...
xcopy modules "%DEST%\modules" /e /i /h /y >nul

echo Copying icons (excluding helper generator folders)...
mkdir "%DEST%\icons" >nul
copy icons\icon.png "%DEST%\icons\" >nul
xcopy icons\png "%DEST%\icons\png" /e /i /h /y >nul

echo -------------------------------------------------------------
echo Done! Clean UXP plugin folder is ready at:
echo %DEST%
echo -------------------------------------------------------------
echo Now open Adobe UXP Developer Tool, "Add Plugin" from the
echo _PluginToCCX directory, and select "Package..." to build the CCX.
echo.
echo IMPORTANT: After packaging, you MUST rename the generated CCX file
echo to "plugin.ccx" and move it to the root of the workspace
echo (%~dp0plugin.ccx) for the installer.
echo -------------------------------------------------------------
pause
