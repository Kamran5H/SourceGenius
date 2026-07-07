@echo off
REM Source Genius Urban VPN native host launcher.
REM Chrome runs this; it must not print anything to stdout except what the
REM runtime emits (the >nul on the where-check keeps stdout clean).
where bun >nul 2>nul && ( bun "%~dp0host.mjs" ) || ( node "%~dp0host.mjs" )
