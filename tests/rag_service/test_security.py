from __future__ import annotations


async def test_internal_routes_require_trusted_proxy_header(client):
    response = await client.get("/excel/financial_sample/schema")

    assert response.status_code == 403
    assert response.json()["detail"] == "Forbidden"


async def test_internal_routes_reject_wrong_proxy_secret(client, rag_service):
    response = await client.get(
        "/excel/financial_sample/schema",
        headers={rag_service.proxy.TRUSTED_PROXY_HEADER_NAME: "wrong-secret"},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Forbidden"
