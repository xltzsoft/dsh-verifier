#!/usr/bin/env python3
"""verifier sidecar — the full LLM-as-a-Verifier framework behind a JSON API.

The DSH plugin (dsh-verifier) is a faithful shell around the unmodified
`llm-verifier` package: this process imports the real framework
(fine-grained logprob reward, Probabilistic Pivot Tournament, prefix-cache
warming, progress tracking, benchmark runners) and exposes every public
entry point over a loopback HTTP API, so the agent tools and the web GUI
drive the exact same code the `pip install llm-verifier` CLI would.

Stdlib only (the venv already carries the framework's own dependencies).

Usage:
    python sidecar.py --root <plugin assets dir> [--port 0]

Prints one ready-line on stdout:  {"ready": true, "port": <port>}
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ASSET_ROOT = os.path.abspath(os.curdir)
DSH_HOME = os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh"))
CONFIG_FILE = os.path.join(DSH_HOME, "verifier.json")
STATE_ROOT = os.path.join(DSH_HOME, "verifier")
FRAMEWORK_VERSION = "0.2.0"
FRAMEWORK_COMMIT = "8db8a114355a9d7fdf9a8d1d5c87f6aeebd18770"
REPO_URL = "https://github.com/llm-as-a-verifier/llm-as-a-verifier.git"

DEFAULTS = {
    "backend": "auto",        # auto | deepseek | openai | vertex
    "model": "",              # "" = backend default
    "effort": "high",         # DEEPSEEK_EFFORT: off|low|high|max
    "maxTokens": 32768,       # DEEPSEEK_MAX_TOKENS
    "openaiBaseURL": "",
    "openaiApiKey": "",
    "deepseekApiKey": "",
    "vertexApiKey": "",
    "dataDir": "",            # framework checkout with data/ ("" = <STATE_ROOT>/data)
    "announceToAgent": True,
    "enabled": True,
    # Read/preserved for config parity with the Node transport-layer pipeline.
    # Candidate generation itself stays in DSH so it can reuse any registered
    # DSH provider/model route without copying credentials into Python.
    "agent": {
        "enabled": True,
        "numCandidates": 3,
        "temperature": 1,
        "models": [],
        "majorityVoting": True,
        "pivots": 2,
        "nVerifications": 1,
        "seed": 0,
        "note": "There is no reference solution available. Judge each trajectory purely on how plausibly it solved the task correctly.",
        "criteria": {
            "Task Success": "How likely the agent correctly and completely solved the task. The strongest signal is the agent verifying its solution against the task specific requirements. Trajectory length, number of steps, and apparent confidence do not predict correctness."
        },
        "verifierModel": "",
        "maxWorkers": None,
        "progressMonitor": {"enabled": True, "nVerifications": 1, "model": ""},
        "context": {"enabled": False, "model": None, "prompt": ""},
    },
}

# ---------------------------------------------------------------------------
# Config + credentials
# ---------------------------------------------------------------------------

def _read_yaml_scalar_keys(path):
    """Parse flat `KEY: value` pairs from dsh's credentials file."""
    out = {}
    if not os.path.isfile(path):
        return out
    try:
        for line in open(path):
            line = line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            k, v = line.split(":", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def load_config():
    cfg = dict(DEFAULTS)
    if os.path.isfile(CONFIG_FILE):
        try:
            with open(CONFIG_FILE) as f:
                stored = json.load(f)
            for k in DEFAULTS:
                if k in stored and stored[k] is not None:
                    cfg[k] = stored[k]
        except (OSError, ValueError):
            pass
    return cfg


def save_config(patch):
    cfg = load_config()
    for k, v in patch.items():
        if k in DEFAULTS and v is not None:
            cfg[k] = v
    os.makedirs(STATE_ROOT, exist_ok=True)
    tmp = CONFIG_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CONFIG_FILE)
    try:
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        pass
    return cfg


ENV_KEYS = ("OPENAI_BASE_URL", "OPENAI_API_KEY",
            "DEEPSEEK_API_KEY", "VERTEX_API_KEY")

# The process environment at sidecar start: the only pristine source the
# per-call resolution may read (so a call never observes its own writes).
PRISTINE_ENV = {k: os.environ.get(k) for k in ENV_KEYS}


def resolve_backend(cfg):
    """Decide the backend path and materialize the env the framework reads.

    Resolution per backend: explicit config value -> process env at start ->
    ~/.dsh/.credentials.yaml. Returns (backend_name, info_dict).

    The framework's create_client() checks OPENAI_BASE_URL first, then
    DEEPSEEK_API_KEY, then VERTEX_API_KEY; env vars are written from the
    start-time snapshot (PRISTINE_ENV) so a re-resolve can never read its
    own earlier writes.
    """
    creds = _read_yaml_scalar_keys(os.path.join(DSH_HOME, ".credentials.yaml"))

    def value(config_key, env_key):
        return ((cfg.get(config_key) or "")
                or (PRISTINE_ENV.get(env_key) or "")
                or creds.get(env_key, ""))

    def source(config_key, env_key):
        if cfg.get(config_key):
            return "config"
        if PRISTINE_ENV.get(env_key):
            return "env"
        if creds.get(env_key):
            return "credentials"
        return "none"

    deepseek_key = value("deepseekApiKey", "DEEPSEEK_API_KEY")
    vertex_key = value("vertexApiKey", "VERTEX_API_KEY")
    base_url = value("openaiBaseURL", "OPENAI_BASE_URL")
    openai_key = value("openaiApiKey", "OPENAI_API_KEY")
    deepseek_src = source("deepseekApiKey", "DEEPSEEK_API_KEY")
    vertex_src = source("vertexApiKey", "VERTEX_API_KEY")
    openai_src = source("openaiApiKey", "OPENAI_API_KEY")

    backend = cfg.get("backend", "auto")
    if backend == "auto":
        if base_url:
            backend = "openai"
        elif deepseek_key:
            backend = "deepseek"
        elif vertex_key:
            backend = "vertex"
        else:
            backend = "none"

    # Clear every provider selector, then expose only the chosen backend.
    # Keeping an unrelated pristine key here would make create_client() choose
    # a different backend than this function reports.
    for k in ENV_KEYS:
        os.environ.pop(k, None)
    if backend == "deepseek" and deepseek_key:
        os.environ["DEEPSEEK_API_KEY"] = deepseek_key
    elif backend == "vertex" and vertex_key:
        os.environ["VERTEX_API_KEY"] = vertex_key
    elif backend == "openai" and base_url:
        os.environ["OPENAI_BASE_URL"] = base_url
        os.environ["OPENAI_API_KEY"] = openai_key or "EMPTY"

    os.environ["DEEPSEEK_EFFORT"] = str(cfg.get("effort", "high"))
    os.environ["DEEPSEEK_MAX_TOKENS"] = str(cfg.get("maxTokens", 32768))

    default_model = ("deepseek-v4-flash" if backend == "deepseek"
                     else ("gemini-2.5-flash" if backend == "vertex"
                           else "server-default"))
    ready = ((backend == "deepseek" and bool(deepseek_key))
             or (backend == "vertex" and bool(vertex_key))
             or (backend == "openai" and bool(base_url)))
    info = {
        "backend": backend,
        "model": cfg.get("model") or default_model,
        "modelSource": "config" if cfg.get("model") else "backend-default",
        "effort": cfg.get("effort", "high"),
        "maxTokens": int(cfg.get("maxTokens", 32768)),
        "baseURL": base_url if backend == "openai" else "",
        "deepseekKeySource": deepseek_src,
        "vertexKeySource": vertex_src,
        "openaiKeySource": openai_src,
        "logprobs": "required — the fine-grained reward reads score-token logprob distributions",
        "ready": ready,
    }
    if backend == "deepseek":
        info["host"] = "https://api.deepseek.com"
    return backend, info


def mask(value, keep=4):
    if not value:
        return ""
    value = str(value)
    if len(value) <= keep:
        return "*" * len(value)
    return value[:2] + "*" * (len(value) - keep - 2) + value[-keep:]


def public_config(cfg=None):
    cfg = cfg or load_config()
    out = {}
    for k, v in cfg.items():
        if k.endswith("ApiKey") or k == "openaiApiKey":
            out[k] = mask(v) if v else ""
        else:
            out[k] = v
    return out

# ---------------------------------------------------------------------------
# Framework imports (after the asset root is fixed, so criteria/ resolves)
# ---------------------------------------------------------------------------

import llm_verifier  # noqa: E402
from llm_verifier import (  # noqa: E402
    ProgressTracker,
    MissingAPIKeyError,
    compare as fw_compare,
    select as fw_select,
    track as fw_track,
)
from llm_verifier.benchmarks import BENCHMARKS  # noqa: E402
from llm_verifier.fine_grained_reward import (  # noqa: E402
    USAGE,
    LazyClient,
    default_max_workers,
    directed_reward,
    format_usage,
    score_directed_pairs,
)
from llm_verifier import pivot_tournament as ppt  # noqa: E402
from llm_verifier.loaders import LOADERS  # noqa: E402
from llm_verifier.prompts import load_prompts, select_criteria  # noqa: E402


def framework_identity():
    """Installed distribution identity, including the pinned VCS commit."""
    import importlib.metadata as metadata
    dist = metadata.distribution("llm-verifier")
    try:
        direct = json.loads(dist.read_text("direct_url.json") or "{}")
    except (TypeError, ValueError):
        direct = {}
    return {
        "version": dist.version,
        "commit": direct.get("vcs_info", {}).get("commit_id"),
        "requiredVersion": FRAMEWORK_VERSION,
        "requiredCommit": FRAMEWORK_COMMIT,
    }

def criteria_dir():
    return os.path.join(ASSET_ROOT, "criteria")


def criteria_names():
    d = criteria_dir()
    if not os.path.isdir(d):
        return []
    return sorted(f[:-3] for f in os.listdir(d)
                  if f.endswith(".md") and f != "TEMPLATE.md")


def data_root():
    cfg = load_config()
    d = cfg.get("dataDir") or os.path.join(STATE_ROOT, "data")
    return os.path.abspath(d)


def _abs(root, path):
    return path if os.path.isabs(path) else os.path.join(root, path)

# ---------------------------------------------------------------------------
# Jobs — long operations run in worker threads and are polled by id
# ---------------------------------------------------------------------------

JOBS = {}
JOBS_LOCK = threading.Lock()


class Job:
    def __init__(self, jtype, payload):
        self.id = uuid.uuid4().hex[:12]
        self.type = jtype
        self.payload = payload
        self.status = "queued"
        self.created = time.time()
        self.started = None
        self.finished = None
        self.result = None
        self.error = None
        self.progress = {}
        self._cancel = threading.Event()
        self.usage_before = USAGE.copy()

    def snapshot(self):
        return {
            "id": self.id, "type": self.type, "status": self.status,
            "created": self.created, "started": self.started,
            "finished": self.finished, "progress": self.progress,
            "result": self.result, "error": self.error,
            "usage": (USAGE - self.usage_before).snapshot(),
        }

    def cancel(self):
        self._cancel.set()


def new_job(jtype, payload):
    job = Job(jtype, payload)
    with JOBS_LOCK:
        JOBS[job.id] = job
        for k, v in list(JOBS.items()):
            if v.status in ("done", "error", "canceled") and \
               (time.time() - (v.finished or time.time())) > 3600:
                del JOBS[k]
    return job


def job_done(job, result):
    job.status = "done" if not job._cancel.is_set() else "canceled"
    job.result = result
    job.finished = time.time()


def job_error(job, exc):
    job.status = "canceled" if job._cancel.is_set() else "error"
    job.error = f"{type(exc).__name__}: {exc}"
    job.finished = time.time()


def run_job(job, fn, progress=None):
    def wrap():
        job.status = "running"
        job.started = time.time()
        try:
            if progress:
                job.progress = progress
            result = fn()
            job_done(job, result)
        except Exception as e:  # noqa: BLE001
            job_error(job, e)
            job.progress["detail"] = traceback.format_exc(limit=8)
    threading.Thread(target=wrap, daemon=True).start()
    return job


def start_job(jtype, payload, fn):
    job = new_job(jtype, payload)
    run_job(job, fn)
    return job

# ---------------------------------------------------------------------------
# Scoring endpoints
# ---------------------------------------------------------------------------

def _images_arg(images):
    """JSON images (paths / URLs / base64) -> framework ImagesArg."""
    if not images:
        return None
    if isinstance(images, (str, dict)):
        images = [images]
    if not isinstance(images, list):
        raise ValueError("images must be one image or a list of images")
    out = []
    for img in images:
        if isinstance(img, str):
            out.append(img)
        elif isinstance(img, dict):
            if "base64" in img:
                out.append(base64.b64decode(img["base64"]))
            elif "path" in img:
                out.append(img["path"])
            elif "url" in img:
                out.append(img["url"])
            else:
                raise ValueError("image entry needs path|url|base64")
        else:
            raise ValueError("images must be strings or {path|url|base64}")
    return out or None


def usage_delta(before):
    return (USAGE - before).snapshot()


def _model_kwargs(payload):
    """Per-call model, else the configured default; omitted when both unset
    so the framework's backend default applies (passing None would
    override it)."""
    m = payload.get("model") or load_config().get("model") or ""
    return {"model": m} if m else {}


def do_compare(payload):
    resolve_backend(load_config())
    before = USAGE.copy()
    ra, rb = fw_compare(
        payload["problem"],
        payload["candidate_a"],
        payload["candidate_b"],
        criteria=payload.get("criteria") or {"Overall": "Does the solution fully satisfy the task?"},
        images=_images_arg(payload.get("images")),
        ground_truth_note=payload.get("ground_truth_note") or None,
        n_evaluations=int(payload.get("n_evaluations", 1)),
        max_workers=payload.get("max_workers"),
        **_model_kwargs(payload),
    )
    import math
    p_win = 1.0 / (1.0 + math.exp(-(ra - rb)))
    return {
        "reward_a": ra, "reward_b": rb,
        "winner": "a" if ra > rb else ("b" if rb > ra else "tie"),
        "p_a_wins": p_win,
        "usage": usage_delta(before),
    }


def do_select(payload):
    resolve_backend(load_config())
    before = USAGE.copy()
    result = fw_select(
        payload["problem"],
        list(payload["candidates"]),
        criteria=payload.get("criteria") or {
            "Overall": "Does the candidate fully and correctly satisfy the task?"
        },
        images=_images_arg(payload.get("images")),
        ground_truth_note=payload.get("ground_truth_note") or None,
        n_evaluations=int(payload.get("n_evaluations", 4)),
        pivots=int(payload.get("pivots", 2)),
        seed=int(payload.get("seed", 0)),
        max_workers=payload.get("max_workers"),
        **_model_kwargs(payload),
        cache=payload.get("cache"),
        progress=False,
        on_error=payload.get("on_error", "tie"),
    )
    return {
        "index": result.index,
        "scores": result.scores,
        "ranking": result.ranking,
        "n_comparisons": result.n_comparisons,
        "criteria": result.criteria,
        "usage": usage_delta(before),
    }


def do_track(payload):
    resolve_backend(load_config())
    before = USAGE.copy()
    result = fw_track(
        payload["problem"],
        list(payload["steps"]),
        images=_images_arg(payload.get("images")),
        checkpoint_steps=payload.get("checkpoint_steps"),
        n_evaluations=int(payload.get("n_evaluations", 1)),
        max_workers=payload.get("max_workers"),
        **_model_kwargs(payload),
    )
    return {
        "steps": result.steps,
        "scores": result.scores,
        "per_rep_scores": result.per_rep_scores,
        "final": result.final,
        "usage": usage_delta(before),
    }

# ---------------------------------------------------------------------------
# Online progress trackers (ProgressTracker instances)
# ---------------------------------------------------------------------------

TRACKERS = {}
TRACKERS_LOCK = threading.Lock()


def do_tracker_start(payload):
    resolve_backend(load_config())
    tracker = ProgressTracker(
        payload["problem"],
        images=_images_arg(payload.get("images")),
        n_evaluations=int(payload.get("n_evaluations", 1)),
        max_workers=payload.get("max_workers"),
        **_model_kwargs(payload),
    )
    tid = uuid.uuid4().hex[:12]
    with TRACKERS_LOCK:
        TRACKERS[tid] = tracker
    return {"tracker_id": tid}


def do_tracker_update(payload):
    tid = payload["tracker_id"]
    with TRACKERS_LOCK:
        tracker = TRACKERS.get(tid)
    if tracker is None:
        raise KeyError(f"unknown tracker {tid!r}")
    before = USAGE.copy()
    score = tracker.update(payload.get("step", ""),
                           images=_images_arg(payload.get("images")))
    return {
        "step": tracker.steps[-1],
        "score": score,
        "curve": list(zip(tracker.steps, tracker.scores)),
        "usage": usage_delta(before),
    }


def do_tracker_result(payload):
    tid = payload.get("tracker_id")
    with TRACKERS_LOCK:
        tracker = TRACKERS.get(tid)
    if tracker is None:
        raise KeyError(f"unknown tracker {tid!r}")
    result = tracker.result()
    return {
        "steps": result.steps,
        "scores": result.scores,
        "per_rep_scores": result.per_rep_scores,
        "final": result.final,
    }

# ---------------------------------------------------------------------------
# Benchmark runs (scripts/run.py logic, data paths re-rooted)
# ---------------------------------------------------------------------------

PRESETS = {
    # label: (n_trials, pivots, n_evaluations, cache_suffix)
    "full": (None, None, None, ""),
    "bo3": (3, 1, 2, "_bo3"),
    "bo5": (5, 1, 2, "_bo5"),
}


def classify(tasks):
    all_pass, swing = [], []
    for name, trials in sorted(tasks.items()):
        rewards = [t["reward"] for t in trials]
        if all(r == 1 for r in rewards):
            all_pass.append(name)
        elif not all(r == 0 for r in rewards):
            swing.append(name)
    return all_pass, swing


def benchmark_data_status(cfg):
    root = data_root()
    checkout_commit = None
    if os.path.isdir(os.path.join(root, ".git")):
        try:
            checkout_commit = subprocess.check_output(
                ["git", "-C", root, "rev-parse", "HEAD"], text=True,
                stderr=subprocess.DEVNULL).strip()
        except (OSError, subprocess.CalledProcessError):
            pass
    return {
        "dataDir": root,
        "present": os.path.isdir(root),
        "hasData": os.path.isdir(os.path.join(root, "data")),
        "checkoutCommit": checkout_commit,
        "requiredCommit": FRAMEWORK_COMMIT,
        "exactCheckout": checkout_commit == FRAMEWORK_COMMIT,
        "benchmarks": [
            {
                "name": name,
                "title": cfg.name,
                "loader": cfg.loader,
                "criteria": cfg.criteria,
                "nEvaluations": cfg.n_evaluations,
                "pivots": cfg.pivots,
                "dataPath": cfg.data,
                "dataPresent": os.path.exists(_abs(root, next(iter(cfg.data.values())))
                                       if cfg.data else ""),
            }
            for name, cfg in BENCHMARKS.items()
        ],
    }


def _cache_count(cache_file):
    try:
        with open(cache_file) as f:
            return len(json.load(f))
    except (OSError, ValueError):
        return 0


def do_benchmark(payload, progress=None):
    """Full scripts/run.py pipeline for one benchmark (threaded).

    `progress` is a shared dict the GUI polls (updated in place)."""
    if progress is None:
        progress = {}
    resolve_backend(load_config())
    root = data_root()
    if not os.path.isdir(os.path.join(root, "data")):
        raise FileNotFoundError(
            f"benchmark data not found under {root}/data — download it from "
            "the GUI (Data tab) or set dataDir to a framework checkout")

    name = payload["name"]
    if name not in BENCHMARKS:
        raise ValueError(
            f"unknown benchmark {name!r}; choose one of {', '.join(BENCHMARKS)}")
    cfg = BENCHMARKS[name]
    preset = PRESETS.get(payload.get("preset", "full"), PRESETS["full"])
    p_trials, p_pivots, p_n_eval, p_suffix = preset
    n_trials = payload.get("n_trials", p_trials)
    k = payload.get("pivots", p_pivots if p_pivots is not None else cfg.pivots)
    n_reps = payload.get("n_evaluations", p_n_eval if p_n_eval is not None else cfg.n_evaluations)
    seed = payload.get("seed", cfg.seed)
    max_workers = payload.get("max_workers")
    if max_workers is None:
        max_workers = cfg.max_workers if cfg.max_workers is not None else default_max_workers()

    note, all_criteria = load_prompts(cfg.prompts)
    criteria = select_criteria(all_criteria, cfg.criteria)
    criteria_ids = [c["id"] for c in criteria]

    progress.update({"phase": "loading", "done": 0, "total": None,
                     "benchmark": name})

    tasks, n_runs = LOADERS[cfg.loader](cfg.data, root)
    if n_trials:
        tasks = {tn: trials[:n_trials] for tn, trials in tasks.items()}
        n_runs = min(n_runs, n_trials)
    all_pass, swing = classify(tasks)
    n_tasks = len(tasks)

    cache_base, cache_ext = os.path.splitext(os.path.basename(cfg.cache))
    cache_file = os.path.join(STATE_ROOT, "cache",
                              cache_base + p_suffix + (cache_ext or ".json"))
    os.makedirs(os.path.dirname(cache_file), exist_ok=True)
    result_base, result_ext = os.path.splitext(os.path.basename(cfg.results))
    results_file = os.path.join(
        STATE_ROOT, "results", result_base + p_suffix + (result_ext or ".txt"))
    os.makedirs(os.path.dirname(results_file), exist_ok=True)

    # Cache entries expected at completion: every (criterion, task, pair,
    # rep) the two phases will score.
    def expected_entries(pair_counts):
        base = _cache_count(cache_file)
        return base + int(sum(pair_counts.values())
                          * len(criteria) * n_reps)

    lazy = LazyClient()
    usage_before = USAGE.copy()
    scoring_options = {
        "progress": False,
        "on_error": payload.get("on_error", "tie"),
        **_model_kwargs(payload),
    }
    import random
    rng = random.Random(seed)
    rings = {tn: ppt.ring_cycle(len(tasks[tn]), rng) for tn in swing}
    ring_counts = {tn: len(rings[tn]) for tn in swing}
    progress["total"] = expected_entries(ring_counts)
    progress.update({"tasks": len(swing), "swing": len(swing),
                     "all_pass": len(all_pass)})

    # Ticker: score_directed_pairs has no progress callback, so poll the
    # on-disk score cache (one entry per scored criterion/rep of a pair).
    ticker_stop = threading.Event()

    def ticker():
        while not ticker_stop.wait(2):
            try:
                progress["done"] = _cache_count(cache_file)
            except Exception:
                pass

    ticker_thread = threading.Thread(target=ticker, daemon=True)
    ticker_thread.start()

    def score_fn(scores):
        def directed(a, b, t):
            return directed_reward(scores, t, a, b, criteria_ids, n_reps)
        return directed

    progress["phase"] = "ring-pass"
    scores = score_directed_pairs(
        lazy, tasks, rings, criteria, note, n_reps, int(max_workers),
        cache_file, **scoring_options)
    directed = score_fn(scores)

    pivots_by_task, pr_pairs = {}, {}
    for tn in swing:
        n = len(tasks[tn])
        w, c = [0.0] * n, [0] * n
        ppt.accumulate(rings[tn], lambda a, b, t=tn: directed(a, b, t), w, c)
        pivots = ppt.select_pivots(w, c, int(k))
        pivots_by_task[tn] = pivots
        pr_pairs[tn] = ppt.pivot_round_pairs(n, pivots)
    progress["total"] = expected_entries(
        {tn: len(rings[tn]) + len(pr_pairs[tn]) for tn in swing})

    progress["phase"] = "pivot-rounds"
    scores = score_directed_pairs(
        lazy, tasks, pr_pairs, criteria, note, n_reps, int(max_workers),
        cache_file, **scoring_options)
    directed = score_fn(scores)

    selected = 0
    total_comparisons = 0
    per_task = []
    for i, tn in enumerate(sorted(swing)):
        n = len(tasks[tn])
        w, c = [0.0] * n, [0] * n
        ppt.accumulate(rings[tn], lambda a, b, t=tn: directed(a, b, t), w, c)
        ppt.accumulate(pr_pairs[tn], lambda a, b, t=tn: directed(a, b, t), w, c)
        best = max(range(n), key=lambda i: (w[i] / c[i] if c[i] else 0.0, -i))
        mean_pref = [w[i] / c[i] if c[i] else 0.0 for i in range(n)]
        total_comparisons += len(rings[tn]) + len(pr_pairs[tn])
        hit = tasks[tn][best]["reward"] == 1
        if hit:
            selected += 1
        per_task.append({
            "task": tn, "n_trials": n, "best": best,
            "winner_trial": tasks[tn][best]["trial_name"],
            "hit": bool(hit),
            "mean_preference": [round(v, 4) for v in mean_pref],
            "pivots": pivots_by_task[tn],
        })
        progress["done"] = _cache_count(cache_file)
        progress["phase"] = f"aggregating {i + 1}/{len(swing)}"
    ticker_stop.set()
    ticker_thread.join(timeout=3)
    progress["phase"] = "report"

    pass1 = len(all_pass) + sum(
        sum(t["reward"] for t in tasks[tn]) / len(tasks[tn]) for tn in swing)
    verifier = len(all_pass) + selected
    oracle = len(all_pass) + len(swing)
    avg_cmp = total_comparisons / max(1, len(swing))
    usage = USAGE - usage_before

    from llm_verifier.fine_grained_reward import GRANULARITY
    model = payload.get("model") or load_config().get("model") or "backend-default"

    def rate(value):
        return (100 * value / n_tasks) if n_tasks else 0.0

    lines = [
        "", "=" * 72, cfg.name,
        f"  g{GRANULARITY}  criteria={criteria_ids}  K={n_reps}  "
        f"pivots={k}  seed={seed}  model={model}",
        f"  tasks={n_tasks}  swing={len(swing)}  N(trials)={n_runs}  "
        f"comparisons/task={avg_cmp:.1f}", "=" * 72,
        f"{'Method':<26s}  {'Score':>14s}  {'Rate':>7s}", "-" * 72,
        f"{'Pass@1':<26s}  {pass1:>8.2f}/{n_tasks}  {rate(pass1):>6.1f}%",
        f"{'LLM-as-a-Verifier':<26s}  {verifier:>8d}/{n_tasks}  "
        f"{rate(verifier):>6.1f}%",
        f"{'Oracle (Bo' + str(n_runs) + ')':<26s}  {oracle:>8d}/{n_tasks}  "
        f"{rate(oracle):>6.1f}%", "-" * 72,
        *format_usage(usage), "",
    ]
    with open(results_file, "w") as f:
        f.write("\n".join(lines))
    progress["phase"] = "done"
    return {
        "benchmark": name,
        "title": cfg.name,
        "model": model,
        "preset": payload.get("preset", "full"),
        "n_tasks": n_tasks, "n_runs": n_runs, "n_swing": len(swing),
        "pass1": {"count": round(pass1, 2), "rate": rate(pass1)},
        "verifier": {"count": verifier, "rate": rate(verifier)},
        "oracle": {"count": oracle, "rate": rate(oracle)},
        "avg_comparisons_per_task": round(avg_cmp, 2),
        "comparisons": total_comparisons,
        "per_task": per_task,
        "report": "\n".join(lines),
        "results_file": results_file,
        "usage": usage.snapshot(),
    }

# ---------------------------------------------------------------------------
# Data download (framework repo clone, first use)
# ---------------------------------------------------------------------------

def do_data_download(payload):
    root = data_root()
    status = benchmark_data_status(None)
    if status["hasData"] and status["exactCheckout"]:
        return {"status": "already-present", "dataDir": root,
                "commit": status["checkoutCommit"]}
    if os.path.exists(root):
        raise FileExistsError(
            f"{root} already exists but is not the pinned framework checkout "
            f"{FRAMEWORK_COMMIT}; move it aside or configure an empty dataDir")
    os.makedirs(STATE_ROOT, exist_ok=True)
    if shutil.which("git") is None:
        raise RuntimeError("git not found on PATH; clone the framework repo manually")
    job_dir = os.path.join(STATE_ROOT, "data-clone")
    os.makedirs(job_dir, exist_ok=True)
    log_file = os.path.join(job_dir, "clone.log")
    with open(log_file, "w") as log:
        commands = [
            ["git", "init", root],
            ["git", "-C", root, "remote", "add", "origin", REPO_URL],
            ["git", "-C", root, "fetch", "--depth", "1", "origin",
             FRAMEWORK_COMMIT],
            ["git", "-C", root, "checkout", "--detach", "FETCH_HEAD"],
        ]
        code = 0
        for command in commands:
            proc = subprocess.run(command, stdout=log,
                                  stderr=subprocess.STDOUT)
            code = proc.returncode
            if code != 0:
                break
    if code != 0:
        shutil.rmtree(root, ignore_errors=True)
        with open(log_file) as f:
            raise RuntimeError("git clone failed:\n" + f.read()[-2000:])
    return {"status": "ok", "dataDir": root, "commit": FRAMEWORK_COMMIT}

# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

ROUTES = {}


def route(method, path):
    def deco(fn):
        ROUTES[(method, path)] = fn
        return fn
    return deco


@route("GET", "/health")
def h_health(_payload):
    identity = framework_identity()
    return {"ok": True, "version": llm_verifier.__version__,
            "framework": identity,
            "python": sys.version.split()[0], "pid": os.getpid(),
            "uptime": time.time() - BOOT_TIME}


@route("GET", "/backend")
def h_backend(_payload):
    _backend, info = resolve_backend(load_config())
    info["maxWorkersDefault"] = default_max_workers()
    return info


@route("GET", "/config")
def h_config_get(_payload):
    return public_config()


@route("POST", "/config")
def h_config_set(payload):
    patch = {k: v for k, v in payload.items() if k in DEFAULTS}
    cfg = save_config(patch)
    _backend, info = resolve_backend(cfg)
    return {"config": public_config(cfg), "backend": info}


@route("GET", "/usage")
def h_usage(_payload):
    return USAGE.snapshot()


@route("POST", "/usage/reset")
def h_usage_reset(_payload):
    USAGE.reset()
    return USAGE.snapshot()


@route("GET", "/criteria/list")
def h_criteria_list(_payload):
    tmpl = os.path.join(criteria_dir(), "TEMPLATE.md")
    return {"criteria": criteria_names(),
            "template": tmpl if os.path.isfile(tmpl) else None}


@route("GET", "/criteria")
def h_criteria_preview(payload):
    # Bare bundled name (criteria/<name>.md under the asset root, resolved
    # via the process cwd) or a filesystem path to a criteria file.
    note, crits = load_prompts(payload.get("name") or "")
    return {"ground_truth_note": note, "criteria": crits}


@route("GET", "/benchmarks")
def h_benchmarks(_payload):
    return benchmark_data_status(None)


@route("POST", "/jobs")
def h_job_start(payload):
    kind = payload.get("kind")
    args = payload.get("args") or {}
    job = new_job(kind, args)
    if kind == "benchmark":
        run_job(job, lambda: do_benchmark(args, job.progress),
                progress=job.progress)
    elif kind == "data-download":
        run_job(job, lambda: do_data_download(args))
    elif kind in ("compare", "select", "track"):
        fn = {"compare": do_compare, "select": do_select,
              "track": do_track}[kind]
        run_job(job, lambda: fn(args))
    else:
        with JOBS_LOCK:
            JOBS.pop(job.id, None)
        raise KeyError(f"unknown job kind {kind!r}")
    return {"job_id": job.id}


@route("GET", "/jobs")
def h_jobs(_payload):
    with JOBS_LOCK:
        return {"jobs": [j.snapshot() for j in sorted(
            JOBS.values(), key=lambda j: j.created, reverse=True)]}


@route("GET", "/job")
def h_job_get(payload):
    with JOBS_LOCK:
        job = JOBS.get(payload.get("id") or "")
    if job is None:
        raise KeyError("unknown job id")
    return job.snapshot()


@route("POST", "/job/cancel")
def h_job_cancel(payload):
    with JOBS_LOCK:
        job = JOBS.get(payload.get("id") or "")
    if job is None:
        raise KeyError("unknown job id")
    job.cancel()
    return {"ok": True, "status": job.status}


@route("POST", "/compare")
def h_compare(payload):
    return do_compare(payload)


@route("POST", "/select")
def h_select(payload):
    return do_select(payload)


@route("POST", "/track")
def h_track(payload):
    return do_track(payload)


@route("POST", "/tracker/start")
def h_tracker_start(payload):
    return do_tracker_start(payload)


@route("POST", "/tracker/update")
def h_tracker_update(payload):
    return do_tracker_update(payload)


@route("GET", "/tracker/result")
def h_tracker_result(payload):
    return do_tracker_result(payload)


@route("DELETE", "/tracker")
def h_tracker_delete(payload):
    with TRACKERS_LOCK:
        tracker = TRACKERS.pop(payload.get("tracker_id") or "", None)
    if tracker is None:
        raise KeyError("unknown tracker id")
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "verifier-sidecar/2"

    def log_message(self, fmt, *args):  # keep stdout for the ready-line
        pass

    def _send(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _payload(self):
        if self.command in ("GET", "DELETE"):
            qs = {}
            if "?" in self.path:
                from urllib.parse import parse_qs
                raw = parse_qs(self.path.split("?", 1)[1])
                qs = {k: (v[0] if len(v) == 1 else v) for k, v in raw.items()}
            return qs
        length = int(self.headers.get("content-length") or 0)
        if length > 256 * 1024 * 1024:
            raise ValueError("request body too large (256 MB cap)")
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _handle(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        key = (self.command, path)
        fn = ROUTES.get(key)
        try:
            if fn is None:
                raise KeyError(f"no route {self.command} {path}")
            payload = self._payload()
            self._send(200, fn(payload))
        except KeyError as e:
            self._send(404, {"error": str(e)})
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except MissingAPIKeyError as e:
            self._send(503, {"error": f"no verifier backend configured: {e}"})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"{type(e).__name__}: {e}",
                             "trace": traceback.format_exc(limit=10)})

    do_GET = _handle
    do_POST = _handle
    do_DELETE = _handle


BOOT_TIME = time.time()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=os.path.abspath(os.curdir),
                        help="plugin assets dir (criteria/ lives here)")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    identity = framework_identity()
    if identity["version"] != FRAMEWORK_VERSION \
            or identity["commit"] != FRAMEWORK_COMMIT:
        raise RuntimeError(
            "llm-verifier identity mismatch: installed "
            f"{identity['version']} ({identity['commit']}), required "
            f"{FRAMEWORK_VERSION} ({FRAMEWORK_COMMIT})")

    root = os.path.abspath(args.root)
    os.chdir(root)  # criteria/ resolution
    global ASSET_ROOT
    ASSET_ROOT = root
    os.makedirs(os.path.join(STATE_ROOT, "cache"), exist_ok=True)
    os.makedirs(os.path.join(STATE_ROOT, "results"), exist_ok=True)

    # Warm the import-time config so /health is meaningful immediately.
    _backend, _info = resolve_backend(load_config())

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(json.dumps({"ready": True, "port": server.server_address[1],
                      "pid": os.getpid(),
                      "framework": llm_verifier.__version__,
                      "framework_commit": FRAMEWORK_COMMIT}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
