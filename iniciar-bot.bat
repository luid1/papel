@echo off
title Lumin Bot
echo.
echo  ██╗     ██╗   ██╗███╗   ███╗██╗███╗   ██╗
echo  ██║     ██║   ██║████╗ ████║██║████╗  ██║
echo  ██║     ██║   ██║██╔████╔██║██║██╔██╗ ██║
echo  ██║     ██║   ██║██║╚██╔╝██║██║██║╚██╗██║
echo  ███████╗╚██████╔╝██║ ╚═╝ ██║██║██║ ╚████║
echo  ╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝
echo.
echo  Iniciando Lumin Bot...
echo.

SET PATH=%APPDATA%\npm;%PATH%
cd /d "%~dp0"

:: Verifica se pm2 está rodando
pm2 describe lumin-bot >nul 2>&1
IF %ERRORLEVEL% == 0 (
    echo  Bot ja esta rodando! Reiniciando...
    pm2 restart lumin-bot
) ELSE (
    echo  Iniciando pela primeira vez...
    pm2 start ecosystem.config.js
    pm2 save
)

echo.
echo  ✓ Tudo iniciado!
echo.
echo  Lumin Bot    -^> porta 3001 (WhatsApp + API)
echo  Lumin App    -^> http://localhost:8080
echo.
echo  Veja os logs abaixo (Ctrl+C fecha os logs, o sistema continua rodando):
echo.
pm2 logs
