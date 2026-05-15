; Custom NSIS installer hooks for Constellation Engine.
;
; electron-builder auto-includes this file when present in buildResources.
; Macro reference: https://www.electron.build/configuration/nsis#custom-nsis-script
;
; We hook customUnInstall to optionally wipe %APPDATA%\Constellation on
; uninstall. Without this, NSIS leaves the userData directory behind, which
; carries the .onboarding-complete sentinel + config + DBs into the next
; install — defeating the wizard and confusing users who expect "uninstall =
; clean slate." Default is to delete (most common user expectation); a
; MessageBox lets the user keep data for diagnostic / migration purposes.

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Remove all Constellation data (settings, DBs, wizard state)?$\n$\n\
Yes = clean wipe (recommended for a fresh reinstall)$\n\
No  = keep data for migration / debugging" \
    /SD IDYES IDNO keep_userdata
    ; Wipe %APPDATA%\Constellation entirely. $APPDATA expands to the
    ; per-user roaming AppData root; "Constellation" must match top-level
    ; productName in electron/package.json — Electron resolves userData to
    ; <APPDATA>/<productName>. If they drift, this hook silently no-ops on
    ; an empty path while real userData persists at <APPDATA>/<name>.
    RMDir /r "$APPDATA\Constellation"
    DetailPrint "Removed user data: $APPDATA\Constellation"
    Goto userdata_done
  keep_userdata:
    DetailPrint "Kept user data: $APPDATA\Constellation"
  userdata_done:
!macroend
