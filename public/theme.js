/**
 * Applies the saved colour theme before styles.css is parsed.
 * Keeping this tiny bootstrap in <head> prevents a light flash on dark-theme
 * launches; interactive toggling is handled later by app.js.
 */
(() => {
  const storageKey = "onnxtts.theme";
  let theme = "light";

  // Storage can be unavailable in hardened/private browser contexts.
  try {
    const storedTheme = localStorage.getItem(storageKey);
    if (storedTheme === "light" || storedTheme === "dark") theme = storedTheme;
  } catch {
    // The accessible light theme remains the deterministic fallback.
  }

  // data-theme selects CSS tokens; colorScheme also styles native controls.
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;

  // Match the browser chrome colour to the selected application canvas.
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = theme === "dark" ? "#0e1521" : "#f5f7fb";
})();