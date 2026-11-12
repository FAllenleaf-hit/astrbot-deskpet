@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 ( echo 依赖安装失败 & pause & exit /b 1 )
)
echo 启动 Live2D 桌宠...
call npx electron .
