import { createRoot } from "react-dom/client";
import { Dashboard } from "./admin-client";
import "./review-original-preview";
import "./review-form";

const root = document.getElementById("root");
if (root) createRoot(root).render(<Dashboard clearCsrf={root.dataset.clearCsrf ?? root.dataset.csrf ?? ""} logoutCsrf={root.dataset.logoutCsrf ?? ""} />);
