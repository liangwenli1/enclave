import { StrictMode, startTransition } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { StartClient } from "@tanstack/react-start/client";
import { getRouter } from "./router";

const desktop = import.meta.env.VITE_ENCLAVE_DIRECT === "true";

startTransition(() => {
  if (desktop) {
    const el = document.getElementById("root");
    if (!el) {
      document.body.textContent = "Enclave: missing #root";
      return;
    }
    const router = getRouter();
    const render = () => {
      createRoot(el).render(
        <StrictMode>
          <RouterProvider router={router} />
        </StrictMode>,
      );
    };
    if (typeof router.load === "function") {
      void router.load().then(render).catch((err: unknown) => {
        el.textContent = String(err);
      });
    } else {
      render();
    }
    return;
  }
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
