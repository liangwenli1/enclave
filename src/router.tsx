import { createHashHistory, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const desktop = import.meta.env.VITE_ENCLAVE_DIRECT === "true";
  if (!desktop) {
    return createRouter({ routeTree, defaultErrorComponent: AppErrorComponent });
  }
  const history =
    typeof document === "undefined"
      ? createMemoryHistory({ initialEntries: ["/"] })
      : createHashHistory();
  return createRouter({
    routeTree,
    history,
    defaultErrorComponent: AppErrorComponent,
  });
}