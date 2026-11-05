!macro AugurTrace TEXT
  Push $R9
  ClearErrors
  CreateDirectory "$LOCALAPPDATA\Augur"
  FileOpen $R9 "$LOCALAPPDATA\Augur\update-install.log" a
  FileSeek $R9 0 END
  FileWrite $R9 "${TEXT}$\r$\n"
  FileClose $R9
  ClearErrors
  Pop $R9
!macroend

; Windows permits a running executable to move aside while its process keeps the old image.
!macro AugurAside FILE ID
  IfFileExists "$INSTDIR\service\${FILE}" 0 augur_${ID}_done
  StrCpy $R0 0
  augur_${ID}_aside:
    IfFileExists "$INSTDIR\service\${FILE}.old$R0" 0 augur_${ID}_rename
    IntOp $R0 $R0 + 1
    Goto augur_${ID}_aside
  augur_${ID}_rename:
    ClearErrors
    Rename "$INSTDIR\service\${FILE}" "$INSTDIR\service\${FILE}.old$R0"
    IfErrors augur_aside_failed
    !if "${ID}" == "host"
      StrCpy $R1 "$INSTDIR\service\${FILE}.old$R0"
    !endif
  augur_${ID}_done:
!macroend

!macro AugurStopService
  !insertmacro AugurTrace "AugurStopService start"
  IfFileExists "$INSTDIR\service\augur.cmd" 0 augur_skip_stop
    DetailPrint "Stopping the Augur service. Running jobs keep running."
    nsExec::ExecToStack '"$INSTDIR\service\augur.cmd" service stop --keep-jobs'
    Pop $0
    Pop $1
    StrCmp $0 "0" augur_kept 0
    ; The installed command may be older than this installer and not know --keep-jobs. It stops the service the old way: wait for the jobs, then end every augur-node.exe.
    DetailPrint "Waiting for running jobs to finish before updating Augur."
    nsExec::ExecToStack '"$INSTDIR\service\augur.cmd" service stop --wait --timeout 7200'
    Pop $0
    Pop $1
    StrCmp $0 "0" 0 augur_stop_failed
    nsExec::ExecToStack 'taskkill /F /IM augur-node.exe'
    Pop $0
    Pop $1
  augur_kept:
    Delete "$INSTDIR\service\augur-node.exe.old*"
    Delete "$INSTDIR\service\jobhost.exe.old*"
    StrCpy $R2 0
  augur_try_aside:
    StrCpy $R1 ""
    !insertmacro AugurAside "jobhost.exe" "host"
    !insertmacro AugurAside "augur-node.exe" "node"
    Goto augur_skip_stop
  augur_aside_failed:
    ; Restore the host so the fallback service has both executable names available.
    StrCmp $R1 "" augur_fallback
    ClearErrors
    Rename "$R1" "$INSTDIR\service\jobhost.exe"
    IfErrors augur_stop_failed
  augur_fallback:
    StrCmp $R2 "1" augur_stop_failed
    StrCpy $R2 1
    ; The service was stopped above, so start it to re-adopt jobs before waiting.
    nsExec::ExecToStack '"$INSTDIR\service\augur.cmd" service start'
    Pop $0
    Pop $1
    StrCmp $0 "0" 0 augur_stop_failed
    DetailPrint "Waiting for running jobs to finish before updating Augur."
    nsExec::ExecToStack '"$INSTDIR\service\augur.cmd" service stop --wait --timeout 7200'
    Pop $0
    Pop $1
    StrCmp $0 "0" augur_try_aside
  augur_stop_failed:
    MessageBox MB_ICONEXCLAMATION|MB_OK "Update stopped and nothing changed. Run the installer again later."
    Abort
  augur_skip_stop:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AugurTrace "NSIS_HOOK_PREINSTALL start"
  !insertmacro AugurStopService
  !insertmacro AugurTrace "NSIS_HOOK_PREINSTALL end"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro AugurTrace "NSIS_HOOK_POSTINSTALL"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AugurTrace "NSIS_HOOK_PREUNINSTALL start"
  !insertmacro AugurStopService
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; A copy still running when Augur is removed goes at the next restart.
  Delete /REBOOTOK "$INSTDIR\service\augur-node.exe.old*"
  Delete /REBOOTOK "$INSTDIR\service\jobhost.exe.old*"
  RMDir "$INSTDIR\service"
  RMDir "$INSTDIR"
!macroend
