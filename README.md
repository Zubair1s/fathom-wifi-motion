# Fathom

**WiFi motion sensing with nothing but your PC.**

Fathom notices when someone moves in a room by watching the WiFi signal between your PC and your router. Your body is mostly water, and water absorbs WiFi, so when someone walks through that path the signal starts jumping around. Fathom measures those jumps a few times per second and shows a live dashboard in your browser.

It needs no camera, microphone or extra hardware, and nothing leaves your computer.

## Download and run

1. Go to **[Releases](../../releases)** and download `Fathom.exe`.
2. Double-click it. A small console window opens (keep it open) and your browser shows the dashboard.
3. Click **Calibrate** and stay still for 10 seconds.
4. Walk between your PC and your router and watch it react.

On the first run Windows may say *"Windows protected your PC"* because the app isn't signed. Click **More info → Run anyway**.

### Requirements

- Windows 10 or 11
- Connected to WiFi (not an ethernet cable)
- **Location services on** (Settings → Privacy & security → Location). Windows only shares WiFi signal details with apps when this is enabled.

## What the dashboard shows

| | |
|---|---|
| **Room state** | "Still." or "Movement.", and for how long |
| **Signal** | Current signal strength (RSSI) in dBm |
| **Variation** | How much the signal fluctuated over the last ~3 seconds |
| **Disturbance** | Variation as a percentage of the trigger point (100% = movement) |
| **Calm baseline** | Your room's normal noise level, learned by calibrating |
| **Charts** | The last 60 seconds of signal, with movement shaded |
| **Activity** | Every movement detected, with time, duration and strength |
| **Sensitivity** | Trade fewer false alarms for catching smaller movement |

## How detection works

- Every 0.4 s Fathom reads the connection's RSSI from `netsh wlan show interfaces`.
- It takes the standard deviation of the last 8 readings (~3 s).
- Calibration records 10 s of a still room and sets the **baseline** to the 80th percentile of that variation.
- Movement starts when variation exceeds `baseline × factor` (the factor comes from the sensitivity slider, 1.5×–3.5×). It ends after 2.5 s back below 75% of that line, so it doesn't flicker.

### Limits

- It works best for movement that crosses the line between the PC and the router.
- It detects movement vs. stillness. It can't tell who is moving, where they are, or what they're doing.
- Windows only, since it reads the signal through `netsh`.
- It uses signal strength (RSSI), which is coarse. Research systems use Channel State Information (CSI) from hardware like ESP32 boards to recognise activities and even body pose.

## Run from source

Needs Python 3.10+ and no extra packages.

```bash
python server.py
```

Options:

- `--demo`: simulated signal with occasional movement, so you can try it without WiFi
- `--port 8000`: starting port (it moves to the next free one if taken)
- `--no-browser`: don't open the browser automatically

Or double-click `start.bat`.

## Build the .exe

```bash
pip install pyinstaller pillow
``` 

Then double-click `build.bat`. The result is `dist\Fathom.exe`.

## Project layout

```
server.py          backend: reads WiFi, detects motion, streams live (Server-Sent Events)
static/
  index.html       dashboard page
  style.css        styles (light and dark)
  app.js           live charts, animations, controls
build/
  make_icon.py     draws the app icon
  icon.ico
build.bat          builds Fathom.exe with PyInstaller
start.bat          runs from source
```

## Why "Fathom"

A fathom is a unit of depth that sailors measured by "sounding" the water with a weighted line. To fathom something also means to understand it. Fathom sounds out the invisible signal filling your room to work out what is happening in it.
