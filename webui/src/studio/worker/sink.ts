/// <reference lib="webworker" />
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Where the rendered MP4 goes, so a long video never has to fit in memory.
//
// - A file the user picked (Chrome, Edge): written in place as it is encoded.
// - The browser's private disk (OPFS, everywhere else): written there, then
//   downloaded from disk.
// - Memory: only where neither exists (an http page on the local network).
//
// The first two put the MP4's index at the end (fastStart: false), the way
// cameras write it; keeping it at the front would mean holding every frame.

import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from "mediabunny";

export interface Sink {
  target: Target;
  fastStart: false | "in-memory";
  /** The finished video: a file on disk to download, or null when it was saved where the user picked. */
  finish(): Promise<File | null>;
  /** Marks the output as unwanted before cancelling, so the close that follows throws it away. */
  cancel(): void;
  /** Drops what was written (after a cancel or an error). */
  discard(): Promise<void>;
}

const RENDERS = "render-";

/** Writes straight into the file the user picked; cancelling or failing leaves no half-written file. */
async function picked(handle: FileSystemFileHandle): Promise<Sink> {
  // The save dialog creates the file empty. Empty, it is ours to remove on a cancel;
  // with something in it, the user is replacing a file that abort leaves as it was.
  const placeholder = (await handle.getFile()).size === 0;
  const remove = () => (handle as FileSystemFileHandle & { remove?: () => Promise<void> }).remove?.().catch(() => {});
  const file = await handle.createWritable();
  let dropped = false;
  let committed = false;
  // Chrome writes to a temporary file and moves it in place on close; abort throws it away.
  // mediabunny closes the stream on cancel too, so the close decides which one it is.
  const writable = new WritableStream<StreamTargetChunk>({
    write: (c) => file.write({ type: "write", position: c.position, data: c.data }),
    close: async () => {
      if (dropped) return file.abort().catch(() => {});
      await file.close();
      committed = true;
    },
    abort: () => file.abort(),
  });
  return {
    target: new StreamTarget(writable, { chunked: true }),
    fastStart: false,
    finish: async () => null,
    cancel: () => {
      dropped = true;
    },
    discard: async () => {
      dropped = true;
      if (!committed) await file.abort().catch(() => {});
      // Already committed (an error after the close), or the empty file the dialog made: remove it where the browser allows.
      if (committed || placeholder) await remove();
    },
  };
}

/** Writes to the browser's private disk; the result is a disk-backed File. */
async function privateDisk(): Promise<Sink> {
  const dir = await navigator.storage.getDirectory();
  const name = `${RENDERS}${Date.now()}.mp4`;
  const handle = await dir.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    access.flush();
    access.close();
  };
  const writable = new WritableStream<StreamTargetChunk>({
    write: (c) => void access.write(c.data, { at: c.position }),
    close,
    abort: close,
  });
  return {
    target: new StreamTarget(writable, { chunked: true }),
    fastStart: false,
    finish: async () => {
      close();
      return handle.getFile();
    },
    cancel: () => {},
    discard: async () => {
      close();
      await dir.removeEntry(name).catch(() => {});
    },
  };
}

function memory(): Sink {
  const target = new BufferTarget();
  return {
    target,
    fastStart: "in-memory",
    finish: async () => new File([target.buffer!], "video.mp4", { type: "video/mp4" }),
    cancel: () => {},
    discard: async () => {},
  };
}

/** Earlier renders on the private disk (their download links are gone by now). */
export async function clearRenders() {
  try {
    const dir = await navigator.storage.getDirectory();
    for await (const name of (dir as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys())
      if (name.startsWith(RENDERS)) await dir.removeEntry(name).catch(() => {});
  } catch {
    // No private disk here.
  }
}

/** The picked file when there is one, else the private disk, else memory. */
export async function openSink(handle: FileSystemFileHandle | null): Promise<Sink> {
  if (handle) return picked(handle);
  try {
    return await privateDisk();
  } catch {
    return memory();
  }
}
