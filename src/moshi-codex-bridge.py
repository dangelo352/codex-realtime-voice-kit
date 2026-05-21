#!/usr/bin/env python3
import argparse
import asyncio
import base64
import json
import multiprocessing
import os
import queue
import sys
import time
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web
import huggingface_hub
import mlx.core as mx
import mlx.nn as nn
import numpy as np
import rustymimi
import sentencepiece

from moshi_mlx import models, utils

SAMPLE_RATE = 24000
FRAME_SIZE = 1920


def log(level: str, message: str) -> None:
    print(f"{level.upper()}: {message}", flush=True)


def hf_hub_download(repo: str | None, path: str) -> str:
    if not repo:
        raise ValueError(f"the --hf-repo flag is required to retrieve {path}")
    return huggingface_hub.hf_hub_download(repo, path)


def hf_get(filename: str) -> str:
    if filename.startswith("hf://"):
        parts = filename[5:].split("/")
        repo_name = parts[0] + "/" + parts[1]
        filename = "/".join(parts[2:])
        log("info", f"retrieving {filename} from hf repo {repo_name}")
        return hf_hub_download(repo_name, filename)
    return filename


def pcm16_to_float32(pcm: bytes) -> np.ndarray:
    if not pcm:
        return np.zeros((0,), dtype=np.float32)
    int_data = np.frombuffer(pcm, dtype="<i2")
    return (int_data.astype(np.float32) / 32768.0).clip(-1.0, 1.0)


def float32_to_pcm16_base64(data: np.ndarray) -> str:
    data = np.asarray(data, dtype=np.float32).reshape(-1)
    pcm = (data.clip(-1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    return base64.b64encode(pcm).decode("ascii")


def full_warmup(audio_tokenizer: Any, client_to_server: Any, server_to_client: Any, max_delay: int) -> None:
    for i in range(4):
        pcm_data = np.array([0.0] * FRAME_SIZE).astype(np.float32)
        audio_tokenizer.encode(pcm_data)
        while True:
            time.sleep(0.01)
            data = audio_tokenizer.get_encoded()
            if data is not None:
                break
        client_to_server.put_nowait(data)
        if i < max_delay:
            continue
        while True:
            kind, data = server_to_client.get()
            if kind == 0:
                audio_tokenizer.decode(data)
                break
        while True:
            time.sleep(0.01)
            data = audio_tokenizer.get_decoded()
            if data is not None:
                break


def model_server(client_to_server: Any, server_to_client: Any, lm_config: Any, args: Any) -> None:
    model_file = args.moshi_weight
    tokenizer_file = args.tokenizer
    if model_file is None:
        if isinstance(lm_config, dict) and "moshi_name" in lm_config:
            model_file = hf_hub_download(args.hf_repo, lm_config["moshi_name"])
        elif args.quantized == 8:
            model_file = hf_hub_download(args.hf_repo, "model.q8.safetensors")
        elif args.quantized == 4:
            model_file = hf_hub_download(args.hf_repo, "model.q4.safetensors")
        elif args.quantized is not None:
            raise ValueError(f"Invalid quantized value: {args.quantized}")
        else:
            model_file = hf_hub_download(args.hf_repo, "model.safetensors")
    if tokenizer_file is None:
        if isinstance(lm_config, dict) and "tokenizer_name" in lm_config:
            tokenizer_file = hf_hub_download(args.hf_repo, lm_config["tokenizer_name"])
        else:
            tokenizer_file = hf_hub_download(args.hf_repo, "tokenizer_spm_32k_3.model")
    tokenizer_file = hf_get(tokenizer_file)
    model_file = hf_get(model_file)

    log("info", f"[MOSHI] loading text tokenizer {tokenizer_file}")
    text_tokenizer = sentencepiece.SentencePieceProcessor(tokenizer_file)  # type: ignore
    mx.random.seed(299792458)
    if isinstance(lm_config, dict):
        lm_config = models.LmConfig.from_config_dict(lm_config)
    model = models.Lm(lm_config)
    model.set_dtype(mx.bfloat16)
    if args.quantized is not None:
        group_size = 32 if args.quantized == 4 else 64
        nn.quantize(model, bits=args.quantized, group_size=group_size)

    log("info", f"[MOSHI] loading weights {model_file}")
    model.load_weights(model_file, strict=True)
    log("info", "[MOSHI] weights loaded")

    if model.condition_provider is not None:
        ct = model.condition_provider.condition_tensor("description", "very_good")
    else:
        ct = None

    log("info", "[MOSHI] warming up model")
    model.warmup(ct)
    log("info", "[MOSHI] model warmed up")
    gen = models.LmGen(
        model=model,
        max_steps=args.steps + 5,
        text_sampler=utils.Sampler(),
        audio_sampler=utils.Sampler(),
        check=False,
    )

    server_to_client.put("start")
    log("info", "[MOSHI] connected")
    while True:
        data = client_to_server.get()
        data = mx.array(data).transpose(1, 0)[:, : gen.main_codebooks]
        text_token = gen.step(data, ct=ct)
        text_token = text_token[0].item()
        audio_tokens = gen.last_audio_tokens()
        if text_token not in (0, 3):
            text = text_tokenizer.id_to_piece(text_token)  # type: ignore
            text = text.replace("▁", " ")
            server_to_client.put_nowait((1, text))
        if audio_tokens is not None:
            audio_tokens = np.array(audio_tokens).astype(np.uint32)
            server_to_client.put_nowait((0, audio_tokens))


async def bridge_server(client_to_server: Any, server_to_client: Any, lm_config: Any, args: Any) -> None:
    mimi_file = args.mimi_weight
    if mimi_file is None:
        if isinstance(lm_config, dict) and "mimi_name" in lm_config:
            mimi_file = hf_hub_download(args.hf_repo, lm_config["mimi_name"])
        else:
            mimi_file = hf_hub_download(
                args.hf_repo, "tokenizer-e351c8d8-checkpoint125.safetensors"
            )
    mimi_file = hf_get(mimi_file)

    input_queue: queue.Queue[np.ndarray] = queue.Queue()
    output_queue: queue.Queue[np.ndarray] = queue.Queue()
    text_queue: queue.Queue[str] = queue.Queue()
    if isinstance(lm_config, dict):
        num_codebooks = lm_config.get("dep_q", 8)
        max_delay = max(lm_config["delays"])
    else:
        num_codebooks = lm_config.depformer.num_slices
        max_delay = max(lm_config.audio_delays)
    audio_tokenizer = rustymimi.StreamTokenizer(mimi_file, num_codebooks=num_codebooks)  # type: ignore
    start = server_to_client.get()
    log("info", f"[BRIDGE] received '{start}' from model process")

    full_warmup(audio_tokenizer, client_to_server, server_to_client, max_delay)

    async def encode_input_loop() -> None:
        while True:
            try:
                pcm_data = input_queue.get(block=False)
                audio_tokenizer.encode(pcm_data)
            except queue.Empty:
                await asyncio.sleep(0.001)

    async def decoded_output_loop() -> None:
        while True:
            data = audio_tokenizer.get_decoded()
            if data is None:
                await asyncio.sleep(0.001)
                continue
            output_queue.put_nowait(data)

    async def encoded_input_loop() -> None:
        while True:
            data = audio_tokenizer.get_encoded()
            if data is None:
                await asyncio.sleep(0.001)
                continue
            client_to_server.put_nowait(data)

    async def model_output_loop() -> None:
        while True:
            try:
                kind, data = server_to_client.get(block=False)
                if kind == 0:
                    audio_tokenizer.decode(data)
                elif kind == 1:
                    text_queue.put_nowait(data)
            except queue.Empty:
                await asyncio.sleep(0.001)

    async def health(_request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "service": "moshi-codex-bridge"})

    async def handle_ws(request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({"type": "ready", "sample_rate": SAMPLE_RATE, "frame_size": FRAME_SIZE})
        close = False
        pending_pcm = np.zeros((0,), dtype=np.float32)

        async def recv_loop() -> None:
            nonlocal close, pending_pcm
            try:
                async for message in ws:
                    if message.type == aiohttp.WSMsgType.ERROR:
                        log("error", f"websocket error: {ws.exception()}")
                        break
                    if message.type == aiohttp.WSMsgType.CLOSED:
                        break
                    if message.type != aiohttp.WSMsgType.TEXT:
                        continue
                    try:
                        payload = json.loads(message.data)
                    except json.JSONDecodeError:
                        continue
                    if payload.get("type") == "audio":
                        pcm = base64.b64decode(payload.get("data", ""))
                        float_pcm = pcm16_to_float32(pcm)
                        if pending_pcm.size:
                            pending_pcm = np.concatenate((pending_pcm, float_pcm))
                        else:
                            pending_pcm = float_pcm
                        while pending_pcm.shape[-1] >= FRAME_SIZE:
                            frame = pending_pcm[:FRAME_SIZE]
                            pending_pcm = pending_pcm[FRAME_SIZE:]
                            input_queue.put_nowait(frame.astype(np.float32))
                    elif payload.get("type") == "reset":
                        pending_pcm = np.zeros((0,), dtype=np.float32)
            finally:
                close = True
                log("info", "[BRIDGE] websocket closed")

        async def send_loop() -> None:
            while not close:
                sent = False
                while True:
                    try:
                        pcm_data = output_queue.get(block=False)
                    except queue.Empty:
                        break
                    await ws.send_json(
                        {
                            "type": "audio",
                            "sample_rate": SAMPLE_RATE,
                            "data": float32_to_pcm16_base64(pcm_data),
                        }
                    )
                    sent = True
                while True:
                    try:
                        text = text_queue.get(block=False)
                    except queue.Empty:
                        break
                    await ws.send_json({"type": "text_delta", "text": text})
                    sent = True
                if not sent:
                    await asyncio.sleep(0.005)

        log("info", "[BRIDGE] accepted Codex connection")
        await asyncio.gather(recv_loop(), send_loop())
        return ws

    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_get("/v1/moshi", handle_ws)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()
    log("info", f"[BRIDGE] listening on ws://{args.host}:{args.port}/v1/moshi")
    await asyncio.gather(
        encode_input_loop(),
        decoded_output_loop(),
        encoded_input_loop(),
        model_output_loop(),
    )


def load_lm_config(args: Any) -> Any:
    lm_config = args.lm_config
    if lm_config is None:
        try:
            lm_config = hf_hub_download(args.hf_repo, "config.json")
        except Exception:
            log("warning", "Cannot download config, using defaults.")
    if lm_config is None:
        return models.config_v0_1()
    with open(hf_get(lm_config), "r", encoding="utf-8") as fobj:
        return json.load(fobj)


def parse_args() -> Any:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokenizer", type=str)
    parser.add_argument("--moshi-weight", type=str)
    parser.add_argument("--mimi-weight", type=str)
    parser.add_argument("-q", "--quantized", type=int, choices=[4, 8], default=4)
    parser.add_argument("--steps", default=4000, type=int)
    parser.add_argument("--hf-repo", type=str, default="kyutai/moshika-mlx-q4")
    parser.add_argument("--lm-config", type=str)
    parser.add_argument("--host", default="127.0.0.1", type=str)
    parser.add_argument("--port", default=8999, type=int)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    lm_config = load_lm_config(args)
    client_to_server: multiprocessing.Queue[Any] = multiprocessing.Queue()
    server_to_client: multiprocessing.Queue[Any] = multiprocessing.Queue()
    process = multiprocessing.Process(
        target=model_server,
        args=(client_to_server, server_to_client, lm_config, args),
    )
    process.start()
    try:
        asyncio.run(bridge_server(client_to_server, server_to_client, lm_config, args))
    finally:
        process.terminate()
        process.join(timeout=5)


if __name__ == "__main__":
    if sys.version_info < (3, 10):
        raise SystemExit("Python 3.10+ is required.")
    main()
