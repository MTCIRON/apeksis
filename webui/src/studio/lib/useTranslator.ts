// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useCallback, useEffect, useRef, useState } from "react";
import type { Word } from "../engine";
import type { FromMt, ToMt } from "../worker/mt.worker";
import { placeTranslation, sourceKey, splitSentences, type Translation } from "./translation";

export type TranslateState =
  | { status: "idle" }
  | { status: "download"; loaded: number; total: number }
  | { status: "running"; done: number; total: number }
  | { status: "error"; message: string };

/** Translates the transcript into English in its own worker, a sentence at a time. */
export function useTranslator() {
  const worker = useRef<Worker | null>(null);
  const jobId = useRef(0);
  const pending = useRef<{ words: Word[]; onDone: (t: Translation) => void } | null>(null);
  const sentences = useRef<ReturnType<typeof splitSentences>>([]);
  const [state, setState] = useState<TranslateState>({ status: "idle" });

  const ensureWorker = useCallback(() => {
    if (worker.current) return worker.current;
    const w = new Worker(new URL("../worker/mt.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<FromMt>) => {
      const m = ev.data;
      if (m.jobId !== jobId.current) return;
      switch (m.type) {
        case "download":
          setState({ status: "download", loaded: m.loaded, total: m.total });
          break;
        case "progress":
          setState({ status: "running", done: m.done, total: m.total });
          break;
        case "done": {
          const { words, onDone } = pending.current!;
          pending.current = null;
          setState({ status: "idle" });
          onDone({
            lang: "en",
            words: placeTranslation(words, sentences.current, m.texts),
            source: sourceKey(words),
          });
          break;
        }
        case "cancelled":
          setState({ status: "idle" });
          break;
        case "error":
          setState({ status: "error", message: m.message });
          break;
      }
    };
    worker.current = w;
    return w;
  }, []);

  useEffect(() => () => worker.current?.terminate(), []);

  /** `onDone` gets the translation, unless another call or cancel() came first. */
  const translate = useCallback(
    (words: Word[], onDone: (t: Translation) => void) => {
      const w = ensureWorker();
      w.postMessage({ type: "cancel", jobId: jobId.current } satisfies ToMt);
      const id = ++jobId.current;
      pending.current = { words, onDone };
      sentences.current = splitSentences(words);
      setState({ status: "running", done: 0, total: sentences.current.length });
      w.postMessage({ type: "translate", jobId: id, sentences: sentences.current.map((s) => s.text) } satisfies ToMt);
    },
    [ensureWorker],
  );

  const cancel = useCallback(() => {
    worker.current?.postMessage({ type: "cancel", jobId: jobId.current } satisfies ToMt);
    jobId.current++;
    pending.current = null;
    setState({ status: "idle" });
  }, []);

  return { state, translate, cancel };
}
