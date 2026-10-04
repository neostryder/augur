; The dispatch service runs from the install folder, so an upgrade or an uninstall has to stop it first.
; It is stopped only when no job is running, since a job's process tree also runs from these files.
!macro AugurStopService
  IfFileExists "$INSTDIR\service\augur.cmd" 0 augur_skip_stop
    nsExec::ExecToStack '"$INSTDIR\service\augur.cmd" service stop --if-idle'
    Pop $0
    Pop $1
    StrCmp $0 "0" augur_stopped
    MessageBox MB_ICONEXCLAMATION|MB_OK "Augur is running a job, so this cannot replace its files yet. Let the job finish, or cancel it with: augur cancel <job>. Then run this again."
    Abort
  augur_stopped:
    ; With no job running, the only processes left on augur-node.exe are MCP servers that open Claude sessions started. They run from the same file and
    ; block its replacement, and a client starts a fresh one the next time it needs the tools.
    nsExec::ExecToStack 'taskkill /F /IM augur-node.exe'
    Pop $0
    Pop $1
    ; An open Claude session starts its MCP server again within a second of the kill, so the file can be locked again by the time it is copied.
    ; Windows lets a running program be renamed but not overwritten, so the old file moves aside and the copy lands in a free name.
    ; Copies set aside by an earlier run go once nothing runs them.
    Delete "$INSTDIR\service\augur-node.exe.old*"
    StrCpy $R0 0
  augur_aside:
    IfFileExists "$INSTDIR\service\augur-node.exe.old$R0" 0 augur_rename
      IntOp $R0 $R0 + 1
      Goto augur_aside
  augur_rename:
    Rename "$INSTDIR\service\augur-node.exe" "$INSTDIR\service\augur-node.exe.old$R0"
  augur_skip_stop:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AugurStopService
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AugurStopService
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; A copy still running when Augur is removed goes at the next restart.
  Delete /REBOOTOK "$INSTDIR\service\augur-node.exe.old*"
  RMDir "$INSTDIR\service"
  RMDir "$INSTDIR"
!macroend
