from __future__ import annotations

from fastapi import HTTPException


async def test_generate_conversation_title_route_returns_model_output(
    client,
    agents_service,
    internal_headers,
    monkeypatch,
):
    async def fake_generate_title(req):
        return agents_service.schemas.ConversationTitle(
            titles=["Quarterly sales review", "Sales by region", "Revenue trend analysis"]
        )

    monkeypatch.setattr(agents_service.router_generation, "generate_title", fake_generate_title)

    response = await client.post(
        "/titles/generate",
        headers=internal_headers,
        json={"user_input": [{"role": "user", "content": "Summarize sales"}]},
    )

    assert response.status_code == 200
    assert response.json() == {
        "titles": ["Quarterly sales review", "Sales by region", "Revenue trend analysis"]
    }


async def test_generate_conversation_title_route_surfaces_failures(
    client,
    agents_service,
    internal_headers,
    monkeypatch,
):
    async def fake_generate_title(req):
        raise HTTPException(status_code=502, detail="Failed to generate title: model error")

    monkeypatch.setattr(agents_service.router_generation, "generate_title", fake_generate_title)

    response = await client.post(
        "/titles/generate",
        headers=internal_headers,
        json={"user_input": [{"role": "user", "content": "Summarize sales"}]},
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "Failed to generate title: model error"
