; v0.4.7 升级桥接：旧卸载器运行前对安装目录数据和旧 AppData 分别做递归校验快照。
; 不再覆盖 customRemoveFiles，后续版本让 electron-builder 只按默认逻辑替换程序文件。
; 不在 .onInit 中等待软件退出：先显示安装向导，在替换文件前保存退出并备份。
; 覆盖默认的强制结束逻辑；同样用于新版本卸载器的运行检测。
!macro customCheckAppRunning
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    InitPluginsDir
    DetailPrint "正在保存 LY Space 数据并关闭软件…"
    File /oname=$PLUGINSDIR\stop-for-install.ps1 "${BUILD_RESOURCES_DIR}\stop-for-install.ps1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-for-install.ps1" -InstallDir "$INSTDIR" -ProcessName "${APP_EXECUTABLE_FILENAME}"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "未能自动关闭 LY Space，安装已停止，原数据未删除。请在软件的“文件 → 退出”中关闭后重试。旧版首次升级可能需要手动退出一次。错误：$1" /SD IDOK
      Abort
    ${EndIf}
    !ifndef BUILD_UNINSTALLER
    DetailPrint "正在备份并校验用户数据…"
    File /oname=$PLUGINSDIR\backup-user-data.ps1 "${BUILD_RESOURCES_DIR}\backup-user-data.ps1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\backup-user-data.ps1" -InstallDir "$INSTDIR" -AppDataDir "$APPDATA\LY Space" -LocalAppDataDir "$LOCALAPPDATA" -ProcessName "${APP_EXECUTABLE_FILENAME}"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "用户数据备份或校验失败，升级已停止。原程序和原数据均未删除。请完全退出 LY Space（含系统托盘图标）后重新运行安装程序。错误：$1" /SD IDOK
      Abort
    ${EndIf}
    !endif
  ${EndIf}
!macroend
