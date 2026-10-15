import { createContext, useContext } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import type { AppConfig } from "../config";

export interface MatrixContextValue {
  client: MatrixClient;
  config: AppConfig;
  userId: string;
  deviceId: string;
}

export const MatrixContext = createContext<MatrixContextValue | null>(null);

export function useMatrix(): MatrixContextValue {
  const v = useContext(MatrixContext);
  if (!v) throw new Error("useMatrix outside MatrixContext");
  return v;
}

export function useClient(): MatrixClient {
  return useMatrix().client;
}
