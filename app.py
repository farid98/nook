import io
import json
import os
import tempfile
import urllib.request
import wave
from datetime import date

import numpy as np
import ollama
from dotenv import load_dotenv
from faster_whisper import WhisperModel
from flask import Flask, Response, render_template, request, stream_with_context
from kokoro_onnx import Kokoro
from ollama import web_fetch, web_search
from pypdf import PdfReader

load_dotenv()

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")

WEB_TOOLS = [web_search, web_fetch]
AVAILABLE_TOOLS = {"web_search": web_search, "web_fetch": web_fetch}

WHISPER_MODEL_SIZE = "base"

try:
    # Already cached from a previous run: skip the Hugging Face Hub
    # network check entirely and load fully offline.
    whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8", local_files_only=True)
except Exception:
    # First run: weights aren't cached yet, so we need to fetch them once.
    whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")

KOKORO_DIR = os.path.expanduser("~/.cache/kokoro-onnx")
KOKORO_MODEL_PATH = os.path.join(KOKORO_DIR, "kokoro-v1.0.fp16.onnx")
KOKORO_VOICES_PATH = os.path.join(KOKORO_DIR, "voices-v1.0.bin")
KOKORO_RELEASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
KOKORO_VOICE = "af_bella"

kokoro_model = None


def get_kokoro_model() -> Kokoro:
    global kokoro_model
    if kokoro_model is None:
        os.makedirs(KOKORO_DIR, exist_ok=True)
        for filename, path in [
            ("kokoro-v1.0.fp16.onnx", KOKORO_MODEL_PATH),
            ("voices-v1.0.bin", KOKORO_VOICES_PATH),
        ]:
            if not os.path.exists(path):
                urllib.request.urlretrieve(f"{KOKORO_RELEASE_URL}/{filename}", path)
        kokoro_model = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH)
    return kokoro_model


def encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return buffer.getvalue()


def web_tool_instructions() -> str:
    return (
        f"\n\nToday's date is {date.today():%B %d, %Y}. Your training data has a cutoff "
        "well before this date, so trust this date and the content returned by your tools "
        "over your own assumptions about what is recent. You have access to web_search and "
        "web_fetch tools. Use web_search when the user asks about current events, prices, "
        "recent releases, or anything that might have changed since your training data. Use "
        "web_fetch to read a specific URL the user gives you. Don't use tools for general "
        "knowledge questions you already know well."
    )


DEFAULT_SETTINGS = {
    "model_name": "gemma4:26b-mlx",
    "system_prompt": "You are a highly intelligent assistant. But alwways speak in the style of james bond",
    "temperature": 0.7,
    "top_p": 0.9,
    "top_k": 40,
    "repeat_penalty": 1.1,
    "num_ctx": 8192,
    "num_predict": 2048,
    "tts_engine": "browser",
}


def load_settings() -> dict:
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return {**DEFAULT_SETTINGS, **json.load(f)}
    return dict(DEFAULT_SETTINGS)


def save_settings(data: dict) -> None:
    with open(CONFIG_PATH, "w") as f:
        json.dump(data, f, indent=2)


app = Flask(__name__)

settings = load_settings()
messages = []
web_search_enabled = False
context_tokens = 0
cancel_requested = False


def reset_messages():
    global context_tokens
    messages.clear()
    messages.append({"role": "system", "content": settings["system_prompt"]})
    context_tokens = 0


reset_messages()


def build_system_content() -> str:
    content = settings["system_prompt"]
    if web_search_enabled:
        content += web_tool_instructions()
    return content


def sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


@app.route("/")
def index():
    return render_template("index.html", model_name=settings["model_name"])


@app.route("/api/settings", methods=["GET"])
def get_settings():
    return settings


@app.route("/api/settings", methods=["POST"])
def update_settings():
    payload = request.json or {}

    for key in DEFAULT_SETTINGS:
        if key in payload:
            settings[key] = payload[key]

    save_settings(settings)
    reset_messages()

    return settings


@app.route("/api/settings/reset", methods=["POST"])
def reset_settings():
    settings.clear()
    settings.update(DEFAULT_SETTINGS)
    save_settings(settings)
    reset_messages()

    return settings


@app.route("/api/context", methods=["GET"])
def get_context():
    return {"tokens": context_tokens, "limit": settings["num_ctx"]}


@app.route("/api/models", methods=["GET"])
def list_models():
    response = ollama.list()
    names = sorted(model.model for model in response.models)
    return {"models": names}


@app.route("/api/models/vision", methods=["GET"])
def model_vision():
    model_name = request.args.get("model", settings["model_name"])
    info = ollama.show(model_name)
    return {"vision": "vision" in (info.capabilities or [])}


@app.route("/api/extract-document", methods=["POST"])
def extract_document():
    doc_file = request.files.get("document")
    if doc_file is None:
        return Response(status=400)

    filename = doc_file.filename or "document"

    if filename.lower().endswith(".pdf"):
        reader = PdfReader(doc_file.stream)
        text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
    else:
        text = doc_file.stream.read().decode("utf-8", errors="replace")

    return {"filename": filename, "text": text.strip()}


@app.route("/api/speak", methods=["POST"])
def speak():
    text = (request.json or {}).get("text", "").strip()
    if not text:
        return Response(status=400)

    kokoro = get_kokoro_model()
    samples, sample_rate = kokoro.create(text, voice=KOKORO_VOICE, lang="en-us")

    return Response(encode_wav(samples, sample_rate), mimetype="audio/wav")


@app.route("/api/web-search", methods=["GET"])
def get_web_search():
    return {"enabled": web_search_enabled}


@app.route("/api/web-search", methods=["POST"])
def set_web_search():
    global web_search_enabled
    web_search_enabled = bool((request.json or {}).get("enabled"))
    return {"enabled": web_search_enabled}


@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    audio_file = request.files.get("audio")
    if audio_file is None:
        return Response(status=400)

    with tempfile.NamedTemporaryFile(suffix=".webm") as tmp:
        audio_file.save(tmp.name)
        segments, _ = whisper_model.transcribe(tmp.name)
        text = "".join(segment.text for segment in segments).strip()

    return {"text": text}


@app.route("/api/chat/cancel", methods=["POST"])
def cancel_chat():
    global cancel_requested
    cancel_requested = True
    return {"status": "ok"}


@app.route("/api/chat", methods=["POST"])
def chat():
    global cancel_requested
    cancel_requested = False

    payload = request.json or {}
    user_input = payload.get("message", "").strip()
    images = payload.get("images") or []
    if not user_input:
        return Response(status=400)

    user_message = {"role": "user", "content": user_input}
    if images:
        user_message["images"] = images
    messages.append(user_message)

    options = {
        "temperature": settings["temperature"],
        "top_p": settings["top_p"],
        "top_k": settings["top_k"],
        "repeat_penalty": settings["repeat_penalty"],
        "num_ctx": settings["num_ctx"],
        "num_predict": settings["num_predict"],
    }

    MAX_TOOL_ROUNDS = 5

    def generate():
        global context_tokens

        total_eval_count = 0
        total_eval_duration = 0
        done_reason = None

        try:
            for round_num in range(MAX_TOOL_ROUNDS + 1):
                outgoing = list(messages)
                outgoing[0] = {"role": "system", "content": build_system_content()}

                offer_tools = web_search_enabled and round_num < MAX_TOOL_ROUNDS

                stream = ollama.chat(
                    model=settings["model_name"],
                    messages=outgoing,
                    options=options,
                    stream=True,
                    think=True,
                    tools=WEB_TOOLS if offer_tools else None,
                )

                full_response = ""
                tool_calls = None

                try:
                    for chunk in stream:
                        if cancel_requested:
                            break

                        message = chunk["message"]
                        thinking = message.get("thinking") or ""
                        content = message.get("content") or ""

                        if thinking:
                            yield sse({"type": "thinking", "text": thinking})

                        if content:
                            full_response += content
                            yield sse({"type": "content", "text": content})

                        if message.get("tool_calls"):
                            tool_calls = message["tool_calls"]

                        if chunk.get("done"):
                            total_eval_count += chunk.get("eval_count") or 0
                            total_eval_duration += chunk.get("eval_duration") or 0
                            context_tokens += (chunk.get("prompt_eval_count") or 0) + (chunk.get("eval_count") or 0)
                            done_reason = chunk.get("done_reason")
                finally:
                    # Explicitly closing the generator closes the underlying HTTP
                    # connection to Ollama, which makes Ollama abort generation
                    # immediately instead of finishing a reply nobody will see.
                    stream.close()
                    assistant_message = {"role": "assistant", "content": full_response}
                    if tool_calls:
                        assistant_message["tool_calls"] = tool_calls
                    messages.append(assistant_message)

                if cancel_requested or not tool_calls:
                    break

                for tool_call in tool_calls:
                    name = tool_call.function.name
                    arguments = tool_call.function.arguments
                    fn = AVAILABLE_TOOLS.get(name)

                    yield sse({"type": "tool_call", "name": name, "arguments": arguments})

                    if fn is None:
                        result = f"Tool {name} not found"
                    else:
                        result = str(fn(**arguments))[:8000]

                    messages.append({"role": "tool", "tool_name": name, "content": result})
                    yield sse({"type": "tool_result", "name": name})

            if total_eval_duration:
                tokens_per_second = total_eval_count / (total_eval_duration / 1e9)
                yield sse({
                    "type": "stats",
                    "tokens": total_eval_count,
                    "tokens_per_second": round(tokens_per_second, 1),
                    "context_tokens": context_tokens,
                    "context_limit": settings["num_ctx"],
                    "truncated": done_reason == "length",
                })

            yield sse({"type": "done"})
        except Exception as e:
            yield sse({"type": "error", "text": str(e)})

    return Response(stream_with_context(generate()), mimetype="text/event-stream")


@app.route("/api/reset", methods=["POST"])
def reset():
    reset_messages()
    return {"status": "ok"}


if __name__ == "__main__":
    app.run(debug=True, port=5050)
