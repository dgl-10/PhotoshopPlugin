!macro customUnInit
  ; Stop the running Helper before uninstalling or replacing its files.
  nsExec::ExecToStack 'taskkill /F /IM "PhotoshopHelper.exe" /T'
!macroend

!macro customUnInstall
  ; Preserve the user's login preference when electron-builder is applying an
  ; update. Remove the per-user startup records only during a real uninstall.
  ${IfNot} ${isUpdated}
    ; Windows builds are x64-only, matching the registry view used by Electron.
    SetRegView 64

    ; Remove the command that launches the Helper at user login.
    DeleteRegValue HKCU \
      "Software\Microsoft\Windows\CurrentVersion\Run" \
      "${APP_ID}"

    ; Remove the matching Task Manager / Windows Settings approval record.
    DeleteRegValue HKCU \
      "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" \
      "${APP_ID}"
  ${EndIf}
!macroend
