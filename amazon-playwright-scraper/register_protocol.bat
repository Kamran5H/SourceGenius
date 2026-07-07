@echo off
reg add "HKCU\Software\Classes\sgscraper" /ve /t REG_SZ /d "URL:sgscraper Protocol" /f
reg add "HKCU\Software\Classes\sgscraper" /v "URL Protocol" /t REG_SZ /d "" /f
reg add "HKCU\Software\Classes\sgscraper\shell\open\command" /ve /t REG_SZ /d "\"C:\Users\chkam\OneDrive\Desktop\source-genius...2\amazon-playwright-scraper\start.bat\"" /f
