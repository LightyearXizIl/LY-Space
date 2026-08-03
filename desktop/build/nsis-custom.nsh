; 升级/卸载时保护安装目录内的 Data cache 与 Result（数据默认跟随安装目录，升级清空安装目录时保留数据）
; 由 electron-builder 的 build.nsis.include 引入，customRemoveFiles 宏完全替换默认的目录删除逻辑
; 用 CopyFiles（支持跨卷与递归）而非 Rename，避免跨卷失败导致数据被 RMDir 删除
!macro customRemoveFiles
  ; 清理上次中断留下的临时残留
  RMDir /r "$TEMP\lyspace-data-cache"
  RMDir /r "$TEMP\lyspace-result"
  ; 先把数据目录完整复制到临时位置，再删除原目录
  ${If} ${FileExists} "$INSTDIR\Data cache"
    CreateDirectory "$TEMP\lyspace-data-cache"
    CopyFiles /SILENT "$INSTDIR\Data cache\*.*" "$TEMP\lyspace-data-cache\"
    RMDir /r "$INSTDIR\Data cache"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\Result"
    CreateDirectory "$TEMP\lyspace-result"
    CopyFiles /SILENT "$INSTDIR\Result\*.*" "$TEMP\lyspace-result\"
    RMDir /r "$INSTDIR\Result"
  ${EndIf}
  ; 删除安装目录其余内容（程序文件等）
  RMDir /r "$INSTDIR"
  ; 重建安装目录并移回数据目录，供新版本解压后继续使用
  CreateDirectory "$INSTDIR"
  ${If} ${FileExists} "$TEMP\lyspace-data-cache"
    CreateDirectory "$INSTDIR\Data cache"
    CopyFiles /SILENT "$TEMP\lyspace-data-cache\*.*" "$INSTDIR\Data cache\"
    RMDir /r "$TEMP\lyspace-data-cache"
  ${EndIf}
  ${If} ${FileExists} "$TEMP\lyspace-result"
    CreateDirectory "$INSTDIR\Result"
    CopyFiles /SILENT "$TEMP\lyspace-result\*.*" "$INSTDIR\Result\"
    RMDir /r "$TEMP\lyspace-result"
  ${EndIf}
!macroend
