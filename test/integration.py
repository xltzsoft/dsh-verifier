#!/usr/bin/env python3
"""Deterministic end-to-end validation for the DSH Verifier sidecar.

The test starts a local OpenAI-compatible logprob backend, runs the pinned
official framework through the production sidecar, and checks every public
framework capability exposed by the preset. It never uses a paid API.
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FAKE = ROOT / "test" / "fake_openai.py"
FRAMEWORK_COMMIT = "8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770"
# Valid one-pixel PNG; this exercises the framework's real image loader.
ONE_PIXEL_PNG = base64.b64encode(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "/x8AAusB9Wl2nWQAAAAASUVORK5CYII="
)).decode()


def start(command, env=None):
    process = subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=env)
    line = process.stdout.readline().strip()
    try:
        ready = json.loads(line)
    except ValueError as exc:
        stderr = process.stderr.read(2000)
        raise RuntimeError(f"process did not report ready: {line!r}\n{stderr}") from exc
    assert ready.get("ready") is True and ready.get("port")
    return process, ready


def stop(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def request(base, path, body=None, method=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        base + path, data=data, method=method or ("POST" if body is not None else "GET"),
        headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def wait_job(base, job_id, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = request(base, "/job?id=" + urllib.parse.quote(job_id))
        if job["status"] in ("done", "error", "canceled"):
            return job
        time.sleep(0.1)
    raise TimeoutError(f"job {job_id} did not finish")


def direct_select(python, fake_base, cache):
    script = r'''
import json, sys
import llm_verifier
r = llm_verifier.select(
    "Choose the correct implementation",
    ["WRONG zero", "CORRECT best", "WRONG other"],
    criteria={"correctness": "The implementation is correct."},
    n_evaluations=2, pivots=1, seed=7, model="custom-model-42",
    cache=sys.argv[1], on_error="raise", progress=False)
print(json.dumps({"index": r.index, "scores": r.scores,
                  "ranking": r.ranking, "n_comparisons": r.n_comparisons}))
'''
    env = dict(os.environ)
    for key in ("DEEPSEEK_API_KEY", "VERTEX_API_KEY"):
        env.pop(key, None)
    env.update(OPENAI_BASE_URL=fake_base + "/v1", OPENAI_API_KEY="test")
    out = subprocess.check_output(
        [str(python), "-c", script, str(cache)], text=True, env=env)
    return json.loads(out.strip())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--python", default=str(Path.home() / ".dsh/verifier/venv/bin/python"),
        help="Python interpreter containing the pinned llm-verifier checkout")
    parser.add_argument(
        "--data", default=str(Path.home() / ".dsh/verifier/data"),
        help="Pinned official framework checkout containing benchmark data")
    args = parser.parse_args()
    # Do not resolve the venv's `python` symlink: launching the resolved host
    # interpreter path would bypass pyvenv.cfg and therefore its site-packages.
    verifier_python = Path(args.python).expanduser().absolute()
    data_checkout = Path(args.data).expanduser().resolve()
    if not verifier_python.is_file():
        raise SystemExit(f"missing verifier Python: {verifier_python}")
    if not (data_checkout / "data").is_dir():
        raise SystemExit(f"missing benchmark checkout: {data_checkout}")

    fake_process = sidecar_process = None
    with tempfile.TemporaryDirectory(prefix="dsh-verifier-test-") as tmp:
        tmp_path = Path(tmp)
        try:
            fake_process, fake_ready = start([sys.executable, str(FAKE), "--port", "0"])
            fake_base = f"http://127.0.0.1:{fake_ready['port']}"
            dsh_home = tmp_path / ".dsh"
            dsh_home.mkdir()
            (dsh_home / "verifier.json").write_text(json.dumps({
                "backend": "openai",
                "model": "config-default-model",
                "openaiBaseURL": fake_base + "/v1",
                "openaiApiKey": "test",
                "dataDir": str(data_checkout),
            }))
            env = dict(os.environ)
            for key in ("OPENAI_BASE_URL", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
                        "VERTEX_API_KEY"):
                env.pop(key, None)
            env.update(DSH_HOME=str(dsh_home), PYTHONUNBUFFERED="1")
            sidecar_process, sidecar_ready = start([
                str(verifier_python), str(ASSETS / "sidecar.py"),
                "--root", str(ASSETS), "--port", "0"], env=env)
            base = f"http://127.0.0.1:{sidecar_ready['port']}"

            health = request(base, "/health")
            assert health["framework"]["commit"] == FRAMEWORK_COMMIT
            assert health["framework"]["commit"] == health["framework"]["requiredCommit"]
            backend = request(base, "/backend")
            assert backend["backend"] == "openai" and backend["ready"]
            assert backend["model"] == "config-default-model"
            assert request(base, "/criteria/list")["criteria"] == [
                "medagentbench", "swe_bench", "terminal_bench"]
            benchmarks = request(base, "/benchmarks")
            assert benchmarks["exactCheckout"] is True
            assert len(benchmarks["benchmarks"]) == 4

            request(fake_base, "/reset", {})
            comparison = request(base, "/compare", {
                "problem": "Choose the correct implementation",
                "candidate_a": "CORRECT implementation",
                "candidate_b": "WRONG implementation",
                "criteria": {"correctness": "The implementation is correct."},
                "images": [{"base64": ONE_PIXEL_PNG}],
                "ground_truth_note": "A correct implementation must satisfy the tests.",
                "n_evaluations": 2,
                "model": "custom-model-42",
                "max_workers": 2,
            })
            assert comparison["winner"] == "a"
            assert comparison["reward_a"] == 1.0 and comparison["reward_b"] == 0.0
            metrics = request(fake_base, "/metrics")
            # The upstream OpenAI path uses one generation plus two prefills
            # (score_A and score_B) per evaluation repeat.
            assert metrics["calls"] == 6 and metrics["image_calls"] == 6, metrics
            assert {item["model"] for item in metrics["requests"]} == {"custom-model-42"}

            cache = tmp_path / "selection-cache.json"
            selection_payload = {
                "problem": "Choose the correct implementation",
                "candidates": ["WRONG zero", "CORRECT best", "WRONG other"],
                "criteria": {"correctness": "The implementation is correct."},
                "n_evaluations": 2,
                "pivots": 1,
                "seed": 7,
                "model": "custom-model-42",
                "max_workers": 2,
                "cache": str(cache),
                "on_error": "raise",
            }
            request(fake_base, "/reset", {})
            selected = request(base, "/select", selection_payload)
            assert selected["index"] == 1 and selected["ranking"][0] == 1
            assert selected["usage"]["calls"] > 0
            request(fake_base, "/reset", {})
            cached = request(base, "/select", selection_payload)
            assert cached["usage"]["calls"] == 0
            assert request(fake_base, "/metrics")["calls"] == 0
            assert (cached["index"], cached["scores"], cached["ranking"]) == (
                selected["index"], selected["scores"], selected["ranking"])

            # A direct official API call using the same cache must be bit-for-bit
            # equivalent to the wrapper hot path and also make zero backend calls.
            direct = direct_select(verifier_python, fake_base, cache)
            assert (direct["index"], direct["scores"], direct["ranking"]) == (
                cached["index"], cached["scores"], cached["ranking"])
            assert request(fake_base, "/metrics")["calls"] == 0

            tracked = request(base, "/track", {
                "problem": "Finish the task",
                "steps": ["inspect", "implement", "verification passed"],
                "checkpoint_steps": [1, 2, 3],
                "n_evaluations": 2,
                "model": "custom-model-42",
                "max_workers": 2,
            })
            assert tracked["scores"] == [1.0, 1.0, 1.0] and tracked["final"] == 1.0

            tracker = request(base, "/tracker/start", {
                "problem": "Finish the task", "n_evaluations": 2,
                "model": "custom-model-42", "max_workers": 2})
            update = request(base, "/tracker/update", {
                "tracker_id": tracker["tracker_id"],
                "step": "implemented and verified"})
            assert update["step"] == 1 and update["score"] == 1.0
            result = request(
                base, "/tracker/result?tracker_id=" + tracker["tracker_id"])
            assert result["scores"] == [1.0] and result["final"] == 1.0
            request(base, "/tracker?tracker_id=" + tracker["tracker_id"],
                    method="DELETE")

            # With one trial per task every task is all-pass or all-fail, so
            # this exercises the exact official loader/report pipeline at zero
            # model cost.
            request(fake_base, "/reset", {})
            job = request(base, "/jobs", {"kind": "benchmark", "args": {
                "name": "terminal_bench_2.1", "n_trials": 1,
                "model": "custom-model-42", "max_workers": 2}})
            benchmark = wait_job(base, job["job_id"])
            assert benchmark["status"] == "done", benchmark
            assert benchmark["result"]["n_tasks"] == 89
            assert benchmark["result"]["n_runs"] == 1
            assert benchmark["result"]["model"] == "custom-model-42"
            assert benchmark["result"]["usage"]["calls"] == 0
            assert request(fake_base, "/metrics")["calls"] == 0

            print(json.dumps({
                "ok": True,
                "framework_commit": health["framework"]["commit"],
                "custom_model_seen": "custom-model-42",
                "compare_calls": comparison["usage"]["calls"],
                "select_calls_first_run": selected["usage"]["calls"],
                "select_calls_cached_run": cached["usage"]["calls"],
                "direct_wrapper_equivalent": True,
                "track_final": tracked["final"],
                "benchmark": {
                    "name": benchmark["result"]["benchmark"],
                    "tasks_loaded": benchmark["result"]["n_tasks"],
                    "model_calls": benchmark["result"]["usage"]["calls"],
                },
            }, indent=2))
        finally:
            stop(sidecar_process)
            stop(fake_process)


if __name__ == "__main__":
    main()
