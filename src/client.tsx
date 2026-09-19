import { StrictMode, startTransition } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

const desktop = import.meta.env.VITE_ENCLAVE_DIRECT === "true";

startTransition(() => {
  if (desktop) {
    const el = document.getElementById("root");
    if (!el) {
      document.body.textContent = "Enclave: missing #root";
      return;
    }
    createRoot(el).render(
      <StrictMode>
        <StartClient />
      </StrictMode>,
    );
    return;
  }
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
