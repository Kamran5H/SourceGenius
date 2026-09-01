@echo off
title Source Genius Playwright Scraper
:loop
echo Starting Amazon Playwright Scraper...
node server.js
echo Scraper crashed or stopped. Restarting in 2 seconds...
timeout /t 2 > nul
goto loop
