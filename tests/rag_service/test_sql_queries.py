from __future__ import annotations


async def test_sql_query_returns_rows_from_registered_table(client, internal_headers):
    response = await client.post(
        "/excel/financial_sample/query/sql",
        headers=internal_headers,
        json={"sql": "SELECT region, sales FROM financial_sample ORDER BY sales DESC"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "row_count": 2,
        "data": [
            {"region": "South", "sales": 150},
            {"region": "North", "sales": 100},
        ],
    }


async def test_sql_query_returns_400_for_invalid_sql(client, internal_headers):
    response = await client.post(
        "/excel/financial_sample/query/sql",
        headers=internal_headers,
        json={"sql": "SELECT * FROM definitely_missing_table"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "SQL query must reference the requested table."


async def test_sql_query_rejects_write_or_multi_statement_sql(client, internal_headers):
    update_response = await client.post(
        "/excel/financial_sample/query/sql",
        headers=internal_headers,
        json={"sql": "UPDATE financial_sample SET sales = 0"},
    )
    multi_response = await client.post(
        "/excel/financial_sample/query/sql",
        headers=internal_headers,
        json={"sql": "SELECT * FROM financial_sample; DROP TABLE financial_sample"},
    )

    assert update_response.status_code == 400
    assert update_response.json()["detail"] == "Only read-only SELECT queries are allowed."
    assert multi_response.status_code == 400
    assert multi_response.json()["detail"] == "Only a single read-only SQL statement is allowed."


async def test_sql_query_must_reference_requested_table(client, internal_headers):
    response = await client.post(
        "/excel/financial_sample/query/sql",
        headers=internal_headers,
        json={"sql": "SELECT 1 AS value"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "SQL query must reference the requested table."


async def test_sql_query_rejects_blank_sql(client, internal_headers):
    response = await client.post(
        "/excel/financial_sample/query/sql",
        headers=internal_headers,
        json={"sql": "   "},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "SQL query is required."
