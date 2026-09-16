' SourceGenius Playwright Scraper — Self-Healing Background Supervisor
Option Explicit

Dim WshShell, fso, appDir

Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = "C:\Users\chkam\OneDrive\Desktop\BrandFinder\SourceGenius\amazon-playwright-scraper"
WshShell.CurrentDirectory = appDir

Function ServerUp()
    Dim h
    ServerUp = False
    On Error Resume Next
    Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    h.setTimeouts 1000, 1000, 1000, 1000
    h.Open "GET", "http://127.0.0.1:3000/brand/stats", False
    h.Send
    If Err.Number = 0 And h.Status = 200 Then ServerUp = True
    On Error GoTo 0
End Function

' If already healthy on port 3000, exit cleanly
If ServerUp() Then WScript.Quit

Dim consecutiveErrors, exitCode
consecutiveErrors = 0

Do While True
    If Not ServerUp() Then
        exitCode = WshShell.Run(Chr(34) & appDir & "\run_scraper.bat" & Chr(34), 0, True)
        consecutiveErrors = consecutiveErrors + 1
        If consecutiveErrors > 5 Then
            WScript.Sleep 30000
            consecutiveErrors = 0
        Else
            WScript.Sleep 3000
        End If
    Else
        consecutiveErrors = 0
        WScript.Sleep 15000
    End If
Loop
