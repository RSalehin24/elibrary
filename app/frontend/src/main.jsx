import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ProcessingActivityProvider } from "./features/processing/ProcessingActivityProvider";
import { SessionProvider } from "./hooks/useSession";
import { ToastProvider } from "./hooks/useToast";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <SessionProvider>
      <ToastProvider>
        <ProcessingActivityProvider>
          <App />
        </ProcessingActivityProvider>
      </ToastProvider>
    </SessionProvider>
  </BrowserRouter>
);
