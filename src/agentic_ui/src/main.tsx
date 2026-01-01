import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import RootErrorBoundary from "./components/error_handling/RootErrorBoundary";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </BrowserRouter>
);
