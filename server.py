"""
Fathom - WiFi motion sensing backend.

Reads the WiFi signal strength (RSSI) of this PC's connection a few times per
second, detects movement from how much the signal fluctuates, and streams
everything live to the dashboard using Server-Sent Events.

Standard library only. Run:  python server.py   (add --demo for fake data)
"""

import argparse
import json
import math
import queue
import random
import re
import statistics
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import os

FROZEN = getattr(sys, "frozen", False)   # True when running as Fathom.exe
BASE_DIR = Path(__file__).resolve().parent
# Inside the .exe, bundled files are unpacked to a temp folder (sys._MEIPASS).
STATIC_DIR = Path(getattr(sys, "_MEIPASS", BASE_DIR)) / "static"
# The .exe keeps settings in %APPDATA%\Fathom so they survive between runs.
if FROZEN:
    DATA_DIR = Path(os.environ.get("APPDATA", Path.home())) / "Fathom"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
else:
    DATA_DIR = BASE_DIR
SETTINGS_FILE = DATA_DIR / "settings.json"

SAMPLE_INTERVAL = 0.4      # seconds between readings
WINDOW = 8                 # readings per variation window (~3 s)
HISTORY_SECONDS = 90       # how much history a new browser tab receives
CALIBRATION_SECONDS = 10
RELEASE_SECONDS = 2.5      # calm time needed before "motion" ends
DEFAULT_BASELINE = 1.5     # typical calm variation (dB) seen on this PC


# --------------------------------------------------------------------------- #
# Signal readers
# --------------------------------------------------------------------------- #

class NetshReader:
    """Reads the current connection from `netsh wlan show interfaces`."""

    LINE = re.compile(r"^\s*([^:]+?)\s*:\s(.*)$")

    def read(self):
        try:
            out = subprocess.run(
                ["netsh", "wlan", "show", "interfaces"],
                capture_output=True, text=True, timeout=3,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return None

        fields = {}
        for line in out.splitlines():
            m = self.LINE.match(line)
            if m:
                fields[m.group(1).strip().lower()] = m.group(2).strip()

        if fields.get("state") != "connected" or "rssi" not in fields:
            return None
        try:
            rssi = int(fields["rssi"])
        except ValueError:
            return None

        return {
            "rssi": rssi,
            "quality": int(fields.get("signal", "0").rstrip("% ") or 0),
            "ssid": fields.get("ssid", ""),
            "band": fields.get("band", ""),
            "channel": fields.get("channel", ""),
            "rate": fields.get("receive rate (mbps)", ""),
            "adapter": fields.get("description", ""),
        }


class DemoReader:
    """Synthetic signal with occasional bursts of 'movement'."""

    def __init__(self):
        self.t0 = time.time()
        self.next_burst = self.t0 + 8
        self.burst_end = 0

    def read(self):
        now = time.time()
        if now > self.next_burst and now > self.burst_end:
            self.burst_end = now + random.uniform(5, 10)
            self.next_burst = self.burst_end + random.uniform(10, 20)
        moving = now < self.burst_end
        base = -62 + 1.5 * math.sin((now - self.t0) / 20)
        noise = random.gauss(0, 4.5 if moving else 1.2)
        if moving and random.random() < 0.25:
            noise -= random.uniform(5, 12)  # body blocking the path
        return {
            "rssi": round(base + noise),
            "quality": 80,
            "ssid": "demo-network",
            "band": "5 GHz",
            "channel": "157",
            "rate": "150",
            "adapter": "Simulated adapter",
        }


# --------------------------------------------------------------------------- #
# Motion detector
# --------------------------------------------------------------------------- #

class Detector:
    """
    Motion = the signal varies much more than it does in a still room.

    variation  = standard deviation of the last WINDOW readings (dB)
    threshold  = baseline variation x factor (factor set by sensitivity)
    score      = variation / threshold   (1.0 = the trigger line)
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.window = deque(maxlen=WINDOW)
        self.baseline = DEFAULT_BASELINE
        self.calibrated_at = None
        self.sensitivity = 0.6
        self.motion = False
        self.state_since = time.time()
        self.calm_since = None
        self.calibration = None          # {"start": t, "values": [...]}
        self.events = deque(maxlen=40)   # newest last
        self.current_event = None
        self.events_changed = False
        self._load()

    # settings persistence ------------------------------------------------- #
    def _load(self):
        try:
            data = json.loads(SETTINGS_FILE.read_text())
            self.baseline = float(data.get("baseline", self.baseline))
            self.sensitivity = float(data.get("sensitivity", self.sensitivity))
            self.calibrated_at = data.get("calibrated_at")
        except (OSError, ValueError):
            pass

    def _save(self):
        try:
            SETTINGS_FILE.write_text(json.dumps({
                "baseline": self.baseline,
                "sensitivity": self.sensitivity,
                "calibrated_at": self.calibrated_at,
            }, indent=2))
        except OSError:
            pass

    # controls ------------------------------------------------------------- #
    @property
    def factor(self):
        # sensitivity 0 -> 3.5x baseline, 1 -> 1.5x baseline
        return 3.5 - 2.0 * self.sensitivity

    @property
    def threshold(self):
        return self.baseline * self.factor

    def set_sensitivity(self, value):
        with self.lock:
            self.sensitivity = min(1.0, max(0.0, float(value)))
            self._save()

    def start_calibration(self):
        with self.lock:
            self.calibration = {"start": time.time(), "values": []}

    def clear_events(self):
        with self.lock:
            self.events.clear()
            self.events_changed = True

    # per-sample update ---------------------------------------------------- #
    def update(self, rssi, now):
        with self.lock:
            cal = None
            if self.calibration is not None:
                self.calibration["values"].append(rssi)
                elapsed = now - self.calibration["start"]
                if elapsed >= CALIBRATION_SECONDS:
                    self._finish_calibration(now)
                    cal = {"done": True, "baseline": self.baseline}
                else:
                    cal = {"progress": elapsed / CALIBRATION_SECONDS}

            self.window.append(rssi)
            std = statistics.pstdev(self.window) if len(self.window) >= 3 else 0.0
            score = std / self.threshold if self.threshold else 0.0

            # Hysteresis: start instantly, end only after a calm stretch.
            if self.calibration is None:
                if score >= 1.0:
                    self.calm_since = None
                    if not self.motion:
                        self._set_motion(True, now)
                elif self.motion:
                    if score < 0.75:
                        self.calm_since = self.calm_since or now
                        if now - self.calm_since >= RELEASE_SECONDS:
                            self._set_motion(False, now)
                    else:
                        self.calm_since = None

            if self.current_event:
                self.current_event["peak"] = max(self.current_event["peak"], score)
                self.current_event["end"] = now

            events = None
            if self.events_changed:
                events = self._event_list()
                self.events_changed = False

            return {
                "std": round(std, 2),
                "score": round(score, 3),
                "threshold": round(self.threshold, 2),
                "motion": self.motion,
                "since": self.state_since,
                "calibration": cal,
                "events": events,
            }

    def _finish_calibration(self, now):
        values = self.calibration["values"]
        self.calibration = None
        stds = [statistics.pstdev(values[i:i + WINDOW])
                for i in range(0, max(1, len(values) - WINDOW + 1))]
        stds.sort()
        p80 = stds[min(len(stds) - 1, int(len(stds) * 0.8))] if stds else DEFAULT_BASELINE
        self.baseline = round(min(4.0, max(0.7, p80)), 2)
        self.calibrated_at = now
        self.window.clear()
        if self.motion:
            self._set_motion(False, now)
        self._save()

    def _set_motion(self, on, now):
        self.motion = on
        self.state_since = now
        self.calm_since = None
        if on:
            self.current_event = {"start": now, "end": now, "peak": 0.0}
            self.events.append(self.current_event)
        else:
            self.current_event = None
        self.events_changed = True

    def _event_list(self):
        return [dict(e) for e in reversed(self.events)]

    def snapshot(self):
        with self.lock:
            return {
                "baseline": self.baseline,
                "sensitivity": self.sensitivity,
                "threshold": round(self.threshold, 2),
                "calibrated_at": self.calibrated_at,
                "calibrating": self.calibration is not None,
                "motion": self.motion,
                "since": self.state_since,
                "events": self._event_list(),
            }


# --------------------------------------------------------------------------- #
# Sampler + broadcast
# --------------------------------------------------------------------------- #

class Hub:
    def __init__(self, reader, detector):
        self.reader = reader
        self.detector = detector
        self.history = deque(maxlen=int(HISTORY_SECONDS / SAMPLE_INTERVAL))
        self.subscribers = set()
        self.sub_lock = threading.Lock()
        self.link = None

    def subscribe(self):
        q = queue.Queue(maxsize=200)
        with self.sub_lock:
            self.subscribers.add(q)
        return q

    def unsubscribe(self, q):
        with self.sub_lock:
            self.subscribers.discard(q)

    def publish(self, message):
        data = json.dumps(message)
        with self.sub_lock:
            for q in list(self.subscribers):
                try:
                    q.put_nowait(data)
                except queue.Full:
                    pass

    def run(self):
        while True:
            started = time.time()
            reading = self.reader.read()
            now = time.time()
            if reading is None:
                self.publish({"type": "sample", "t": now, "rssi": None})
            else:
                self.link = {k: v for k, v in reading.items() if k != "rssi"}
                result = self.detector.update(reading["rssi"], now)
                sample = {
                    "type": "sample", "t": now, "rssi": reading["rssi"],
                    "std": result["std"], "score": result["score"],
                    "motion": result["motion"],
                }
                self.history.append(sample)
                msg = dict(sample, threshold=result["threshold"],
                           since=result["since"], link=self.link)
                if result["calibration"]:
                    msg["calibration"] = result["calibration"]
                if result["events"] is not None:
                    msg["events"] = result["events"]
                self.publish(msg)
            time.sleep(max(0.05, SAMPLE_INTERVAL - (time.time() - started)))


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

def make_handler(hub):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

        def log_message(self, *args):
            pass

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _json(self, payload, status=200):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length))
            except ValueError:
                return {}

        def do_GET(self):
            if self.path == "/api/stream":
                return self._stream()
            if self.path == "/api/state":
                return self._json(self._init_payload())
            return super().do_GET()

        def do_POST(self):
            if self.path == "/api/calibrate":
                hub.detector.start_calibration()
                return self._json({"ok": True, "seconds": CALIBRATION_SECONDS})
            if self.path == "/api/settings":
                body = self._body()
                if "sensitivity" in body:
                    hub.detector.set_sensitivity(body["sensitivity"])
                return self._json(hub.detector.snapshot())
            if self.path == "/api/events/clear":
                hub.detector.clear_events()
                return self._json({"ok": True})
            self.send_error(404)

        def _init_payload(self):
            return {
                "type": "init",
                "history": list(hub.history),
                "link": hub.link,
                "interval": SAMPLE_INTERVAL,
                "calibration_seconds": CALIBRATION_SECONDS,
                **hub.detector.snapshot(),
            }

        def _stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            q = hub.subscribe()
            try:
                self._send(json.dumps(self._init_payload()))
                while True:
                    try:
                        self._send(q.get(timeout=10))
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                pass
            finally:
                hub.unsubscribe(q)

        def _send(self, data):
            self.wfile.write(f"data: {data}\n\n".encode())
            self.wfile.flush()

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Fathom WiFi motion sensing")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--demo", action="store_true", help="use simulated signal")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    reader = DemoReader() if args.demo else NetshReader()
    if not args.demo and reader.read() is None:
        print("Could not read WiFi signal. Check that WiFi is connected and "
              "Location services are on (Windows needs it to share WiFi info).\n"
              "Starting anyway - or run with --demo to use simulated data.")

    hub = Hub(reader, Detector())
    threading.Thread(target=hub.run, daemon=True).start()

    class Server(ThreadingHTTPServer):
        # On Windows SO_REUSEADDR would let two servers share a port; we want
        # a clean failure so we can move on to the next free one instead.
        allow_reuse_address = False
        daemon_threads = True

    server = None
    for port in range(args.port, args.port + 20):
        try:
            server = Server(("127.0.0.1", port), make_handler(hub))
            break
        except OSError:
            continue
    if server is None:
        print(f"No free port between {args.port} and {args.port + 19}.")
        if FROZEN:
            input("Press Enter to close.")
        sys.exit(1)

    url = f"http://localhost:{port}"
    print()
    print("  Fathom - WiFi motion sensing")
    print(f"  Running at {url}")
    print("  Keep this window open. Close it (or press Ctrl+C) to stop.")
    print()
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
