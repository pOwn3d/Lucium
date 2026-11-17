; Extra steps of the Windows installer (electron-builder, NSIS). WRITTEN FROM THE DOCUMENTATION, NEVER RUN: no Windows machine was available
; (docs/plateformes.md). electron-builder includes build/installer.nsh by itself and calls the macros below (templates/nsis/installSection.nsh and
; uninstaller.nsh of app-builder-lib 26.18). Nothing here runs a program, reads a secret or writes outside the registry keys named below.
;
; What it does: makes Lucium appear in Settings > Apps > Default apps as a web browser, so that the user can choose it for http and https (Windows 10
; and 11 never let a program take the default by itself: app.setAsDefaultProtocolClient only registers the association, the choice stays the user's).
; The layout is the one Microsoft documents for "Default Programs" (a client under Software\Clients\StartMenuInternet, a Capabilities key, an entry in
; Software\RegisteredApplications, and one ProgID per kind of address), the same one Chromium-based browsers write for a per-user install.
;
; SHELL_CONTEXT is HKCU for the per-user install the project builds (nsis.perMachine: false) and HKLM if a per-machine one is ever built: the keys
; below are written under whichever root the installer was started for, never under both.
;
; Not done, on purpose: associations for .html/.pdf/images (the application reads a link given on its command line, not a file path: opening a local
; file from Explorer is not written), and anything about the native messaging hosts of extensions (Lucium reads Chrome's keys, written by the installers of
; the hosts, when the user allows them, never one of its own: see nativeHostRegistryKeys in src/shared/native-messaging.ts). The uninstaller still deletes
; Software\Lucium\NativeMessagingHosts, a key nothing reads or writes today, so that nothing is left behind the day something does.

!define LUCIUM_CLIENT_KEY "Software\Clients\StartMenuInternet\${PRODUCT_NAME}"
!define LUCIUM_URL_PROGID "LuciumURL"

!macro customInstall
  ; The program as a client of the web: its name, its icon, the command that starts it.
  WriteRegStr SHELL_CONTEXT "${LUCIUM_CLIENT_KEY}" "" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${LUCIUM_CLIENT_KEY}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${LUCIUM_CLIENT_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'

  ; What Default apps lists: the name and the two schemes it can be the default for. No ApplicationDescription: it would be a text of the interface
  ; in one language only (AGENTS.md section 3), and Windows shows the name alone without it.
  WriteRegStr SHELL_CONTEXT "${LUCIUM_CLIENT_KEY}\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${LUCIUM_CLIENT_KEY}\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "${LUCIUM_CLIENT_KEY}\Capabilities\URLAssociations" "http" "${LUCIUM_URL_PROGID}"
  WriteRegStr SHELL_CONTEXT "${LUCIUM_CLIENT_KEY}\Capabilities\URLAssociations" "https" "${LUCIUM_URL_PROGID}"
  WriteRegStr SHELL_CONTEXT "${LUCIUM_CLIENT_KEY}\Capabilities\StartMenu" "StartMenuInternet" "${PRODUCT_NAME}"

  ; The ProgID of an address: Windows runs its command with the address as the argument. "--" ends the switches, so that an address that starts with
  ; a dash can never be taken for one.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${LUCIUM_URL_PROGID}" "" "${PRODUCT_NAME} URL"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${LUCIUM_URL_PROGID}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${LUCIUM_URL_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${LUCIUM_URL_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'

  ; The command scheme lucium:// (shared/automation-url.ts). macOS declares it in Info.plist whatever the setting says; the application refuses the
  ; commands while the setting "urlAutomation" is off.
  WriteRegStr SHELL_CONTEXT "Software\Classes\lucium" "" "${PRODUCT_NAME} command"
  WriteRegStr SHELL_CONTEXT "Software\Classes\lucium" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\lucium\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\lucium\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'

  ; Makes the capabilities findable: the name of the entry, the key that holds them.
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_NAME}" "${LUCIUM_CLIENT_KEY}\Capabilities"
!macroend

!macro customUnInstall
  ; An update runs this uninstaller of the old version before the install of the new one, and customInstall writes everything again: removing here
  ; is right for both an update and an uninstall. The user's choice of default browser is held by Windows, not by these keys: after an uninstall
  ; Windows falls back to another browser by itself.
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_NAME}"
  DeleteRegKey SHELL_CONTEXT "${LUCIUM_CLIENT_KEY}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${LUCIUM_URL_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\lucium"
  ; A key of Lucium's own for native messaging hosts (Software\Lucium\NativeMessagingHosts\<host>): not read today (only Chrome's keys are, under a
  ; setting), deleted so that the day it is, an uninstall leaves nothing.
  DeleteRegKey SHELL_CONTEXT "Software\${PRODUCT_NAME}\NativeMessagingHosts"
!macroend
