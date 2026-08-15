; v0.4.7 升级桥接：旧卸载器运行前对安装目录数据和旧 AppData 分别做递归校验快照。
; 不再覆盖 customRemoveFiles，后续版本让 electron-builder 只按默认逻辑替换程序文件。
!macro customInit
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    InitPluginsDir
    File /oname=$PLUGINSDIR\backup-user-data.ps1 "${BUILD_RESOURCES_DIR}\backup-user-data.ps1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\backup-user-data.ps1" -InstallDir "$INSTDIR" -AppDataDir "$APPDATA\LY Space" -LocalAppDataDir "$LOCALAPPDATA" -ProcessName "${APP_EXECUTABLE_FILENAME}"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "用户数据备份或校验失败，升级已停止。原程序和原数据均未删除。错误：$1" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
!macroend
