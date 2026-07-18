import { useLayoutEffect, useState } from "react";

export type Theme = "system" | "light" | "dark" | "midnight";

const STORAGE_KEY = "xiao.appearance.theme";

const readStoredTheme = (): Theme => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "dark" || stored === "light" || stored === "midnight" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
};

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", resolved === "light" ? "#f6f4ee" : resolved === "midnight" ? "#090b0f" : "#0d100e");
    };
    apply();
    media.addEventListener("change", apply);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Keep the selected theme for this session when storage is unavailable.
    }
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  return { theme, setTheme };
}
