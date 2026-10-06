#!/usr/bin/env python3
"""
Vesper's optional openWakeWord worker.

This file is only a bridge. The openwakeword and onnxruntime packages remain
separately installed dependencies; their source is not vendored into Vesper.

Input: microphone stream captured by PyAudio, 16 kHz mono signed 16-bit PCM.
Output: JSON lines on stdout when the configured model crosses threshold.
No network access is performed and models are never downloaded automatically.
"""

import argparse
import json
import os
import sys
import time


def fail(detail: str, code: int = 2) -> int:
    sys.stdout.write(json.dumps({"ok": False, "detail": detail}) + "\n")
    sys.stdout.flush()
    return code


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--device-name", default="")
    parser.add_argument("--chunk-size", type=int, default=1280)
    args = parser.parse_args()

    if not os.path.isfile(args.model):
        return fail("Wake model does not exist: " + args.model)
    if not (0.05 <= args.threshold <= 0.99):
        return fail("Wake threshold must be between 0.05 and 0.99.")
    if not (640 <= args.chunk_size <= 3200):
        return fail("Wake chunk size is outside the supported safety bound.")

    try:
        import numpy as np
        import pyaudio
        from openwakeword.model import Model
    except Exception as exc:
        return fail("openWakeWord dependencies are unavailable: " + str(exc))

    try:
        model = Model(
            wakeword_models=[args.model],
            inference_framework="onnx",
        )
    except Exception as exc:
        return fail("Could not load the openWakeWord model: " + str(exc))

    pa = pyaudio.PyAudio()
    stream = None
    try:
        input_index = None
        if args.device_name:
            wanted = args.device_name.strip().casefold()
            for index in range(pa.get_device_count()):
                info = pa.get_device_info_by_index(index)
                name = str(info.get("name", "")).strip()
                if name.casefold() == wanted and int(info.get("maxInputChannels", 0)) > 0:
                    input_index = index
                    break
            if input_index is None:
                return fail("Configured wake microphone was not found in PyAudio devices.")

        stream = pa.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=16000,
            input=True,
            input_device_index=input_index,
            frames_per_buffer=args.chunk_size,
        )
        last_fire = 0.0
        latched = False
        sys.stdout.write(json.dumps({"ok": True, "detail": "openWakeWord worker ready"}) + "\n")
        sys.stdout.flush()

        while True:
            raw = stream.read(args.chunk_size, exception_on_overflow=False)
            audio = np.frombuffer(raw, dtype=np.int16)
            scores = model.predict(audio)

            best_name = None
            best_score = 0.0
            for name, score in scores.items():
                numeric = float(score)
                if numeric > best_score:
                    best_name = str(name)
                    best_score = numeric

            now = time.monotonic()
            if best_score >= args.threshold:
                if not latched and now - last_fire >= 1.5:
                    sys.stdout.write(
                        json.dumps(
                            {
                                "wake": True,
                                "model": best_name,
                                "score": best_score,
                            }
                        )
                        + "\n"
                    )
                    sys.stdout.flush()
                    last_fire = now
                    latched = True
            elif latched and best_score < args.threshold * 0.5:
                latched = False
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        return fail("openWakeWord worker stopped: " + str(exc), 3)
    finally:
        try:
            if stream is not None:
                stream.stop_stream()
                stream.close()
        except Exception:
            pass
        try:
            pa.terminate()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
