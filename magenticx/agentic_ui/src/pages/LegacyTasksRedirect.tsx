import { Navigate, useLocation } from "react-router-dom";

import { AUTOMATIONS_PATH } from "@/features/automations/lib/routes";

/**
 * "/tasks" (the old Schedules page) → "/automations", keeping the query string
 * so an old "Schedule it" link (`?agent=`) still opens the form. A `replace`,
 * so Back does not bounce through the old URL. Kept one release for bookmarks
 * and already-open tabs, then removed.
 */
export default function LegacyTasksRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: AUTOMATIONS_PATH, search, hash }} replace />;
}
