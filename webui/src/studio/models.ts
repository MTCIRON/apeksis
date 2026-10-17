// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Single model catalog for the whole app.
//
// The original studio app shipped its own copy of this file. The merge plan makes
// `lib/models.ts` the one source, so the workspace re-exports it here and every
// `./models` / `../models` import keeps working unchanged.

export * from "../lib/models";
