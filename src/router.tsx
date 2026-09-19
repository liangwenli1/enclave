import { createHashHistory, createRouter } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const desktop = import.meta.env.VITE_ENCLAVE_DIRECT === "true";
  return createRouter({
    routeTree,
    history: desktop ? createHashHistory() : undefined,
    defaultErrorComponent: AppErrorComponent,
  });
}