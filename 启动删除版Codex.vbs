Option Explicit
Dim shell, fileSystem, folder, script
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
folder = fileSystem.GetParentFolderName(WScript.ScriptFullName)
script = fileSystem.BuildPath(folder, "launcher.ps1")
shell.Run "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ & script & """", 0, False
