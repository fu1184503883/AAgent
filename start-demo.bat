@echo off
chcp 65001 >nul
title YFIDP AI 工艺助手 - AAGNet 演示

rem 单页离线演示，无需服务器 / 无需联网 / 无需 Python 环境
rem 直接双击本文件即可用默认浏览器打开

if not exist "%~dp0index.html" (
  echo [错误] 未找到 index.html，请保持本文件与 index.html 在同一目录。
  pause
  exit /b 1
)

echo 正在打开演示页面...
start "" "%~dp0index.html"
exit /b 0
