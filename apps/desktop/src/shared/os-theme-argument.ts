/**
 * The `webPreferences.additionalArguments` flag main uses to hand the renderer's preload the OS
 * colour scheme at window-creation time. Shared so the writer (`main/windows.ts`) and the reader
 * (`preload/index.ts`) cannot drift; the value is appended, e.g. `--wirebench-os-theme=light`.
 */
export const OS_THEME_ARGUMENT = '--wirebench-os-theme=';
