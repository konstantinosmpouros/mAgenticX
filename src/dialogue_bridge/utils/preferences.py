from database.schemas import UserPreferences

def dedupe_preferences(prefs: UserPreferences) -> UserPreferences:
    """Normalize and deduplicate preference lists."""
    disabled = []
    seen: set[str] = set()
    for entry in prefs.tools.disabled if prefs and prefs.tools else []:
        server_id = (entry.server_id or "").strip()
        tool_name = (entry.tool_name or "").strip()
        if not tool_name:
            continue
        key = f"{server_id}::{tool_name}"
        if key in seen:
            continue
        seen.add(key)
        disabled.append({"server_id": server_id, "tool_name": tool_name})

    return UserPreferences(tools={"disabled": disabled})
