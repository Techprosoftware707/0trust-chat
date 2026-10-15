; Lumen Secure — custom NSIS logic for electron-builder (nsis.include).
;
; * Always a per-user install (no admin rights, no install-mode page).
; * Uninstalling keeps the user's local data (%APPDATA%\<product>) unless the user ticks
;   "Also delete my local data" on the uninstaller's options page. Updates (which run the old
;   uninstaller silently with --updated) never delete data. A silent uninstall keeps data
;   unless it is run with --delete-app-data (electron-builder's own switch).

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifdef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var LumenDeleteData
  Var LumenDeleteDataBox

  ; (Updates run the old uninstaller silently, so this page never shows during an update.)
  Function un.LumenDataPageCreate
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 48u "Your conversations stay encrypted on the server. On this computer, ${PRODUCT_NAME} keeps its local data (encryption keys, message cache, settings) in your user profile. Keep it if you plan to reinstall."
    Pop $0
    ${NSD_CreateCheckbox} 0 56u 100% 12u "Also delete my local data"
    Pop $LumenDeleteDataBox
    ${NSD_SetState} $LumenDeleteDataBox ${BST_UNCHECKED}
    ${NSD_CreateLabel} 0 74u 100% 36u "Deleting it removes this device's encryption keys. You can read old encrypted messages again only with your recovery key or another verified device."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function un.LumenDataPageLeave
    ${NSD_GetState} $LumenDeleteDataBox $LumenDeleteData
  FunctionEnd

  !macro customUnWelcomePage
    !insertmacro MUI_UNPAGE_WELCOME
    UninstPage custom un.LumenDataPageCreate un.LumenDataPageLeave
  !macroend

  !macro customUnInstall
    ${IfNot} ${isUpdated}
    ${AndIf} $LumenDeleteData == ${BST_CHECKED}
      DetailPrint "Deleting local data"
      SetShellVarContext current
      RMDir /r "$APPDATA\${PRODUCT_NAME}"
      RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}"
      RMDir /r "$LOCALAPPDATA\lumen-desktop-updater"
    ${EndIf}
  !macroend
!endif
