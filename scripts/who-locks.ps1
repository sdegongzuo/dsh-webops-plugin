<#
.SYNOPSIS
  查「到底谁占着这些文件」—— Windows Restart Manager 版。

.DESCRIPTION
  什么时候用：某文件「能读能写、就是删不掉/改不了名」（`EBUSY` / `EPERM`），需要点名持有者时。

  为什么不用别的工具：
    · `tasklist` + grep 只能看到进程名，看不出它碰了哪个文件；
    · `wmic` 本机没有；`Get-CimInstance Win32_Process` 在本机静默失败（连 Out-File 都不产出）；
    · Sysinternals `handle.exe` 本机没装，且它需要驱动级权限；
    · Restart Manager 是系统自带 API（`rstrtmgr.dll`），能给到 **PID + 进程名**，够用。

  ⚠️ 两个必须知道的语义（2026-09-19 实测踩过）：
    1. **「被列出来」≠「它阻止了删除」**。Restart Manager 报的是「当前持有该文件句柄的进程」，
       不管句柄的共享模式。正常带 `FILE_SHARE_DELETE` 的读者也会被列出来。
       —— 真正阻止删除的是**不带 `FILE_SHARE_DELETE`** 的那个句柄。
       所以判定「到底谁锁的」要交叉验证：**在它列出的进程里，找那个你没法解释的**。
    2. **只看得见同一个登录会话（session）里的进程**，服务会话（session 0）里的进程看不到。

  本机的已知凶手（供比对）：工作区里的 `app.asar` 会被 **IDE**（`WorkBuddy.exe` / `Qoder CN`）持有 ——
  VS Code 系把 asar 当可解析归档去打开解析，句柄不带 `FILE_SHARE_DELETE` 且不释放。
  **不是杀毒软件**（火绒 / 奇安信 / Malwarebytes / Defender / trantorAgent 都不出现）。

  本机 `PowerShell` 工具的 stdout 恒为空 —— 脚本自己 Out-File 落盘再读，或用 `-OutFile`。

.EXAMPLE
  .\scripts\who-locks.ps1 .desktop-base\app\resources\app.asar

.EXAMPLE
  # 通配 + 落盘
  .\scripts\who-locks.ps1 -Path '.desktop-stage-*\app\resources\*.asar' -OutFile D:\Temp\locks.txt
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]] $Path,

  [string] $OutFile
)

$ErrorActionPreference = 'Stop'

$files = New-Object System.Collections.ArrayList
foreach ($p in $Path) {
  try {
    foreach ($r in (Resolve-Path -Path $p -ErrorAction Stop)) {
      [void]$files.Add($r.Path)
    }
  } catch {
    Write-Warning "跳过（匹配不到）：$p"
  }
}
if ($files.Count -eq 0) {
  Write-Error '没有可查的文件。'
  exit 2
}

$code = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class WhoLocks {
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
    uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
    [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

  /// 返回 "PID|进程名|类型" 列表；空列表 = 没人持有。错误信息以 "!" 开头。
  public static List<string> Get(string file) {
    var res = new List<string>();
    uint handle;
    int rv = RmStartSession(out handle, 0, Guid.NewGuid().ToString());
    if (rv != 0) { res.Add("!RmStartSession=" + rv); return res; }
    try {
      rv = RmRegisterResources(handle, 1, new string[] { file }, 0, null, 0, null);
      if (rv != 0) { res.Add("!RmRegisterResources=" + rv); return res; }

      uint needed = 0, count = 0, reasons = 0;
      rv = RmGetList(handle, out needed, ref count, null, ref reasons);
      // 234 = ERROR_MORE_DATA，先问「要多大」的正常路径
      if (rv == 234) {
        count = needed;
        var arr = new RM_PROCESS_INFO[count];
        rv = RmGetList(handle, out needed, ref count, arr, ref reasons);
        if (rv != 0) { res.Add("!RmGetList(2)=" + rv); return res; }
        for (int i = 0; i < count; i++) {
          string type;
          switch (arr[i].ApplicationType) {
            case 1: type = "MainWindow"; break;
            case 2: type = "OtherWindow"; break;
            case 3: type = "Service"; break;
            case 4: type = "Explorer"; break;
            case 5: type = "Console"; break;
            case 1000: type = "Critical"; break;
            default: type = "Unknown"; break;
          }
          res.Add(arr[i].Process.dwProcessId + "|" + arr[i].strAppName + "|" + type);
        }
      } else if (rv != 0) {
        res.Add("!RmGetList=" + rv);
      }
    } finally {
      RmEndSession(handle);
    }
    return res;
  }
}
'@

Add-Type -TypeDefinition $code -Language CSharp

$lines = New-Object System.Collections.ArrayList
foreach ($f in $files) {
  $who = [WhoLocks]::Get($f)
  if ($who.Count -eq 0) {
    [void]$lines.Add("(无持有者)`t$f")
  } else {
    foreach ($w in $who) { [void]$lines.Add("$w`t$f") }
  }
}

foreach ($l in $lines) { Write-Output $l }
if ($OutFile) { $lines | Out-File -FilePath $OutFile -Encoding UTF8 }
