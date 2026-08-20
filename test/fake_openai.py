#!/usr/bin/env python3
"""Deterministic OpenAI-compatible logprob backend for integration tests.

It deliberately returns prefill score letters in ``reasoning_content`` with a
null normal content field, exercising the upstream reasoning-parser fix pinned
by the plugin. No model inference or external network call occurs.
"""

import argparse
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


LOCK = threading.Lock()
METRICS = {"calls": 0, "image_calls": 0, "requests": []}


def score_letter(text):
    return "A" if "CORRECT" in text and "WRONG" not in text else "T"


def token(token, alternatives=None):
    alternatives = alternatives or [(token, 0.0)]
    return {
        "token": token,
        "logprob": alternatives[0][1],
        "bytes": None,
        "top_logprobs": [
            {"token": value, "logprob": logprob, "bytes": None}
            for value, logprob in alternatives
        ],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def send_json(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/v1/models":
            self.send_json(200, {"object": "list", "data": [
                {"id": "fake-verifier", "object": "model", "created": 0,
                 "owned_by": "test"}
            ]})
            return
        if self.path == "/metrics":
            with LOCK:
                value = dict(METRICS)
            self.send_json(200, value)
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", "0")))
        if self.path == "/reset":
            with LOCK:
                METRICS.update(calls=0, image_calls=0, requests=[])
            self.send_json(200, {"ok": True})
            return
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": "not found"})
            return
        request = json.loads(raw or b"{}")
        messages = request.get("messages", [])
        user_content = messages[0].get("content", "") if messages else ""
        saw_image = isinstance(user_content, list) and any(
            item.get("type") == "image_url" for item in user_content
            if isinstance(item, dict))
        prompt = (next((item.get("text", "") for item in user_content
                        if isinstance(item, dict) and item.get("type") == "text"), "")
                  if isinstance(user_content, list) else str(user_content))
        assistant = messages[-1].get("content", "") if len(messages) > 1 else ""

        content = "analysis complete"
        reasoning_content = None
        positions = []
        if assistant.endswith("<score_A>") or assistant.endswith("<score_B>"):
            tag = "A" if assistant.endswith("<score_A>") else "B"
            match = re.search(
                rf"\*\*Trajectory {tag}:\*\*\n(.*?)(?:\n\n\*\*|\Z)",
                prompt, re.S)
            letter = score_letter(match.group(1) if match else "")
            content = None
            reasoning_content = letter
            positions = [token(letter)]
        elif "<c1>" in prompt:
            count = max([int(n) for n in re.findall(r"<c(\d+)>", prompt)] or [1])
            parts = []
            for index in range(1, count + 1):
                # Progress uses the opposite scale from pairwise comparison:
                # A = 0% complete, T = 100% complete.
                parts.extend([f"<c{index}>", "T", f"</c{index}>"])
            content = "".join(parts)
            positions = [token(value) for value in parts]

        with LOCK:
            METRICS["calls"] += 1
            METRICS["image_calls"] += int(saw_image)
            METRICS["requests"].append({
                "model": request.get("model"),
                "prefill": len(messages) > 1,
                "images": saw_image,
            })
            call_number = METRICS["calls"]

        message = {"role": "assistant", "content": content}
        if reasoning_content is not None:
            message["reasoning_content"] = reasoning_content
        response = {
            "id": f"fake-{call_number}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": request.get("model", "fake-verifier"),
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": "stop",
                "logprobs": {"content": positions},
            }],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": max(1, len(positions)),
                "total_tokens": 100 + max(1, len(positions)),
                "prompt_tokens_details": {
                    "cached_tokens": 80 if call_number > 1 else 0
                },
                "completion_tokens_details": {"reasoning_tokens": 0},
            },
        }
        self.send_json(200, response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(json.dumps({"ready": True, "port": server.server_address[1]}),
          flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
