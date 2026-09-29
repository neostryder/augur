; The dispatch service runs from the install folder, so an upgrade or an uninstall has to stop it first.
; It is stopped only when no job is running, since a job's process tree also runs from these files.
!macro AugurStopService
  IfFileExists "$INSTDIR\service\augur.cmd" 0 augur_skip_stop
    nsExec::ExecToStack '"$INSTDIR\service\augur.cmd" service stop --if-idle'
    Pop $0
    Pop $1
    StrCmp $0 "0" augur_skip_stop
    MessageBox MB_ICONEXCLAMATION|MB_OK "Augur is running a job, so this cannot replace its files yet. Let the job finish, or cancel it with: augur cancel <job>. Then run this again."
    Abort
  augur_skip_stop:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AugurStopService
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AugurStopService
!macroend
