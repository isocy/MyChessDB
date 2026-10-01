' Double-click this file to start My Chess DB silently (no console window)
' and open it in your default browser automatically.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")

' 0 = hidden window, False = don't wait for it to finish
shell.Run """" & scriptDir & "\.venv\Scripts\pythonw.exe"" """ & scriptDir & "\app.py""", 0, False

WScript.Sleep 1500
shell.Run "http://127.0.0.1:8765"
