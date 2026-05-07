#!/usr/bin/env python3
import argparse
import base64
import json
import multiprocessing
import sys
from array import array

from moonshine_voice import (
    LineCompleted,
    LineTextChanged,
    ModelArch,
    Transcriber,
    TranscriptEventListener,
    get_model_for_language,
)


MODEL_ARCH_BY_NAME = {
    "tiny": ModelArch.TINY_STREAMING,
    "small": ModelArch.SMALL_STREAMING,
    "medium": ModelArch.MEDIUM_STREAMING,
}


def emit(message):
    print(json.dumps(message, separators=(",", ":")), flush=True)


class JsonTranscriptListener(TranscriptEventListener):
    def on_line_text_changed(self, event: LineTextChanged):
        emit({"type": "transcript:partial", "text": event.line.text})

    def on_line_completed(self, event: LineCompleted):
        emit({"type": "transcript:committed", "text": event.line.text})

    def on_error(self, event):
        emit({"type": "error", "message": str(event.error)})


def pcm16le_base64_to_float32(audio_base64):
    pcm = array("h")
    pcm.frombytes(base64.b64decode(audio_base64))
    if sys.byteorder != "little":
        pcm.byteswap()
    return [sample / 32768.0 for sample in pcm]


def main():
    parser = argparse.ArgumentParser(description="AutoPreso Moonshine JSONL sidecar")
    parser.add_argument("--model", choices=sorted(MODEL_ARCH_BY_NAME), default="medium")
    parser.add_argument("--language", default="en")
    args = parser.parse_args()

    model_path, model_arch = get_model_for_language(
        wanted_language=args.language,
        wanted_model_arch=MODEL_ARCH_BY_NAME[args.model],
    )
    transcriber = Transcriber(model_path=model_path, model_arch=model_arch)
    transcriber.add_listener(JsonTranscriptListener())
    transcriber.start()
    started = True
    emit({"type": "ready"})

    try:
        for raw_line in sys.stdin:
            if not raw_line.strip():
                continue
            try:
                message = json.loads(raw_line)
                if message.get("type") == "audio":
                    if not started:
                        transcriber.start()
                        started = True
                    audio = pcm16le_base64_to_float32(message.get("audio", ""))
                    sample_rate = int(message.get("sampleRate", 24000))
                    transcriber.add_audio(audio, sample_rate)
                elif message.get("type") == "stop":
                    if started:
                        transcriber.stop()
                        started = False
            except Exception as error:
                emit({"type": "error", "message": str(error)})
    finally:
        if started:
            transcriber.stop()
        transcriber.close()


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
