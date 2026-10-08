@echo off
rem Doble clic para correr el MVP con AWS simulado (Windows).
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if not errorlevel 1 goto run

echo.
echo No se encontro Node.js. Se necesita Node.js 22 LTS o 24 LTS: https://nodejs.org
where winget >nul 2>nul
if errorlevel 1 goto manual
choice /M "Instalar Node.js LTS ahora con winget"
if errorlevel 2 goto manual
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
echo.
echo Node.js instalado. Cierre esta ventana y vuelva a abrir iniciar-mvp.cmd.
pause
exit /b 0

:manual
echo Instale Node.js desde https://nodejs.org y vuelva a abrir este archivo.
pause
exit /b 1

:run
node iniciar-mvp.mjs %*
pause
