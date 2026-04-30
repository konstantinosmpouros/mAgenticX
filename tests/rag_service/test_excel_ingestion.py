from __future__ import annotations


async def test_schema_endpoint_returns_registered_columns(client, internal_headers):
    response = await client.get("/excel/financial_sample/schema", headers=internal_headers)

    assert response.status_code == 200
    assert response.json() == [
        {"column": "region", "type": "VARCHAR"},
        {"column": "sales", "type": "BIGINT"},
    ]


async def test_schema_endpoint_rejects_unknown_table(client, internal_headers):
    response = await client.get("/excel/missing/schema", headers=internal_headers)

    assert response.status_code == 404
    assert response.json()["detail"] == "Table not found."
