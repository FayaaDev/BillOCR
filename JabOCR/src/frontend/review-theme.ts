const savedTheme = (() => {
  try { return localStorage.getItem("review-theme"); } catch { return null; }
})();
const dark = savedTheme !== "light";
document.documentElement.classList.toggle("dark", dark);
