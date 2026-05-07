import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import RootErrorBoundary from "./error_boundary";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </BrowserRouter>
);
