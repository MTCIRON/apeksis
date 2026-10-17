/// <reference lib="webworker" />
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Translation: the transcript's sentences, one at a time, with opus-mt-tc-big-tr-en on the CPU.

import * as ort from "onnxruntime-web/webgpu";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import type { Ort } from "../engine/models";
import { MT_PACK, packFileUrl } from "../models";
import { Translator, type MtConfig, type MtVocab } from "../mt/translator";
import { fetchAll } from "./modelStore";

declare const self: DedicatedWorkerGlobalScope;

export type ToMt = { type: "translate"; jobId: number; sentences: string[] } | { type: "cancel"; jobId: number };

export type FromMt =
  | { type: "download"; jobId: number; loaded: number; total: number }
  | { type: "progress"; jobId: number; done: number; total: number }
  | { type: "done"; jobId: number; texts: string[]; elapsed: number }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

/** Approximate; the real size is settled once the download finishes. */
const ORT_WASM_SIZE = 26_800_000;

const post = (m: FromMt) => self.postMessage(m);
const cancelled = new Set<number>();
let translator: Promise<Translator> | null = null;
let queue: Promise<void> = Promise.resolve();

async function load(jobId: number): Promise<Translator> {
  const res = await fetch(packFileUrl(MT_PACK, MT_PACK.manifest), { cache: "no-cache" });
  if (!res.ok)
    throw new Error(
      `Çeviri paketi kurulu değil (models/${MT_PACK.dir}/, HTTP ${res.status}). Paketi sunucuya kurun.`,
    );
  const cfg: MtConfig = await res.json();
  const [encoder, decoder, spm, wasm] = await fetchAll(
    [
      ...MT_PACK.files.map((f) => ({ url: packFileUrl(MT_PACK, f), size: cfg.files[f] })),
      { url: ortWasmUrl, size: ORT_WASM_SIZE, approx: true },
    ],
    (loaded, total) => post({ type: "download", jobId, loaded, total }),
  );
  ort.env.wasm.wasmBinary = wasm.buffer as ArrayBuffer;
  // See asr.worker.ts: wasm threads load this script, not the worker bundle.
  if (import.meta.env.PROD) ort.env.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, self.location.href) };
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, Math.ceil((navigator.hardwareConcurrency || 2) / 2)))
    : 1;
  ort.env.logLevel = "error";
  const vocab: MtVocab = JSON.parse(new TextDecoder().decode(spm));
  return Translator.create(ort as unknown as Ort, encoder, decoder, vocab, cfg);
}

/** Loaded on first use and kept. */
function getTranslator(jobId: number) {
  if (!translator) {
    translator = load(jobId);
    translator.catch(() => (translator = null));
  }
  return translator;
}

async function translate(jobId: number, sentences: string[]) {
  const started = performance.now();
  const mt = await getTranslator(jobId);
  const texts: string[] = [];
  for (let i = 0; i < sentences.length; i++) {
    if (cancelled.has(jobId)) return post({ type: "cancelled", jobId });
    post({ type: "progress", jobId, done: i, total: sentences.length });
    texts.push(await mt.translate(sentences[i]));
  }
  post({ type: "done", jobId, texts, elapsed: (performance.now() - started) / 1000 });
}

self.onmessage = (ev: MessageEvent<ToMt>) => {
  const m = ev.data;
  if (m.type === "cancel") {
    cancelled.add(m.jobId);
    return;
  }
  // One job at a time: a new one waits for the cancelled one to stop.
  queue = queue.then(() =>
    translate(m.jobId, m.sentences)
      .catch((e) => post({ type: "error", jobId: m.jobId, message: e instanceof Error ? e.message : String(e) }))
      .finally(() => cancelled.delete(m.jobId)),
  );
};
