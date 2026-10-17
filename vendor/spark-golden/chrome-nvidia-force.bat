@echo off
REM Kill Chrome
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 2

REM Set NVIDIA GPU environment
set CUDA_DEVICE_ORDER=PCI_BUS_ID
set CUDA_VISIBLE_DEVICES=0
set DXVK_HUD=off
set DXVK_FILTER_DEVICE_NAME=RTX 4070

REM Start Chrome with GPU flags
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --use-angle=d3d11 ^
  --enable-gpu-rasterization ^
  --disable-gpu-sandbox ^
  --gpu-device-id=0x2820 ^
  --gpu-vendor-id=0x10de ^
  --gpu-driver-bug-workarounds=disable_msaa_on_intel_gpu ^
  chrome://gpu

timeout /t 8
