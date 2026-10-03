from __future__ import annotations


async def test_get_user_preferences_defaults_when_no_row_exists(client, seeded_user):
    response = await client.get(f"/v1/preferences/{seeded_user.id}")

    assert response.status_code == 200
    assert response.json() == {
        "suggestionsEnabled": True,
        "showMessageTokenUsage": False,
        "searchPastConvs": False,
        "useMemory": True,
        "improveModel": False,
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


async def test_put_user_preferences_normalizes_unsupported_voice_and_language(client, seeded_user):
    """Unknown voice/language values fail closed to the defaults, and the saved
    document round-trips. Tool enablement is deliberately absent: it is no longer
    a preference (see migration 0016) — it lives per (user, agent) on the agents
    service, so a preferences PUT can neither enable nor disable a tool.
    `prefersAgenticChat` is absent for the same reason (see migration 0018):
    it was stored and returned but never consumed, so it was retired."""
    response = await client.put(
        f"/v1/preferences/{seeded_user.id}",
        json={
            "suggestionsEnabled": False,
            "voiceModeVoice": "unsupported-realtime-voice",
            "voiceModeLanguage": "unsupported-language",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "suggestionsEnabled": False,
        "showMessageTokenUsage": False,
        "searchPastConvs": False,
        "useMemory": True,
        "improveModel": False,
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


async def test_improve_model_is_opt_in_and_round_trips(client, seeded_user):
    """Silence is never consent: a user who has not chosen reads as "not
    allowed", and only an explicit true is stored as allowed."""
    defaulted = await client.get(f"/v1/preferences/{seeded_user.id}")
    assert defaulted.json()["improveModel"] is False

    opted_in = await client.put(f"/v1/preferences/{seeded_user.id}", json={"improveModel": True})
    assert opted_in.status_code == 200
    assert opted_in.json()["improveModel"] is True
    assert (await client.get(f"/v1/preferences/{seeded_user.id}")).json()["improveModel"] is True

    # A save that omits the field (an older client) resets it to the safe default.
    other_save = await client.put(f"/v1/preferences/{seeded_user.id}", json={"suggestionsEnabled": False})
    assert other_save.json()["improveModel"] is False
