const savedTheme = (() => {
  try { return localStorage.getItem("review-theme"); } catch { return null; }
})();
const dark = savedTheme === "dark" || (savedTheme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.classList.toggle("dark", dark);
