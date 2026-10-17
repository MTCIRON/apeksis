// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Shim: the studio's components import `./ui`, and the single implementation of
// the design system lives in the shell. Re-exporting here keeps the studio's own
// import paths untouched while there is still exactly ONE primitive layer.
export * from "../../shell/ui";
