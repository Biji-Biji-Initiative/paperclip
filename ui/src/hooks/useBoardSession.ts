import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";

let detachedClient: QueryClient | null = null;
function getDetachedClient(): QueryClient {
  detachedClient ??= new QueryClient();
  return detachedClient;
}

/** Public entry routes must not start board-only reads before a session answers. */
export function useBoardSession(): boolean {
  const contextClient = useContext(QueryClientContext);
  const session = useQuery(
    {
      queryKey: queryKeys.auth.session,
      queryFn: () => authApi.getSession(),
      enabled: contextClient != null,
      retry: false,
    },
    contextClient ?? getDetachedClient(),
  );
  return contextClient != null && session.isSuccess && session.data != null;
}
