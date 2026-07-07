#Requires AutoHotkey v2.0
#SingleInstance Force
SetWorkingDir A_ScriptDir
CoordMode "Mouse", "Screen"
CoordMode "Pixel", "Screen"

; ═══════════════════════════════════════════════════════════════════════
; Source Genius — Urban VPN clicker
; ═══════════════════════════════════════════════════════════════════════
; Called as:  AutoHotkey64.exe UrbanVPN.ahk <connect|disconnect|rotate>
;
; It finds Urban VPN's pinned toolbar icon by image, clicks to open the
; popup, then clicks Connect / Disconnect / a country by image. You MUST
; calibrate the images in .\img\ once (see README "Calibration"):
;     img\icon.png        the Urban VPN toolbar icon
;     img\connect.png     the "Connect" button in the popup
;     img\disconnect.png  the "Disconnect" button in the popup
;     img\location.png    the country/location selector row in the popup
;     img\country1.png … country4.png   a few country entries to rotate through
;
; If clicks miss, widen TOL or re-capture the images at the same DPI/zoom.
; ═══════════════════════════════════════════════════════════════════════

imgDir := A_ScriptDir "\img\"
TOL    := "*45 "            ; ImageSearch tolerance — raise if icons aren't found

action := A_Args.Length >= 1 ? A_Args[1] : "connect"

if !OpenPopup() {
    Log("could not find/click Urban VPN toolbar icon (img\icon.png)")
    ExitApp 2
}
Sleep 800

switch action {
    case "connect":    DoConnect()
    case "disconnect": DoDisconnect()
    case "rotate":     DoRotate()
    default:           DoConnect()
}
ExitApp 0

; ── open the popup by clicking the pinned toolbar icon ──────────────────
OpenPopup() {
    ; icons live in the top strip of the browser window
    if Find(imgDir "icon.png", &x, &y, 0, 0, A_ScreenWidth, 140) {
        Click x, y
        return true
    }
    return false
}

DoConnect() {
    ; already connected? (Disconnect button visible) → leave it
    if Find(imgDir "disconnect.png", &x, &y) {
        ClosePopup()
        return
    }
    if Find(imgDir "connect.png", &x, &y)
        Click x, y
    Log("connect clicked")
    ClosePopup()
}

DoDisconnect() {
    if Find(imgDir "disconnect.png", &x, &y)
        Click x, y
    Log("disconnect clicked")
    ClosePopup()
}

; rotate = pick a different country. Urban VPN free reassigns a node when you
; switch country, which usually changes the egress IP. Best-effort: open the
; location list and click the first country image that matches.
DoRotate() {
    if Find(imgDir "location.png", &x, &y) {
        Click x, y
        Sleep 600
    }
    picked := false
    Loop 4 {
        f := imgDir "country" A_Index ".png"
        if FileExist(f) && Find(f, &cx, &cy) {
            Click cx, cy
            picked := true
            break
        }
    }
    ; if no country images calibrated, fall back to disconnect→reconnect
    if !picked {
        DoDisconnect()
        Sleep 1200
        OpenPopup()
        Sleep 800
        DoConnect()
        return
    }
    Log("rotate: country clicked")
    ClosePopup()
}

ClosePopup() {
    Send "{Esc}"
}

Find(path, &fx, &fy, x1 := 0, y1 := 0, x2 := 0, y2 := 0) {
    global TOL
    if (x2 = 0)
        x2 := A_ScreenWidth
    if (y2 = 0)
        y2 := A_ScreenHeight
    if !FileExist(path)
        return false
    try {
        if ImageSearch(&rx, &ry, x1, y1, x2, y2, TOL path) {
            fx := rx + 8
            fy := ry + 8
            return true
        }
    }
    return false
}

Log(msg) {
    try FileAppend FormatTime(, "yyyy-MM-dd HH:mm:ss") "  " msg "`n", A_ScriptDir "\vpn-clicker.log"
}
