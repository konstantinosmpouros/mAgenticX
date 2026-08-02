from __future__ import annotations


async def test_get_user_preferences_defaults_when_no_row_exists(client, seeded_user):
    response = await client.get(f"/v1/preferences/{seeded_user.id}")

    assert response.status_code == 200
    assert response.json() == {
        "tools": {"disabled": []},
        "prefersAgenticChat": False,
        "suggestionsEnabled": True,
        "showMessageTokenUsage": False,
        "searchPastConvs": False,
        "useMemory": True,
        "personality": "default",
        "customInstructions": {
            "enabled": False,
            "nickname": "",
            "occupation": "",
            "traits": "",
            "about": "",
        },
        "voiceModeVoice": "alloy",
        "voiceModeLanguage": "english",
    }


async def test_put_user_preferences_deduplicates_disabled_tools(client, seeded_user):
    response = await client.put(
        f"/v1/preferences/{seeded_user.id}",
        json={
            "tools": {
                "disabled": [
                    {"serverId": "rag", "toolName": "sql_query"},
                    {"serverId": "rag", "toolName": "sql_query"},
                    {"serverId": "rag", "toolName": " schema_lookup "},
                    {"serverId": "rag", "toolName": "schema_lookup"},
                    {"serverId": " ", "toolName": "  "},
                ]
            },
            "prefersAgenticChat": True,
            "suggestionsEnabled": False,
            "voiceModeVoice": "unsupported-realtime-voice",
            "voiceModeLanguage": "unsupported-language",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "tools": {
            "disabled": [
                {"serverId": "rag", "toolName": "sql_query"},
                {"serverId": "rag", "toolName": "schema_lookup"},
            ]
        },
        "prefersAgenticChat": True,
        "suggestionsEnabled": False,
        "showMessageTokenUsage": False,
        "searchPastConvs": False,
        "useMemory": True,
        "personality": "default",
        "customInstructions": {
            "enabled": False,
            "nickname": "",
            "occupation": "",
            "traits": "",
            "about": "",
        },
        "voiceModeVoice": "alloy",
        "voiceModeLanguage": "english",
    }

    follow_up = await client.get(f"/v1/preferences/{seeded_user.id}")
    assert follow_up.status_code == 200
    assert follow_up.json() == response.json()
