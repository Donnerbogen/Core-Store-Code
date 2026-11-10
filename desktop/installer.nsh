\
; Core Store wird zusammen mit allen CORE-Network-Dateien im Roaming-Profil abgelegt.
; customInit setzt das Standard- und Installationsziel des NSIS-Installers.
!macro customInit
  StrCpy $INSTDIR "$APPDATA\Core Network\Core Store"
!macroend
