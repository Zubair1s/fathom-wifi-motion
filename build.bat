@echo off
rem Builds dist\Fathom.exe. Needs Python and PyInstaller (pip install pyinstaller).
cd /d "%~dp0"
python build\make_icon.py
python -m PyInstaller --noconfirm --clean --onefile --console --name Fathom ^
  --icon "%~dp0build\icon.ico" ^
  --add-data "%~dp0static;static" ^
  --distpath "%~dp0dist" --workpath "%~dp0build\work" --specpath "%~dp0build" ^
  "%~dp0server.py"
echo.
echo Done: dist\Fathom.exe
pause
